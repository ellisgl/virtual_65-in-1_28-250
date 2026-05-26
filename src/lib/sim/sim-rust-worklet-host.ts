/**
 * sim-rust-worklet-host.ts — main-thread helper for the audio worklet.
 *
 * Wraps the lifecycle (load .wasm → addModule → instantiate node → init →
 * configure → start/stop) so Board.svelte calls a handful of methods:
 *
 *   const host = new SimRustWorkletHost(audioContext);
 *   await host.connect(outputNode);
 *   await host.configure(wires, controls);
 *   host.onSnapshot = (volts) => { ...update UI... };
 *   host.start();
 *
 * The worklet runs the Rust simulator directly in the audio thread and
 * outputs samples to its connected destination — no separate speaker
 * worklet, no ring buffer, no main-thread postMessage on the audio path.
 * The host helper just handles configuration messages and forwards UI
 * snapshots back from the worklet.
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
 *   postFilter — after the speaker-resonance bandpass (default 2800 Hz, Q=10);
 *                bypassed (== dcBlocked) if `setSpeakerFilter { enabled: false }`
 *   postTanh   — after tanh(x/AUDIO_SCALE), exactly what reaches the AudioContext
 *
 * Compare raw ↔ postFilter to see what the speaker-resonance simulation
 * does to the signal.  Compare postFilter ↔ postTanh to see what tanh
 * saturation adds.  Compare raw ↔ postTanh for total chain effect.
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
 * All fields optional; only provided ones are updated on the worklet.
 */
export interface SpeakerFilterSettings {
    enabled?: boolean;
    f0?:      number;   // center frequency in Hz (default 2800)
    Q?:       number;   // quality factor (default 10)
    gain?:    number;   // post-filter scalar (default 0.15)
}

let cachedModule: WebAssembly.Module | null = null;
let moduleLoadPromise: Promise<WebAssembly.Module> | null = null;

async function loadWasmModule(): Promise<WebAssembly.Module> {
    if (cachedModule) {
        console.log('Returning existing cached module');
        return cachedModule;
    }
    if (moduleLoadPromise) {
        console.log('Returning exiting moduleLoadPromise');
        return moduleLoadPromise;
    }

    moduleLoadPromise = (async () => {
        const resp = await fetch('/audio/sim_wasm_bg.wasm');
        if (!resp.ok) {
            throw new Error(`Failed to load /audio/sim_wasm_bg.wasm (${resp.status}).`);
        }
        const bytes = await resp.arrayBuffer();
        cachedModule = await WebAssembly.compile(bytes);
        console.log('Returning cached module');

        return cachedModule;
    })();

    console.log('Returning moduleLoadPromise');
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
     * Fires once after a `startDiagnosticCapture` call's worth of samples have
     * been recorded.  Single-shot — to take another capture, call
     * `startDiagnosticCapture` again.
     */
    onDiagnosticCapture: ((capture: DiagnosticCapture) => void) | null = null;

    constructor(ctx: AudioContext)  {
        this.ctx = ctx;
    }

    public isReady(): boolean {
        return this.isAlreadyReady;
    }

    /** Set up the worklet module and wait for initialization confirmation */
    async connect(destination: AudioNode): Promise<void> {
        if (this.node) {
            console.log('this.node exists.');
            return;
        }

        // Hard reset matching previous runs
        this.isAlreadyReady = false;
        this.readyPromise = null;
        this.resolveReady = null;

        await this.ctx.audioWorklet.addModule('/audio/sim-worklet-polyfill.js');
        await this.ctx.audioWorklet.addModule('/audio/sim-rust-worklet.js');

        console.log('loading wasm module');
        const wasmModule = await loadWasmModule();
        console.log('creating this.node')
        // this.node = new AudioWorkletNode(this.ctx, 'sim-rust-processor', {
        //     numberOfInputs:  0,
        //     numberOfOutputs: 1,
        //     outputChannelCount: [1],
        // });
        // 🚀 FIX: Feed the compiled module down into the native constructor options
        this.node = new AudioWorkletNode(this.ctx, 'sim-rust-processor', {
            numberOfInputs:  0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
                wasmModule: wasmModule // 👈 Passed synchronously on creation
            }
        });

        // Setup clear communication routers
        console.log('Creating this.node.port.onmessage');
        this.node.port.onmessage = (e) => {
            const msg = e.data;
            if (msg?.type === 'ready') {
                console.log('[host debug] Verified: "ready" message read from port handler!');
                this.handleReadySignal();
            } else {
                this.onMessage(msg);
            }
        };

        console.log('Creating this.node.port.onerror');
        this.node.onprocessorerror = (event) => {
            console.error('🔥 CRITICAL WORKLET GRAPH CRASH ENCOUNTERED:', event);
        };

        // 🚀 FIX: Securely capture the promise returned by wait loop
        console.log('setting blockTrigger');
        const blockTrigger = this.waitForReady();

        console.log('MAIN THREAD: Posting init configuration to worklet...');
        this.node.port.postMessage({ type: 'init', wasmModule, debug: !!(globalThis as any).__simDebug });

        // 🚀 FIX: Await the explicit variable context, ensuring it halts execution here
        console.log('MAIN THREAD: Halting until worklet is verified ready...');
        await blockTrigger;
        console.log('MAIN THREAD: Halting released! Worklet is operational.');

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

    updateControls(controls: ControlState): void {
        if (!this.node || !this.wires.length) return;

        // Dedup: avoid posting if netlist is identical (e.g. redundant
        // effect triggers).
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
     * chain.  Once the requested duration of samples has been recorded by
     * the worklet (next emit() call), `onDiagnosticCapture` will fire with
     * a {@link DiagnosticCapture} payload containing three Float32Arrays
     * for the raw / dcBlocked / postTanh signals.
     *
     * No-op if the worklet isn't connected or running.  Calling again
     * before a previous capture completes silently overwrites the in-
     * flight buffer with a fresh one.
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
     * audio chain.  All fields optional — only provided ones are updated.
     * State is preserved across coefficient changes, so live sweeps don't
     * click.
     *
     * @example
     *   workletHost.setSpeakerFilter({ f0: 2870 });        // try different f0
     *   workletHost.setSpeakerFilter({ Q: 15 });           // try sharper Q
     *   workletHost.setSpeakerFilter({ gain: 0.2 });       // louder
     *   workletHost.setSpeakerFilter({ enabled: false });  // bypass entirely
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
        const wireObjects = wires.map((w) => ({
            fromTerminal: w.fromTerminal, toTerminal: w.toTerminal, id: '', color: '',
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
                console.log('[worklet alive] first process() call:', (msg as any));
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

    public waitForReady(): Promise<void> {
        console.log('[host debug] waitForReady state check:', {
            isAlreadyReady: this.isAlreadyReady,
            hasReadyPromise: !!this.readyPromise,
            hasResolveReady: !!this.resolveReady
        });

        if (this.isAlreadyReady) {
            console.log('waitForReady was already ready!');
            return Promise.resolve();
        }

        if (!this.readyPromise) {
            console.log('waitForReady readyPromise did not exist');
            this.readyPromise = new Promise<void>((resolve, reject) => {
                this.resolveReady = resolve;

                // 5 Second Safety Timeout Loop
                setTimeout(() => {
                    if (!this.isAlreadyReady) {
                        reject(new Error("AudioWorklet 'ready' signal timed out after 5000ms"));
                    }
                }, 5000);
            });
        }

        console.log('returning readyPromise');
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