/**
 * sim-audio-worklet.ts
 * ...
 */

// ── AudioWorkletGlobalScope types ────────────────────────────────────────────
// These globals are only available inside an AudioWorklet module; TypeScript's
// lib.webworker.d.ts doesn't include them, so we declare them here.

declare const sampleRate: number;

declare function registerProcessor(
    name:  string,
    ctor:  { new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor },
): void;

declare abstract class AudioWorkletProcessor {
    readonly port: MessagePort;
    constructor(options?: AudioWorkletNodeOptions);
    abstract process(
        inputs:     Float32Array[][],
        outputs:    Float32Array[][],
        parameters: Record<string, Float32Array>,
    ): boolean;
}

// ─────────────────────────────────────────────────────────────────────────────

import { KIT_COMPONENTS } from '$lib/data/components';
import { buildCircuitTopology } from '$lib/sim/topology';
import { buildSimulationNetlist } from '$lib/sim/netlist';
import { solveDcNetlist } from '$lib/sim/dc';
import {
    compileNetlist,
    initializeTransientState,
    applyStartupKick,
    stepTransientNetlist,
} from '$lib/sim/transient';
import type { CompiledNetlist, SimulationNetlist, TransientState } from '$lib/types';
import type { ControlState, MainToWorker, WorkerToMain, WireSpec } from '$lib/sim/worker-protocol';

// ── Simulation constants ─────────────────────────────────────────────────────

const DT_MIN    = 1e-6;
const DT_MAX    = 0.5e-3;
const DT_INIT   = 10e-6;
const STARTUP_KICK    = 0.005;   // V — initial cap perturbation to break DC equilibrium
const AUDIO_SCALE     = 3;       // V — tanh compression knee
const DC_BLOCK_ALPHA  = 0.9985;  // IIR DC-blocking pole
const SNAPSHOT_FRAMES = 1470;    // emit snapshot every ~33 ms at 44.1 kHz (~30 fps)

// ── AudioWorkletProcessor ────────────────────────────────────────────────────

class SimAudioProcessor extends AudioWorkletProcessor {

    // ── Simulation state ────────────────────────────────────────────────────
    private netlist:  SimulationNetlist | null = null;
    private compiled: CompiledNetlist   | null = null;
    private state:    TransientState    | null = null;
    private adaptiveDt = DT_INIT;
    private wires: WireSpec[] = [];     // kept for updateControls without resending wires

    // ── Speaker lookup (compact indices into state.nodeVolts) ───────────────
    private spkA = -1;   // primary speaker terminal A
    private spkB = -1;   // primary speaker terminal B
    private t1P  = -1;   // T1 primary start (blocking-oscillator fallback)
    private t1C  = -1;   // T1 centre tap

    // ── Audio resampling state ──────────────────────────────────────────────
    private dcEst  = 0;  // running DC estimate (IIR)
    private prevV  = 0;  // speaker voltage at end of previous quantum
    // audioPhase: sim-time offset (seconds) from this quantum's start to the
    // first sample that needs to be emitted.  Carried over between quanta.
    private audioPhase = 0;

    // ── Snapshot timing ─────────────────────────────────────────────────────
    private totalFrames    = 0;
    private snapFrames     = 0;   // frames since last snapshot
    private snapshotPeriod: number;

    // ── Run flag ─────────────────────────────────────────────────────────────
    private running = false;

    // ────────────────────────────────────────────────────────────────────────

    constructor() {
        super();
        // sampleRate is available as a global in AudioWorkletGlobalScope.
        this.snapshotPeriod = Math.round(sampleRate * 0.033) || SNAPSHOT_FRAMES;
        this.port.onmessage = (e) => this.onmessage(e.data as MainToWorker);
    }

    // ── Internal post helper ─────────────────────────────────────────────────

    private post(msg: WorkerToMain): void {
        this.port.postMessage(msg);
    }

    // ── Message handler ──────────────────────────────────────────────────────

    private onmessage(msg: MainToWorker): void {
        switch (msg.type) {
            case 'configure':
                this.configure(msg.wires, msg.controls);
                break;
            case 'updateControls':
                this.updateControls(msg.controls);
                break;
            case 'start':
                this.running = true;
                break;
            case 'stop':
                this.running = false;
                break;
            // 'audioRate' and 'backpressure' are irrelevant: the worklet IS
            // the audio producer and consumer simultaneously.
        }
    }

    // ── Circuit helpers ──────────────────────────────────────────────────────

    private wireObjects() {
        return this.wires.map(w => ({
            fromTerminal: w.fromTerminal,
            toTerminal:   w.toTerminal,
            id: '', color: '',
        }));
    }

    private cacheSpeakerIndices(
        topology: ReturnType<typeof buildCircuitTopology>,
        compiled: CompiledNetlist,
    ): void {
        const ni = compiled.nodeIndex;
        const idx = (t: number): number => {
            const n = topology.terminalToNode[t];
            return typeof n === 'number' ? (ni.get(n) ?? -1) : -1;
        };
        const spk = KIT_COMPONENTS.find(c => c.id === 'SPK1');
        this.spkA = spk && spk.terminals.length >= 2 ? idx(spk.terminals[0]) : -1;
        this.spkB = spk && spk.terminals.length >= 2 ? idx(spk.terminals[1]) : -1;
        this.t1P  = idx(70);
        this.t1C  = idx(71);
    }

    private configure(wires: WireSpec[], controls: ControlState): void {
        const wasRunning  = this.running;
        this.running      = false;   // pause during reconfigure
        this.wires        = wires;

        const topology = buildCircuitTopology(this.wireObjects(), KIT_COMPONENTS);
        const netlist  = buildSimulationNetlist(topology, KIT_COMPONENTS, controls);
        const compiled = compileNetlist(netlist);
        if (!compiled) return;

        const dc = solveDcNetlist(netlist);

        this.netlist  = netlist;
        this.compiled = compiled;
        this.state    = applyStartupKick(
            initializeTransientState(compiled, dc.ok ? dc.nodeVoltages : undefined),
            STARTUP_KICK,
        );
        this.adaptiveDt = DT_INIT;
        this.dcEst      = 0;
        this.prevV      = 0;
        this.audioPhase = 0;

        this.cacheSpeakerIndices(topology, compiled);
        this.running = wasRunning;
    }

    private updateControls(controls: ControlState): void {
        if (!this.wires.length) return;
        const topology = buildCircuitTopology(this.wireObjects(), KIT_COMPONENTS);
        const netlist  = buildSimulationNetlist(topology, KIT_COMPONENTS, controls);
        const compiled = compileNetlist(netlist);
        if (!compiled) return;
        this.netlist  = netlist;
        this.compiled = compiled;
        this.cacheSpeakerIndices(topology, compiled);
        // state is deliberately preserved so continuous knob sweeps don't glitch
    }

    private speakerV(): number {
        const s = this.state!;
        // A compact index of -1 means the node is ground (V = 0).
        if (this.spkA >= 0 || this.spkB >= 0) {
            const va = this.spkA >= 0 ? s.nodeVolts[this.spkA] : 0;
            const vb = this.spkB >= 0 ? s.nodeVolts[this.spkB] : 0;
            const v = va - vb;
            if (Math.abs(v) > 0.001) return v;
        }
        if (this.t1P >= 0 || this.t1C >= 0) {
            const vp = this.t1P >= 0 ? s.nodeVolts[this.t1P] : 0;
            const vc = this.t1C >= 0 ? s.nodeVolts[this.t1C] : 0;
            return (vp - vc) / 10;
        }
        return 0;
    }

    // ── Audio processing ──────────────────────────────────────────────────────
    //
    // Strategy: interleave simulation steps and audio-sample emission so each
    // sample is linearly interpolated between the speaker voltages at the start
    // and end of the solver step that spans it.  This is identical in quality to
    // the old worker-based resampler but now locked to the audio clock.
    //
    //   ── sim time ──▶
    //   |step0|step1|step2| …
    //   s0    s1    s2
    //        ↑   ↑   ↑
    //       a0  a1  a2      (audio samples, interpolated)

    process(
        _inputs:    Float32Array[][],
        outputs:    Float32Array[][],
        _params:    Record<string, Float32Array>,
    ): boolean {
        const outL = outputs[0]?.[0];
        if (!outL) return true;
        const outR   = outputs[0].length > 1 ? outputs[0][1] : null;
        const frames = outL.length; // always 128

        if (!this.running || !this.netlist || !this.compiled || !this.state) {
            outL.fill(0);
            outR?.fill(0);
            return true;
        }

        const period = 1 / sampleRate;           // seconds per audio sample
        let simT     = 0;                         // sim seconds elapsed in this quantum
        let nextT    = this.audioPhase;           // sim-time of next sample to emit
        let prevV    = this.prevV;
        let frame    = 0;

        outer: while (frame < frames) {

            // If the next sample lies at or before the current sim time, emit it.
            if (nextT <= simT + 1e-14) {
                this.dcEst = this.dcEst * DC_BLOCK_ALPHA + prevV * (1 - DC_BLOCK_ALPHA);
                const s = Math.tanh((prevV - this.dcEst) / AUDIO_SCALE);
                outL[frame] = s;
                if (outR) outR[frame] = s;
                frame++;
                nextT += period;
                continue;
            }

            // Advance the simulation toward the next sample.
            const stepDt = Math.max(DT_MIN, Math.min(this.adaptiveDt, nextT - simT));

            const result = stepTransientNetlist(
                this.netlist,
                this.state,
                { dt: stepDt, gear: 2 },
                this.compiled,
            );

            if (!result.ok) {
                // Solver diverged — fill remaining output with silence and stop.
                this.running = false;
                outL.fill(0, frame);
                outR?.fill(0, frame);
                this.post({ type: 'snapshot', nodeVoltages: {} });
                return true;
            }

            this.state = result.state;
            const newV     = this.speakerV();
            const stepStart = simT;
            simT           += stepDt;

            // Emit every audio sample whose sim time falls within this step.
            while (nextT <= simT + 1e-14 && frame < frames) {
                const alpha = stepDt > 1e-15
                    ? Math.min(1, (nextT - stepStart) / stepDt)
                    : 1;
                const spkV = prevV + (newV - prevV) * alpha;
                this.dcEst = this.dcEst * DC_BLOCK_ALPHA + spkV * (1 - DC_BLOCK_ALPHA);
                const s = Math.tanh((spkV - this.dcEst) / AUDIO_SCALE);
                outL[frame] = s;
                if (outR) outR[frame] = s;
                frame++;
                nextT += period;
            }

            prevV = newV;
            if (result.recommendedDt !== undefined) {
                this.adaptiveDt = Math.max(DT_MIN, Math.min(DT_MAX, result.recommendedDt));
            }
        }

        this.prevV      = prevV;
        this.audioPhase = nextT - simT;    // carry-over phase to next quantum

        // Periodic voltage snapshot for the UI (~30 fps).
        this.totalFrames += frames;
        this.snapFrames  += frames;
        if (this.snapFrames >= this.snapshotPeriod && this.compiled && this.state) {
            this.snapFrames = 0;
            const nn = this.compiled.nonGroundNodes;
            const nv = this.state.nodeVolts;
            const nodeVoltages: Record<number, number> = {};
            for (let i = 0; i < nn.length; i++) nodeVoltages[nn[i]] = nv[i];
            this.post({ type: 'snapshot', nodeVoltages });
        }

        return true; // returning false would destroy the processor
    }
}

registerProcessor('sim-audio-processor', SimAudioProcessor);
