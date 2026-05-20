/* eslint-disable */
/**
 * sim-rust-worklet.js — Phase 4 audio worklet that hosts the Rust simulator
 *                       directly in the audio thread.
 *
 * Pipeline (compared to the Phase 3 worker+ring-buffer architecture):
 *
 *   Phase 3:  Web Worker → main thread → speaker-worklet ring buffer → output
 *              ~4 ms tick batches    postMessage   cubic-interpolated readout
 *
 *   Phase 4:  this worklet → output
 *              one quantum (128 samples = ~2.7 ms @ 48 kHz) per process() call
 *              no buffering, no postMessage on the audio path
 *
 * Lifecycle / message protocol (driven from the main thread via .port):
 *
 *   { type: 'init',         wasmModule }    one-time WASM instantiation
 *   { type: 'configure',    netlist, kick } build Simulator, solve DC, start cold
 *   { type: 'updateControls', netlist }     hot-recompile preserving state when possible
 *   { type: 'start' }                       allow process() to advance the sim
 *   { type: 'stop' }                        freeze; output silence
 *
 * Worklet → main thread:
 *
 *   { type: 'ready' }                       sent after init() resolves
 *   { type: 'snapshot', nodeVoltages }      ~30 fps for UI rendering
 *   { type: 'error', error }                catastrophic failure (post + exit gracefully)
 *
 * Worklets cannot fetch.  AudioWorkletGlobalScope omits fetch / XHR / dynamic
 * import for network.  The main thread compiles the .wasm to a WebAssembly.Module
 * and ships it via postMessage (Modules are structured-cloneable), and we
 * pass it to wasm-bindgen's init() which accepts a precompiled module.
 *
 * The wasm-bindgen JS glue must be present as a sibling file (`./sim_wasm.js`).
 * The Rust build.sh copies it into /static/audio/ alongside this worklet.
 */

// ── WASM glue ────────────────────────────────────────────────────────────────
// The static import below evaluates sim_wasm.js eagerly when this module
// loads.  sim_wasm.js's top-level code constructs a TextDecoder() for
// JS↔WASM string marshalling — that fails in AudioWorkletGlobalScope on
// browsers/versions that don't expose TextDecoder/TextEncoder (older Chrome,
// Safari pre-15, some embedded contexts).
//
// Fix: a separate polyfill module (sim-worklet-polyfill.js) is installed
// via addModule() BEFORE this one (see sim-rust-worklet-host.ts).  All
// modules added to the same AudioContext share one WorkletGlobalScope, so
// the polyfill's globalThis.TextDecoder / .TextEncoder assignments are
// visible to this file at the point the import below evaluates.
//
// Dynamic `await import()` would be cleaner (run polyfill code first in
// the same file) but is disallowed in WorkletGlobalScope — hence the
// two-file approach.
// import init, {
//     Simulator as WasmSimulator,
//     Diode as WasmDiode,
//     Transistor as WasmTransistor,
// } from './sim_wasm.js';
import init,  {
    initSync,
    Simulator as WasmSimulator,
    Diode as WasmDiode,
    Transistor as WasmTransistor
} from './sim_wasm.js';

// ── Audio post-processing constants ──────────────────────────────────────────
// These mirror static/audio/speaker-worklet.js so Phase 4 audio sounds
// indistinguishable from Phase 3 audio (modulo the actual simulator output).

const AUDIO_SCALE     = 3;       // tanh knee (V)
const DC_BLOCK_ALPHA  = 0.9985;  // one-pole DC blocker
const FADE_IN_SAMPLES = 256;     // ~6 ms ramp on first connect
// Scale factor for the 'current' audio probe.  SPK1 voice-coil current
// is typically tens of mA; multiply by ~100 (≈ 1/Rvc with kit's 8Ω
// speaker) so the post-tanh amplitude lands in roughly the same range
// as the voltage probe.  Tuned by ear against the voltage probe on a
// metronome circuit.
const SPEAKER_CURRENT_SCALE = 100;

// ── Solver constants ─────────────────────────────────────────────────────────

const DT_MIN    = 1e-6;
const DT_MAX    = 0.5e-3;
const DT_INIT   = 10e-6;

const SNAPSHOT_PERIOD_SEC = 0.033;   // ~30 fps

// WASM is mounted synchronously inside the processor's constructor via
// initSync({ module: precompiledModule }), where the module arrives in
// processorOptions.wasmModule (set by SimRustWorkletHost on AudioWorkletNode
// instantiation).  Previously this used an async init() + postMessage 'init'
// handshake, but that pattern raced with Svelte $effects reacting to the
// host going non-null and triggered a deadlock — synchronous mount avoids
// the handshake entirely.

// ── Netlist → Simulator builder ──────────────────────────────────────────────
//
// Mirrors WasmTransientSimulator.fromNetlist in transient-wasm.ts but lives
// in the worklet so we don't import that TS module (worklets prefer minimal
// imports — they hot-reload differently and have stricter scopes).

function buildSimulator(netlist) {
    if (netlist.groundNodeId === null) return null;
    const sim = new WasmSimulator(netlist.groundNodeId);
    for (const el of netlist.elements) {
        switch (el.type) {
            case 'resistor':
                sim.add_resistor(el.componentId, el.nodes[0], el.nodes[1], el.resistanceOhms);
                break;
            case 'capacitor':
                sim.add_capacitor(el.componentId, el.nodes[0], el.nodes[1],
                    el.capacitanceFarads, el.initialVoltage ?? 0);
                break;
            case 'inductor':
                sim.add_inductor(el.componentId, el.nodes[0], el.nodes[1],
                    el.inductanceHenry, el.saturationCurrentA,
                    el.couplingGroup, el.couplingPolarity);
                break;
            case 'coupling':
                sim.add_coupling(el.componentId, el.couplingGroup, el.k);
                break;
            case 'voltage-source':
                sim.add_voltage_source(el.componentId,
                    el.positiveNode, el.negativeNode, el.voltage);
                break;
            case 'diode': {
                const d = el.bv !== undefined
                    ? WasmDiode.zener(el.is, el.n, el.bv, el.ibv)
                    : WasmDiode.shockley(el.is, el.n);
                sim.add_diode(el.componentId, el.anodeNode, el.cathodeNode, d);
                d.free();
                break;
            }
            case 'transistor': {
                const q = new WasmTransistor(
                    el.polarity === 'npn',
                    el.beta, el.is, el.nf, el.vaf,
                    el.cjeFarads, el.cjcFarads,
                    el.br, el.nr, el.var, el.ikf, el.ikr,
                    el.ise, el.ne, el.isc, el.nc,
                    el.tfSeconds, el.trSeconds,
                );
                sim.add_transistor(el.componentId,
                    el.baseNode, el.collectorNode, el.emitterNode, q);
                q.free();
                break;
            }
            case 'relay':
                sim.add_relay(
                    el.componentId,
                    el.coilPositiveNode, el.coilNegativeNode,
                    el.commonNode, el.normallyClosedNode, el.normallyOpenNode,
                    el.coilResistanceOhms,
                    el.ronOhms, el.roffOhms,
                    el.onCurrent, el.offCurrent,
                );
                break;
            case 'transformer':
                // Same skip-with-warn policy as transient-wasm.ts.  In practice
                // buildSimulationNetlist decomposes transformers into inductors+
                // coupling before this worklet sees them.
                break;
        }
    }
    if (!sim.compile()) {
        sim.free();
        return null;
    }
    return sim;
}

// ── Speaker-voltage extraction ───────────────────────────────────────────────
//
// Same heuristic as sim-worker.ts: try SPK1 first, fall back to the T1
// primary tap (scaled by /10 to approximate the secondary).

function collectTopologyNodeIds(netlist) {
    const ids = new Set();
    for (const el of netlist.elements) {
        switch (el.type) {
            case 'resistor':
            case 'capacitor':
            case 'inductor':
                ids.add(el.nodes[0]); ids.add(el.nodes[1]); break;
            case 'voltage-source':
                ids.add(el.positiveNode); ids.add(el.negativeNode); break;
            case 'transistor':
                ids.add(el.baseNode); ids.add(el.collectorNode); ids.add(el.emitterNode); break;
            case 'diode':
                ids.add(el.anodeNode); ids.add(el.cathodeNode); break;
            case 'relay':
                ids.add(el.coilPositiveNode); ids.add(el.coilNegativeNode);
                ids.add(el.commonNode); ids.add(el.normallyClosedNode); ids.add(el.normallyOpenNode);
                break;
            case 'transformer':
                ids.add(el.primaryNodeA); ids.add(el.primaryNodeB);
                ids.add(el.secondaryNodeA); ids.add(el.secondaryNodeB);
                break;
        }
    }
    if (netlist.groundNodeId !== null) ids.delete(netlist.groundNodeId);
    return ids;
}

// ── The processor itself ─────────────────────────────────────────────────────

class SimRustProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        this.sim = null;
        this.running = false;

        // 1. Wire the port listeners immediately
        this.port.onmessage = (e) => this.onmessage(e.data);

        // 2. Mount WASM synchronously from the precompiled module that
        //    the main thread passed via processorOptions.  Doing this in
        //    the constructor — instead of waiting for a postMessage
        //    'init' handshake — sidesteps a deadlock with Svelte $effects
        //    that fire as soon as the host becomes non-null.
        const precompiledModule = options?.processorOptions?.wasmModule;
        if (precompiledModule) {
            try {
                initSync({ module: precompiledModule });
                this.wasmReady = true;
                this.port.postMessage({ type: 'ready' });
            } catch (err) {
                console.error('[worklet] WASM mount failed in constructor:', err);
                this.port.postMessage({ type: 'error', error: String(err) });
            }
        } else {
            console.error('[worklet] No wasmModule in processorOptions — host setup is wrong');
        }

        this.adaptiveDt = DT_INIT;

        // Speaker-voltage probe targets (topology node IDs, not compact).
        this.speakerTopA = -1;
        this.speakerTopB = -1;
        this.t1PrimaryTop = -1;
        this.t1CenterTop = -1;
        this.knownNodeIds = new Set();
        this.groundNodeId = null;

        // Audio post-processing state.
        this.dcEst = 0;
        this.prevV = 0;
        this.audioPhase = 0;            // sim-time carryover between quanta
        this.fadePos = 0;
        // Snapshot pacing — emit every ~33 ms regardless of quantum size.
        this.snapshotPeriodFrames = Math.max(1, Math.round(sampleRate * SNAPSHOT_PERIOD_SEC));
        this.snapFrames = 0;

        // Audio probe selection.  'voltage' (default, back-compat) reads
        // V across the speaker.  'current' reads the actual coil current
        // through SPK1:Lvc — the physically-correct cone-driving signal.
        this.audioProbe = 'voltage';

        // Boot tone — plays a 440 Hz / 0.3 amplitude sine for ~200 ms when
        // process() first runs after worklet construction.  Lets us
        // verify audio routing from the worklet output to the user's
        // speakers independently of the simulator producing audio.  If
        // you hear a beep when clicking Run, audio output works; if you
        // don't, something downstream of the worklet is silencing it
        // (browser autoplay, tab mute, output-device misroute, etc).
        this.bootToneSamples = Math.round(sampleRate * 0.2);
        this.bootTonePos     = 0;
        this.bootToneFreq    = 440;
    }

    post(msg) {
        this.port.postMessage(msg);
    }

    async onmessage(msg) {
        if (!msg || !msg.type) return;

        try {
            switch (msg.type) {
                case 'configure':
                    // Build a fresh simulator from the incoming netlist.
                    // Wasm is already mounted synchronously in the
                    // constructor via initSync(processorOptions.wasmModule),
                    // so there's no init handshake to wait on here.
                    this.disposeSim();
                    this.sim = buildSimulator(msg.netlist);
                    if (this.sim) {
                        this.sim.solve_dc();
                        this.cacheSpeakerProbes(msg.netlist);
                        this.knownNodeIds = collectTopologyNodeIds(msg.netlist);
                        this.groundNodeId = msg.netlist.groundNodeId;
                        console.log('[worklet] configure: simulator built with',
                            msg.netlist?.elements?.length, 'elements, DC solved');
                    } else {
                        console.warn('[worklet] configure: buildSimulator returned null (empty/invalid netlist)');
                    }
                    if (msg.audioProbe) this.audioProbe = msg.audioProbe;
                    this.adaptiveDt = DT_INIT;
                    this.dcEst = 0;
                    this.prevV = 0;
                    this.audioPhase = 0;
                    this.fadePos = 0;
                    this.didFirstQuantumReport = false;
                    this.errorReported = false;
                    break;

                case 'updateControls': {
                    // State-preserving hot-recompile.  Snapshot transient
                    // state from the running sim, rebuild from the new
                    // netlist (knob/switch values may have changed), then
                    // restore.  Eliminates the audio glitch the old
                    // rebuild-from-scratch approach produced on every
                    // pot sweep frame.
                    if (!this.sim) break;
                    const snap = {
                        nodeVolts:            this.sim.export_node_volts(),
                        prevNodeVolts:        this.sim.export_prev_node_volts(),
                        capVolts:             this.sim.export_cap_volts(),
                        prevCapVolts:         this.sim.export_prev_cap_volts(),
                        inductorCurrents:     this.sim.export_inductor_currents(),
                        prevInductorCurrents: this.sim.export_prev_inductor_currents(),
                        tjCapVolts:           this.sim.export_tj_cap_volts(),
                        relayActive:          this.sim.export_relay_active(),
                        gear2Ready:           this.sim.export_gear2_ready(),
                        prevDt:               this.sim.export_prev_dt(),
                    };
                    const newSim = buildSimulator(msg.netlist);
                    if (!newSim) {
                        // Build failed — keep the old sim running.  Caller
                        // probably needs to re-configure entirely.
                        break;
                    }
                    newSim.import_node_volts(snap.nodeVolts);
                    newSim.import_prev_node_volts(snap.prevNodeVolts);
                    newSim.import_cap_volts(snap.capVolts);
                    newSim.import_prev_cap_volts(snap.prevCapVolts);
                    newSim.import_inductor_currents(snap.inductorCurrents);
                    newSim.import_prev_inductor_currents(snap.prevInductorCurrents);
                    newSim.import_tj_cap_volts(snap.tjCapVolts);
                    newSim.import_relay_active(snap.relayActive);
                    newSim.import_gear2_ready(snap.gear2Ready);
                    newSim.import_prev_dt(snap.prevDt);
                    this.disposeSim();
                    this.sim = newSim;
                    this.cacheSpeakerProbes(msg.netlist);
                    this.knownNodeIds = collectTopologyNodeIds(msg.netlist);
                    this.groundNodeId = msg.netlist.groundNodeId;
                    break;
                }

                case 'audioProbe':
                    this.audioProbe = msg.probe;
                    break;

                case 'start':
                    // Only run if WASM mounted cleanly in the constructor.
                    if (this.wasmReady) this.running = true;
                    break;

                case 'stop':
                    this.running = false;
                    break;
            }
        } catch (err) {
            this.post({ type: 'error', error: String(err && err.stack ? err.stack : err) });
        }
    }

    cacheSpeakerProbes(netlist) {
        // Approximation: SPK1 is two resistor segments (Rvc + Lvc midpoint).
        // The simplest heuristic is to look at the netlist's resistor IDs and
        // find the two SPK1 endpoints.  If the topology builder named them
        // 'SPK1:Rvc' / 'SPK1:Lvc' (kit convention) we read the outer nodes.
        // Failing that, the worker also exports node IDs for the T1 primary
        // (terminal 70) and centre tap (terminal 71) via the message.
        this.speakerTopA = -1; this.speakerTopB = -1;
        this.t1PrimaryTop = -1; this.t1CenterTop = -1;

        let spkRvcOuter = null, spkLvcOuter = null;
        for (const el of netlist.elements) {
            if (el.type === 'resistor' && el.componentId === 'SPK1:Rvc') {
                spkRvcOuter = el.nodes[0];  // outer end of Rvc
            } else if (el.type === 'inductor' && el.componentId === 'SPK1:Lvc') {
                spkLvcOuter = el.nodes[1];  // outer end of Lvc
            }
        }
        if (spkRvcOuter !== null && spkLvcOuter !== null) {
            this.speakerTopA = spkRvcOuter;
            this.speakerTopB = spkLvcOuter;
        }

        // T1 primary/centre — look for the LT700 winding-resistor pattern.
        for (const el of netlist.elements) {
            if (el.type === 'resistor' && el.componentId === 'T1:Rp1') {
                this.t1PrimaryTop = el.nodes[0];   // upstream of Rp1 = primaryStart
            }
            if (el.type === 'inductor' && el.componentId === 'T1:Lp1') {
                this.t1CenterTop = el.nodes[1];    // downstream of Lp1 = primaryCenterTap
            }
        }
    }

    speakerV() {
        if (!this.sim) return 0;
        // Real-NaN-from-sim accounting is separate from the quiet-speaker
        // fall-through to T1.  Previously we conflated the two by using
        // NaN as the "speaker is quiet, try T1" sentinel — but if the
        // speaker is just genuinely silent (DC equilibrium, between
        // oscillator pulses) and no T1 probes exist, that NaN got counted
        // as a sim failure and inflated simNaN by 100 000+ per second.
        // Now we track sim-NaN explicitly via a boolean and use a
        // separate "ok" flag for the T1 fall-through path.
        let v = 0;
        let v_ok = false;            // got a usable speaker reading
        let real_sim_nan = false;     // simulator returned non-finite

        if (this.audioProbe === 'current') {
            const i = this.sim.inductor_current('SPK1:Lvc');
            if (Number.isNaN(i)) {
                real_sim_nan = true;
            } else {
                v = i * SPEAKER_CURRENT_SCALE;
                v_ok = true;
            }
        } else if (this.speakerTopA >= 0 || this.speakerTopB >= 0) {
            const va = this.speakerTopA >= 0 ? this.sim.node_voltage(this.speakerTopA) : 0;
            const vb = this.speakerTopB >= 0 ? this.sim.node_voltage(this.speakerTopB) : 0;
            if (Number.isNaN(va) || Number.isNaN(vb)) {
                real_sim_nan = true;
            } else {
                v = va - vb;
                if (Math.abs(v) > 0.001) v_ok = true;
                // else: speaker is quiet → fall through to T1 below
            }
        }
        if (!v_ok && !real_sim_nan && (this.t1PrimaryTop >= 0 || this.t1CenterTop >= 0)) {
            const vp = this.t1PrimaryTop >= 0 ? this.sim.node_voltage(this.t1PrimaryTop) : 0;
            const vc = this.t1CenterTop  >= 0 ? this.sim.node_voltage(this.t1CenterTop)  : 0;
            if (Number.isNaN(vp) || Number.isNaN(vc)) {
                real_sim_nan = true;
            } else {
                v = (vp - vc) / 10;
                v_ok = true;
            }
        }

        if (real_sim_nan) {
            // Genuine sim NaN — propagating it would poison dcEst → all
            // subsequent audio samples become NaN → browser silences
            // them.  Return 0 so the audio chain stays clean.  Worklet's
            // step-failure path is responsible for DC-reseed recovery.
            this.simNanCount = (this.simNanCount || 0) + 1;
            return 0;
        }
        return v_ok ? v : 0;
    }

    disposeSim() {
        if (this.sim) {
            this.sim.free();
            this.sim = null;
        }
    }

    // ── Audio thread hot path ────────────────────────────────────────────────
    //   1. Advance the simulator until we've covered exactly `frames` audio
    //      samples worth of sim time, interleaving sample emission with sim
    //      steps so audio samples are linearly interpolated within each step.
    //   2. Run each generated sample through DC-block + tanh + cone bandpass
    //      + fade-in (same chain as speaker-worklet.js).
    //   3. Every ~33 ms, post a node-voltage snapshot back for the UI.

    process(_inputs, outputs, _params) {
        try {
            return this._processBody(_inputs, outputs, _params);
        } catch (err) {
            // AudioWorkletProcessor doesn't surface throws — they get
            // swallowed, sometimes paused, sometimes terminate the
            // processor permanently.  Catch here, post the error to the
            // main thread, fill silence, and KEEP RETURNING TRUE so the
            // worklet survives.  Once we've seen one exception, also
            // null out this.sim — wasm panics often leave wasm memory
            // in an inconsistent state, so subsequent sim.* calls would
            // re-panic forever.  Subsequent quanta hit the idle branch
            // and emit silence cleanly until reconfigure.
            if (!this.errorReported) {
                this.errorReported = true;
                this.post({
                    type: 'error',
                    error: 'process() threw: ' + (err && err.stack ? err.stack : String(err)),
                });
                console.error('[worklet] process() threw:', err);
            }
            this.sim = null;
            const out = outputs[0];
            if (out && out.length > 0 && out[0]) {
                for (let c = 0; c < out.length; c++) out[c].fill(0);
            }
            return true;
        }
    }

    _processBody(_inputs, outputs, _params) {
        const out = outputs[0];
        if (!out || out.length === 0) return true;
        const ch0 = out[0];
        if (!ch0) return true;
        const frames = ch0.length;

        // Idle state: silence + return true (returning false destroys the
        // processor, which is permanent).  this.wasmReady is set by the
        // constructor after initSync; this.running is toggled by 'start'/
        // 'stop' messages.
        if (!this.running || !this.sim || !this.wasmReady) {
            ch0.fill(0);
            for (let c = 1; c < out.length; c++) out[c].fill(0);
            return true;
        }

        // Boot tone — for the first ~200ms after process() starts running,
        // emit a 440 Hz / 0.3 amplitude sine wave.  This is an audio-
        // routing probe: if you hear a clean A4 beep when clicking Run,
        // output is wired correctly.  If you don't, the bug is downstream
        // of this worklet's output.  Once bootTonePos exhausts, all
        // subsequent quanta run normal sim audio.
        if (this.bootTonePos < this.bootToneSamples) {
            const omega = 2 * Math.PI * this.bootToneFreq / sampleRate;
            for (let i = 0; i < frames; i++) {
                const s = (this.bootTonePos < this.bootToneSamples)
                    ? 0.3 * Math.sin(omega * this.bootTonePos)
                    : 0;
                ch0[i] = s;
                for (let c = 1; c < out.length; c++) out[c][i] = s;
                this.bootTonePos++;
            }
            return true;
        }

        // One-shot diagnostic + periodic counters.
        if (!this.didFirstQuantumReport) {
            this.didFirstQuantumReport = true;
            this.failuresSinceLog = 0;
            this.framesSinceLog = 0;
            this.spkMinSinceLog =  Infinity;
            this.spkMaxSinceLog = -Infinity;
            this.outMinSinceLog =  Infinity;
            this.outMaxSinceLog = -Infinity;
            this.nanFramesSinceLog = 0;
            this.activeFramesSinceLog = 0;
            this.tickEdgesSinceLog = 0;
            this.lastWasActive = false;
            console.log('[worklet] first quantum:',
                'speakerTopA=', this.speakerTopA,
                'speakerTopB=', this.speakerTopB,
                'audioProbe=', this.audioProbe,
            );
        }
        this.framesSinceLog += frames;
        if (this.framesSinceLog >= sampleRate) {
            const spkPp = this.spkMaxSinceLog - this.spkMinSinceLog;
            const outPp = this.outMaxSinceLog - this.outMinSinceLog;
            const activePct = (this.activeFramesSinceLog / this.framesSinceLog) * 100;
            const tickHz = this.tickEdgesSinceLog * sampleRate / this.framesSinceLog;
            if (Number.isFinite(spkPp) || Number.isFinite(outPp) || activePct > 0) {
                const simNan = this.simNanCount || 0;
                console.log(
                    `[worklet] last 1s: ` +
                    `active=${activePct.toFixed(1)}% events=${this.tickEdgesSinceLog} (≈${tickHz.toFixed(1)}Hz) ` +
                    `simNaN=${simNan} ` +
                    `spk[${this.spkMinSinceLog.toFixed(2)}..${this.spkMaxSinceLog.toFixed(2)}]=${spkPp.toFixed(2)} ` +
                    `out[${this.outMinSinceLog.toFixed(3)}..${this.outMaxSinceLog.toFixed(3)}]=${outPp.toFixed(3)} ` +
                    `dcEst=${this.dcEst.toFixed(3)}`
                );
            }
            this.framesSinceLog = 0;
            this.failuresSinceLog = 0;
            this.nanFramesSinceLog = 0;
            this.activeFramesSinceLog = 0;
            this.tickEdgesSinceLog = 0;
            this.simNanCount = 0;
            this.spkMinSinceLog =  Infinity;
            this.spkMaxSinceLog = -Infinity;
            this.outMinSinceLog =  Infinity;
            this.outMaxSinceLog = -Infinity;
        }

        const period = 1 / sampleRate;
        let simT = 0;
        let nextT = this.audioPhase;
        let prevV = this.prevV;
        let frame = 0;

        // Cache bandpass state in registers.
        const emit = (rawSpkV) => {
            // Track speaker-V swing for the periodic log.
            if (rawSpkV < this.spkMinSinceLog) this.spkMinSinceLog = rawSpkV;
            if (rawSpkV > this.spkMaxSinceLog) this.spkMaxSinceLog = rawSpkV;
            const isActive = Math.abs(rawSpkV) > 0.05;
            if (isActive) {
                this.activeFramesSinceLog++;
                if (!this.lastWasActive) this.tickEdgesSinceLog++;
            }
            this.lastWasActive = isActive;

            // DC blocker.  Belt-and-braces guard: speakerV() already
            // returns 0 for NaN, but if anything slips through and dcEst
            // becomes non-finite, reset it.  Without this guard, a single
            // bad sample silently kills audio for the rest of the
            // session.
            this.dcEst = this.dcEst * DC_BLOCK_ALPHA + rawSpkV * (1 - DC_BLOCK_ALPHA);
            if (!Number.isFinite(this.dcEst)) this.dcEst = 0;
            // Audio chain: DC block → tanh saturator → fade-in.  We
            // deliberately do NOT apply a cone bandpass here.  A bandpass
            // resonates on sustained tones (the siren's 1 kHz fundamental
            // builds up over many cycles) but heavily attenuates single
            // impulses (the metronome's transformer-kick clicks), creating
            // a 16-20x volume disparity between continuous-tone circuits
            // and click-train circuits.  Letting the broad signal through
            // unfiltered + tanh-saturated gives a more uniform perceived
            // loudness across kit projects.  The listener's playback
            // hardware will impose its own frequency response.
            let s = Math.tanh((rawSpkV - this.dcEst) / AUDIO_SCALE);
            // Fade-in on first connect.
            if (this.fadePos < FADE_IN_SAMPLES) {
                s *= this.fadePos / FADE_IN_SAMPLES;
                this.fadePos++;
            }

            // Track output amplitude for the periodic log.  NaN handling:
            // NaN propagates silently in the audio chain (Web Audio treats
            // NaN samples as silence), so count NaN frames separately.
            if (Number.isNaN(s)) {
                this.nanFramesSinceLog++;
            } else {
                if (s < this.outMinSinceLog) this.outMinSinceLog = s;
                if (s > this.outMaxSinceLog) this.outMaxSinceLog = s;
            }

            ch0[frame] = s;
            for (let c = 1; c < out.length; c++) out[c][frame] = s;
            frame++;
        };

        while (frame < frames) {

            // Emit any audio samples that fall at or before current sim time.
            if (nextT <= simT + 1e-14) {
                emit(prevV);
                nextT += period;
                continue;
            }

            // Otherwise, take a sim step targeting the next sample time.
            // On step failure: the Rust simulator returns Err(SingularMatrix)
            // when the MNA matrix can't be factored at the current operating
            // point (transistor at the edge of saturation, relay mid-flap,
            // etc).  The state is preserved on failure — but if we retry
            // from the same state with the same dt, we hit the same
            // singularity forever.  Recovery: solve_dc() finds a fresh
            // valid operating point AND clears gear2_ready inside the sim,
            // so the next step_with_gear(dt, 2) uses BE for one step
            // (BE is more numerically robust at the cost of order).  We
            // lose the brief transient region we were in (audio may have a
            // tiny glitch) but the worklet keeps producing sound.
            const stepDt = Math.max(DT_MIN, Math.min(this.adaptiveDt, nextT - simT));
            const r = this.sim.step_with_gear(stepDt, 2);
            const stepOk = r.ok;
            r.free();
            if (!stepOk) {
                try { this.sim.solve_dc(); } catch (_e) { /* very stuck */ }
                if (this.failuresSinceLog !== undefined) this.failuresSinceLog++;
                emit(prevV);
                nextT += period;
                continue;
            }

            const newV = this.speakerV();
            const stepStart = simT;
            simT += stepDt;

            while (nextT <= simT + 1e-14 && frame < frames) {
                const alpha = stepDt > 1e-15
                    ? Math.min(1, (nextT - stepStart) / stepDt)
                    : 1;
                emit(prevV + (newV - prevV) * alpha);
                nextT += period;
            }
            prevV = newV;
        }

        this.prevV = prevV;
        this.audioPhase = nextT - simT;

        // Snapshot for UI.  Iterate the known node-ID set captured at
        // configure time — node_voltage() returns 0 for unknown IDs which
        // would corrupt the snapshot, so we use the cached set.  Ground
        // is excluded from knownNodeIds (no point asking the simulator
        // about it — it's 0 by definition), but consumers doing V[a] -
        // V[gnd] need the key present, so we add it explicitly.
        this.snapFrames += frames;
        if (this.snapFrames >= this.snapshotPeriodFrames) {
            this.snapFrames = 0;
            const nodeVoltages = {};
            if (this.groundNodeId !== null && this.groundNodeId !== undefined) {
                nodeVoltages[this.groundNodeId] = 0;
            }
            for (const id of this.knownNodeIds) {
                nodeVoltages[id] = this.sim.node_voltage(id);
            }
            this.post({ type: 'snapshot', nodeVoltages });
        }

        return true;
    }
}

registerProcessor('sim-rust-processor', SimRustProcessor);
