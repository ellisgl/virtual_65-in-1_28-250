/**
 * sim-rust-worklet-host.ts — main-thread helper for the audio worklet.
 *
 * Wraps the lifecycle (load .wasm → addModule → instantiate node →
 * configure → start/stop) so Board.svelte only calls a handful of methods:
 *
 *   const host = new SimRustWorkletHost(audioContext);
 *   await host.connect(outputNode);
 *   await host.configure(wires, controls);
 *   host.onSnapshot = (volts) => { ...update UI... };
 *   host.start();
 *
 * The worklet runs the Rust simulator directly on the audio thread and
 * writes samples straight to its connected destination — no ring buffer
 * and no main-thread hop on the audio path.  This host only sends
 * configuration messages and receives UI snapshots / diagnostics back.
 *
 * Debugging: set `globalThis.__simDebug = true` in the console to enable
 * the verbose host + worklet logging.
 */

import type { SimulationNetlist } from '$lib/types';
import { KIT_COMPONENTS } from '$lib/data/components';
import { buildCircuitTopology } from '$lib/sim/topology';
import { buildSimulationNetlist } from '$lib/sim/netlist';

export type NodeVoltages = Record<number, number>;
export type AudioProbe = 'voltage' | 'current';
export interface WireSpec {
    fromTerminal: number;
    toTerminal:   number;
}
export interface ControlState {
    valueOverrides:    Record<string, number>;
    positionOverrides: Record<string, number>;
    switchStates:      Record<string, boolean>;
}

/**
 * Diagnostic capture payload delivered when `startDiagnosticCapture` finishes.
 *
 * The four channels expose the same signal at four points in the worklet's
 * audio chain so you can pinpoint where harmonic content or amplitude
 * artifacts are introduced:
 *
 *   raw        — pure simulator probe value (voltage or current), pre-everything
 *   dcBlocked  — after the 1st-order DC blocker (HPF ~1.5 Hz at 48 kHz)
 *   postFilter — after the speaker-resonance bandpass (default f0=2900 Hz,
 *                Q=1.3, gain=0.3 — and OFF by default); equals dcBlocked
 *                while the filter is disabled
 *   postTanh   — after tanh(x/AUDIO_SCALE), exactly what reaches the
 *                AudioContext
 *
 * Compare raw ↔ postFilter to see what the speaker-resonance simulation
 * does to the signal, postFilter ↔ postTanh for the saturation, and
 * raw ↔ postTanh for the total chain effect.
 */
export interface DiagnosticCapture {
    sampleRate:        number;
    samplesPerChannel: number;
    raw:               Float32Array;
    dcBlocked:         Float32Array;
    postFilter:        Float32Array;
    postTanh:          Float32Array;
}

/**
 * Settings for the speaker-resonance bandpass filter in the audio chain.
 * All fields are optional; only the provided ones are updated.
 * Worklet defaults: enabled=false, f0=2900 Hz, Q=1.3, gain=0.3.
 */
export interface SpeakerFilterSettings {
    enabled?: boolean;
    f0?:      number;   // center frequency, Hz
    Q?:       number;   // quality factor (bandwidth = f0/Q)
    gain?:    number;   // post-filter scalar applied to the BPF output
}

// The WASM binary is compiled once per page and shared across all host
// instances / reconnects.  Concurrent first-callers share the in-flight
// promise so the binary is only fetched and compiled once.
let cachedModule: WebAssembly.Module | null = null;
let moduleLoadPromise: Promise<WebAssembly.Module> | null = null;

async function loadWasmModule(): Promise<WebAssembly.Module> {
    if (cachedModule) return cachedModule;
    if (moduleLoadPromise) return moduleLoadPromise;

    moduleLoadPromise = (async () => {
        const resp = await fetch('/audio/sim_wasm_bg.wasm');
        if (!resp.ok) {
            throw new Error(`Failed to load /audio/sim_wasm_bg.wasm (${resp.status}).`);
        }
        const bytes = await resp.arrayBuffer();
        cachedModule = await WebAssembly.compile(bytes);
        return cachedModule;
    })();

    return moduleLoadPromise;
}

export class SimRustWorkletHost {
    private ctx: AudioContext;
    private node: AudioWorkletNode | null = null;
    private wires: WireSpec[] = [];
    private isAlreadyReady = false;
    private readyPromise: Promise<void> | null = null;
    private resolveReady: (() => void) | null = null;
    private lastNetlistJson: string | null = null;

    onSnapshot: ((volts: NodeVoltages) => void) | null = null;
    onError:    ((msg: string) => void) | null = null;
    /**
     * Fires once after a `startDiagnosticCapture` call's worth of samples
     * has been recorded.  Single-shot — call `startDiagnosticCapture`
     * again for another capture.
     */
    onDiagnosticCapture: ((capture: DiagnosticCapture) => void) | null = null;

    constructor(ctx: AudioContext)  {
        this.ctx = ctx;
    }

    public isReady(): boolean {
        return this.isAlreadyReady;
    }

    /**
     * Load both worklet modules, create the AudioWorkletNode, and wait for
     * the worklet's 'ready' reply.  Safe to call again after dispose();
     * a second call while already connected is a no-op.
     */
    async connect(destination: AudioNode): Promise<void> {
        if (this.node) return;

        // Reset readiness from any previous connect/dispose cycle.
        this.isAlreadyReady = false;
        this.readyPromise = null;
        this.resolveReady = null;

        // The polyfill module must be added first: all modules of an
        // AudioContext share one WorkletGlobalScope, and the polyfill
        // provides TextDecoder/TextEncoder that the wasm-bindgen glue in
        // sim-rust-worklet.js needs at module-evaluation time.
        await this.ctx.audioWorklet.addModule('/audio/sim-worklet-polyfill.js');
        await this.ctx.audioWorklet.addModule('/audio/sim-rust-worklet.js');

        // The compiled WASM module is passed in processorOptions so the
        // processor can mount it *synchronously* in its constructor
        // (initSync).  An earlier async init()-then-postMessage handshake
        // raced with Svelte $effects firing as soon as the host became
        // non-null, and could deadlock the first run.
        const wasmModule = await loadWasmModule();
        this.node = new AudioWorkletNode(this.ctx, 'sim-rust-processor', {
            numberOfInputs:  0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: { wasmModule }
        });

        this.node.port.onmessage = (e) => {
            const msg = e.data;
            if (msg?.type === 'ready') {
                this.handleReadySignal();
            } else {
                this.onMessage(msg);
            }
        };

        this.node.onprocessorerror = (event) => {
            console.error('[sim-rust-worklet] processor crashed:', event);
        };

        // Subscribe to readiness BEFORE posting 'init' so the worklet's
        // 'ready' reply can't slip past us.  The init message itself is
        // only a handshake trigger now — WASM is already mounted via
        // processorOptions above.
        const ready = this.waitForReady();
        this.node.port.postMessage({ type: 'init', wasmModule, debug: !!(globalThis as any).__simDebug });
        await ready;

        this.node.connect(destination);
    }

    async configure(
        wires: WireSpec[],
        controls: ControlState,
        audioProbe: AudioProbe = 'voltage',
    ): Promise<void> {
        if (!this.node) throw new Error('configure() before connect()');

        await this.waitForReady();

        this.wires = wires;
        const netlist = this.buildNetlist(wires, controls);
        this.lastNetlistJson = JSON.stringify(netlist);
        this.node.port.postMessage({ type: 'configure', netlist, audioProbe, debug: !!(globalThis as any).__simDebug });
    }

    /**
     * Push new control values (pot position, switch states, light level…)
     * into a running sim.  The worklet hot-recompiles the netlist while
     * preserving transient state where it can, so the audio doesn't restart.
     */
    updateControls(controls: ControlState): void {
        if (!this.node || !this.wires.length) return;

        // Skip the post if nothing changed — Svelte $effects can re-fire
        // with identical values.
        const netlist = this.buildNetlist(this.wires, controls);
        const netlistJson = JSON.stringify(netlist);
        if (netlistJson === this.lastNetlistJson) return;
        this.lastNetlistJson = netlistJson;

        this.node.port.postMessage({ type: 'updateControls', netlist });
    }

    ping(): void {
        this.node?.port.postMessage({ type: 'ping' });
    }

    setAudioProbe(probe: AudioProbe): void {
        this.node?.port.postMessage({ type: 'audioProbe', probe });
    }

    /**
     * Trigger a one-shot diagnostic capture of the worklet's internal audio
     * chain.  Once the requested duration has been recorded,
     * `onDiagnosticCapture` fires with a {@link DiagnosticCapture} holding
     * four Float32Arrays (raw / dcBlocked / postFilter / postTanh).
     *
     * No-op if the worklet isn't connected.  Calling again before a capture
     * completes restarts it with a fresh buffer.
     */
    startDiagnosticCapture(seconds: number = 1.0): void {
        if (!this.node) {
            console.warn('[host] startDiagnosticCapture: worklet not connected');
            return;
        }
        this.node.port.postMessage({ type: 'startDiagnosticCapture', seconds });
    }

    /**
     * Live-tune (or disable) the speaker-resonance bandpass in the worklet's
     * audio chain.  Only the provided fields are updated, and filter state
     * is preserved across coefficient changes so live sweeps don't click.
     *
     * @example
     *   workletHost.setSpeakerFilter({ f0: 2870 });        // shift center
     *   workletHost.setSpeakerFilter({ Q: 15 });           // sharper peak
     *   workletHost.setSpeakerFilter({ gain: 0.2 });       // louder
     *   workletHost.setSpeakerFilter({ enabled: false });  // bypass
     */
    setSpeakerFilter(settings: SpeakerFilterSettings): void {
        if (!this.node) {
            console.warn('[host] setSpeakerFilter: worklet not connected');
            return;
        }
        this.node.port.postMessage({ type: 'setSpeakerFilter', ...settings });
    }

    start(): void {
        if ((globalThis as any).__simDebug) console.trace('[host] start() called');
        this.node?.port.postMessage({ type: 'start', debug: !!(globalThis as any).__simDebug });
    }
    stop():  void {
        if ((globalThis as any).__simDebug) console.trace('[host] stop() called');
        this.node?.port.postMessage({ type: 'stop'  });
    }

    dispose(): void {
        if (this.node) {
            try { this.node.disconnect(); } catch {}
            this.node.port.onmessage = null;
            this.node = null;
        }
        this.isAlreadyReady = false;
        this.readyPromise = null;
        this.resolveReady = null;
    }

    // ── Internal ────────────────────────────────────────────────────────────

    private buildNetlist(wires: WireSpec[], controls: ControlState): SimulationNetlist {
        // Stub out the cosmetic Wire fields — topology building only reads
        // the terminal numbers (id/color/lengthCm exist for rendering).
        const wireObjects = wires.map((w) => ({
            fromTerminal: w.fromTerminal, toTerminal: w.toTerminal,
            id: '', color: '', lengthCm: 0,
        }));
        const topology = buildCircuitTopology(wireObjects, KIT_COMPONENTS);
        return buildSimulationNetlist(topology, KIT_COMPONENTS, controls);
    }

    private onMessage(msg: {
        type?: string;
        nodeVoltages?: NodeVoltages;
        error?: string;
        state?: any;
        sampleRate?: number;
        samplesPerChannel?: number;
        raw?: Float32Array;
        dcBlocked?: Float32Array;
        postFilter?: Float32Array;
        postTanh?: Float32Array;
        total?: number;
        enabled?: boolean;
        f0?: number;
        Q?: number;
        gain?: number;
    }): void {
        if (!msg || !msg.type) return;
        switch (msg.type) {
            case 'snapshot':
                this.onSnapshot?.(msg.nodeVoltages ?? {});
                break;
            case 'debug':
                if ((globalThis as any).__simDebug) console.log('[worklet debug]:', msg.state);
                break;
            case 'alive':
                if ((globalThis as any).__simDebug) {
                    console.log('[worklet alive] first process() call:', (msg as any));
                }
                break;
            case 'error':
                console.error('[sim-rust-worklet] error:', msg.error);
                this.onError?.(String(msg.error));
                break;
            case 'diagnosticCaptureStarted':
                if ((globalThis as any).__simDebug) {
                    console.log('[host] diagnostic capture armed —',
                                msg.total, 'samples coming @ ' + msg.sampleRate + ' Hz');
                }
                break;
            case 'diagnosticCapture':
                if (!msg.raw || !msg.dcBlocked || !msg.postFilter || !msg.postTanh) {
                    console.warn('[host] diagnosticCapture missing channel data');
                    break;
                }
                this.onDiagnosticCapture?.({
                    sampleRate:        msg.sampleRate ?? 48000,
                    samplesPerChannel: msg.samplesPerChannel ?? msg.raw.length,
                    raw:               msg.raw,
                    dcBlocked:         msg.dcBlocked,
                    postFilter:        msg.postFilter,
                    postTanh:          msg.postTanh,
                });
                break;
            case 'speakerFilterUpdated':
                if ((globalThis as any).__simDebug) {
                    console.log(`[host] speaker filter:`,
                                msg.enabled ? `f0=${msg.f0}Hz Q=${msg.Q} gain=${msg.gain}` : 'disabled');
                }
                break;
        }
    }

    /**
     * Resolves once the worklet has reported 'ready'.  Rejects after 5 s if
     * it never does, so callers don't hang forever on a broken worklet (the
     * late reject is harmless once the promise has already resolved).
     */
    public waitForReady(): Promise<void> {
        if (this.isAlreadyReady) return Promise.resolve();

        if (!this.readyPromise) {
            this.readyPromise = new Promise<void>((resolve, reject) => {
                this.resolveReady = resolve;
                setTimeout(() => {
                    if (!this.isAlreadyReady) {
                        reject(new Error("AudioWorklet 'ready' signal timed out after 5000ms"));
                    }
                }, 5000);
            });
        }

        return this.readyPromise;
    }

    private handleReadySignal() {
        this.isAlreadyReady = true;
        if (this.resolveReady) {
            this.resolveReady();
            this.resolveReady = null;
        }
    }
}
