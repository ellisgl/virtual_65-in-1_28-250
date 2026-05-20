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

    onSnapshot: ((volts: NodeVoltages) => void) | null = null;
    onError:    ((msg: string) => void) | null = null;

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
        this.node.port.postMessage({ type: 'init', wasmModule });

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
        const wasmModule = await loadWasmModule();
        console.log('[host] posting configure to worklet, elements:', netlist.elements.length);
        this.node.port.postMessage({ type: 'configure', netlist, wasmModule, audioProbe });
    }

    updateControls(controls: ControlState): void {
        if (!this.node || !this.wires.length) return;
        const netlist = this.buildNetlist(this.wires, controls);
        this.node.port.postMessage({ type: 'updateControls', netlist });
    }

    setAudioProbe(probe: AudioProbe): void {
        this.node?.port.postMessage({ type: 'audioProbe', probe });
    }

    start(): void { this.node?.port.postMessage({ type: 'start' }); }
    stop():  void { this.node?.port.postMessage({ type: 'stop'  }); }

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

    private onMessage(msg: { type?: string; nodeVoltages?: NodeVoltages; error?: string; state?: any }): void {
        if (!msg || !msg.type) return;
        switch (msg.type) {
            case 'snapshot':
                this.onSnapshot?.(msg.nodeVoltages ?? {});
                break;
            case 'debug':
                console.log('[worklet debug]:', msg.state);
                break;
            case 'error':
                console.error('[sim-rust-worklet] error:', msg.error);
                this.onError?.(String(msg.error));
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