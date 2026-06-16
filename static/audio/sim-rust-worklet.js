/* eslint-disable */
/**
 * sim-rust-worklet.js — audio worklet that hosts the Rust circuit simulator
 *                       directly on the audio thread.
 *
 * Each process() call steps the simulator far enough to fill one render
 * quantum (128 samples ≈ 2.7 ms @ 48 kHz) and writes the speaker signal
 * straight to the output — no ring buffer and no postMessage on the audio
 * path.  (An earlier architecture ran the sim in a Web Worker and shipped
 * batches through a ring-buffer worklet; this design replaced it.)
 *
 * Message protocol, main thread → worklet (via .port):
 *
 *   { type: 'init', wasmModule }            ready-handshake (WASM itself is
 *                                           mounted in the constructor — see
 *                                           the note above the class)
 *   { type: 'configure', netlist, audioProbe } build simulator, solve DC
 *   { type: 'updateControls', netlist }     hot-recompile, preserving
 *                                           transient state when possible
 *   { type: 'audioProbe', probe }           'voltage' | 'current'
 *   { type: 'setSpeakerFilter', ... }       tune/enable the resonance BPF
 *   { type: 'startDiagnosticCapture', seconds } arm a 4-channel capture
 *   { type: 'ping' }                        keep-alive (Chrome throttling)
 *   { type: 'start' } / { type: 'stop' }    let process() advance / freeze
 *
 * Worklet → main thread:
 *
 *   { type: 'ready' }                       init handshake reply
 *   { type: 'snapshot', nodeVoltages }      ~30 fps for UI rendering
 *   { type: 'alive' }                       once, on the first process() call
 *   { type: 'debug', state }                verbose state (debug mode only)
 *   { type: 'error', error }                catastrophic failure
 *   { type: 'diagnosticCaptureStarted' } / { type: 'diagnosticCapture', ... }
 *   { type: 'speakerFilterUpdated', ... }   echo of applied filter settings
 *
 * Worklets cannot fetch.  AudioWorkletGlobalScope omits fetch / XHR / dynamic
 * import, so the main thread compiles the .wasm to a WebAssembly.Module and
 * hands it over in processorOptions (Modules are structured-cloneable).
 *
 * The wasm-bindgen JS glue must be present as a sibling file (`./sim_wasm.js`);
 * build-wasm.sh copies it into /static/audio/ alongside this worklet.
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
import init,  {
    initSync,
    Simulator as WasmSimulator,
    Diode as WasmDiode,
    Transistor as WasmTransistor
} from './sim_wasm.js';

// ── Audio post-processing constants ──────────────────────────────────────────
// The emit chain per sample is:  probe → DC block → [resonance BPF] → tanh.

const AUDIO_SCALE     = 16;      // tanh knee (V) — higher = softer "rounded"
                                 // clipping. At 3 the spike train slammed the
                                 // tanh into hard saturation (~22% of samples
                                 // flat-topped → harsh).  16 keeps the spikes
                                 // in tanh's soft knee so the peaks round
                                 // instead of clip flat, full bandwidth (no
                                 // low-pass, edges/brightness preserved).
                                 // Tradeoff: ~4.6 dB quieter than 3.
const DC_BLOCK_R      = 0.995;   // DC-blocker coefficient (HPF ~1.5 Hz @ 48 kHz)
const FADE_IN_SAMPLES = 256;     // ~6 ms ramp on first connect
// Scale factor for the 'current' audio probe.  SPK1 voice-coil current
// is typically tens of mA; multiply by ~100 (≈ 1/Rvc with kit's 8Ω
// speaker) so the post-tanh amplitude lands in roughly the same range
// as the voltage probe.  Tuned by ear against the voltage probe on a
// metronome circuit.
const SPEAKER_CURRENT_SCALE = 100;

// ── Speaker mechanical-resonance bandpass ────────────────────────────────────
// Real small speakers have a strong mechanical resonance that turns the
// spike-train output of the BJT regenerative oscillator into a continuous
// tone near the cone's natural frequency.  Our SPK1 model is purely
// electrical (Rvc + Lvc), so spikes pass through verbatim and can sound
// "zippery" / clicky at the spike rate.
//
// This biquad bandpass (Audio EQ Cookbook, "BPF constant 0 dB peak gain")
// sits between the DC blocker and the tanh saturator to approximate the
// cone's response.  OFF by default: it recolors the signal toward f0,
// which suits siren/tone circuits (P18, P45) but would wrongly color
// e.g. the metronome's sharp ticks.  Board.svelte exposes the toggle;
// everything is runtime-adjustable via the 'setSpeakerFilter' message.
//
//   f0   center frequency (Hz); 2900 matches the real kit speaker's
//        measured resonance.
//   Q    quality factor (ringing time ≈ Q / (π·f0)).  Deliberately broad
//        (1.3): a sharp Q pins any swept tone to f0, flattening the
//        siren's pitch sweep — broad keeps the sweep audible at the cost
//        of weaker spike smoothing.
//   gain post-filter scalar — keeps the BPF's output in the tanh's soft
//        region.  Lower = cleaner, higher = more saturation harmonics.
//
const SPEAKER_FILTER_DEFAULTS = Object.freeze({
    enabled: false,
    f0: 2900,
    Q:  1.3,
    gain: 0.3,
});

// ── Solver constants ─────────────────────────────────────────────────────────
// Adaptive timestep bounds: process() grows dt (×1.2) while Newton converges
// quickly and shrinks it (×0.5) when iterations climb; failures retry at
// DT_MIN with backward Euler.  20 µs max keeps ≥2 sim steps per 48 kHz
// audio sample.

const DT_MIN    = 1e-6;
const DT_MAX    = 20e-6;
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
        this.wasmReady = false;

        // Diagnostics
        this.configureCount = 0;
        this.lastConfigureStatus = 'none';
        this.lastError = null;

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
        this.dcPrevIn  = 0;
        this.dcPrevOut = 0;
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

        // ── Diagnostic raw-waveform capture ───────────────────────────────
        // Triggered by { type: 'startDiagnosticCapture', seconds } message.
        // While active, records four parallel streams per audio sample:
        //   raw:        simulator probe value, pre-DC-block, pre-everything
        //   dcBlocked:  after DC blocker, pre-filter
        //   postFilter: after speaker-resonance BPF, pre-tanh
        //   postTanh:   after tanh saturator (what AudioContext receives)
        // When the buffer fills, posts a 'diagnosticCapture' message back to
        // the host and clears itself.  Capture is fire-and-forget — no
        // overlapping captures supported.
        this.diagCapture = null;

        // ── Speaker mechanical-resonance BPF state ────────────────────────
        this.speakerFilter = {
            enabled: SPEAKER_FILTER_DEFAULTS.enabled,
            f0:      SPEAKER_FILTER_DEFAULTS.f0,
            Q:       SPEAKER_FILTER_DEFAULTS.Q,
            gain:    SPEAKER_FILTER_DEFAULTS.gain,
            // biquad coefficients (computed from f0, Q, sampleRate)
            b0: 0, b1: 0, b2: 0, a1: 0, a2: 0,
            // biquad state — Direct Form I:
            //   y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
            x1: 0, x2: 0, y1: 0, y2: 0,
        };
        this._recomputeSpeakerFilterCoeffs();

        // ── Relay click voice ────────────────────────────────────────────
        // A relay buzzer's sound IS its own contacts — there's no speaker in
        // the circuit, so we synthesize the mechanical click here, at sample
        // rate, and mix it into the output.  Watching relay-active edges in
        // the step loop catches the true (kHz-range) self-interrupt rate that
        // the ~30 fps UI snapshot path aliases away.
        //
        // Each edge retriggers a short voice = noise snap (fast decay) + a
        // damped body resonance.  Energize is brighter/louder than release.
        // `relayClick.env` counts down samples; <=0 means silent.
        this.relayActivePrev = null;       // last-seen relay-active byte (null until first read)
        this.relayClick = {
            env: 0,            // remaining samples in the current click
            len: 0,            // total length of the current click (samples)
            phase: 0,          // body-resonance phase accumulator (radians)
            omega: 0,          // body-resonance angular step (rad/sample)
            snapTau: 0,        // noise-decay time constant (samples)
            bodyTau: 0,        // body-decay time constant (samples)
            level: 0,          // peak amplitude of this click
        };
    }

    /**
     * Retrigger the relay-click voice for an energize (true) or release
     * (false) transition.  Parameters mirror the JS-side relay-click.ts so
     * the buzzer and single UI clicks sound like the same relay.
     */
    _triggerRelayClick(energized) {
        const sr = sampleRate;
        const c = this.relayClick;
        c.len     = Math.floor(0.02 * sr);             // 20 ms voice
        c.env     = c.len;
        c.phase   = 0;
        c.omega   = 2 * Math.PI * (energized ? 1900 : 1250) / sr;
        c.snapTau = (energized ? 0.0018 : 0.0024) * sr;
        c.bodyTau = (energized ? 0.006  : 0.007 ) * sr;
        c.level   = energized ? 0.30 : 0.18;
    }

    /**
     * One sample of the relay-click voice, or 0 when idle.  Advances state.
     */
    _relayClickSample() {
        const c = this.relayClick;
        if (c.env <= 0) return 0;
        const age = c.len - c.env;                     // samples since trigger
        const snap = (Math.random() * 2 - 1) * Math.exp(-age / c.snapTau);
        const body = 0.6 * Math.sin(c.phase) * Math.exp(-age / c.bodyTau);
        c.phase += c.omega;
        c.env--;
        return (snap + body) * c.level;
    }

    /**
     * Recompute the BPF biquad coefficients from current f0/Q/sampleRate
     * using the Audio EQ Cookbook's "BPF (constant 0 dB peak gain)" form.
     * Call after any change to f0 or Q.  State variables are NOT reset —
     * the filter retains its memory across coefficient updates so live
     * tuning doesn't produce clicks.
     */
    _recomputeSpeakerFilterCoeffs() {
        const sf = this.speakerFilter;
        const w0    = (2 * Math.PI * sf.f0) / sampleRate;
        const cos_w = Math.cos(w0);
        const sin_w = Math.sin(w0);
        const alpha = sin_w / (2 * Math.max(0.1, sf.Q));   // clamp Q to avoid divide-by-zero
        const a0    = 1 + alpha;
        sf.b0 =  alpha       / a0;
        sf.b1 =  0;
        sf.b2 = -alpha       / a0;
        sf.a1 = (-2 * cos_w) / a0;
        sf.a2 = (1 - alpha)  / a0;
    }

    /**
     * Reset only the biquad's IIR state.  Use when restarting the sim from
     * scratch so leftover ringing from the previous run doesn't bleed in.
     */
    _resetSpeakerFilterState() {
        const sf = this.speakerFilter;
        sf.x1 = 0; sf.x2 = 0; sf.y1 = 0; sf.y2 = 0;
    }

    post(msg) {
        this.port.postMessage(msg);
    }

    async onmessage(msg) {
        if (!msg || !msg.type) return;

        // Allow the host to enable diagnostic logging inside this
        // AudioWorkletGlobalScope (which is a separate JS realm from the
        // main thread, so setting globalThis.__simDebug in DevTools has
        // no effect here).
        if (typeof msg.debug === 'boolean') globalThis.__simDebug = msg.debug;

        try {
            switch (msg.type) {
                case 'init':
                    console.log(`[${new Date().toISOString()}] [worklet] init received (running: ${this.running})`);
                    this.wasmReady = true;
                    // DO NOT set this.running = false here!  It races with
                    // the host's start() call during first connect.
                    this.port.postMessage({ type: 'ready' });
                    break;

                case 'configure':
                    this.configureCount++;
                    try {
                        // Build a fresh simulator from the incoming netlist.
                        // Wasm is already mounted synchronously in the
                        // constructor via initSync(processorOptions.wasmModule),
                        // so there's no init handshake to wait on here.
                        this.disposeSim();
                        this.sim = buildSimulator(msg.netlist);
                        this.elementCount = msg.netlist?.elements?.length || 0;
                        if (this.sim) {
                            const dcOk = this.sim.solve_dc();
                            this.cacheSpeakerProbes(msg.netlist);
                            this.knownNodeIds = collectTopologyNodeIds(msg.netlist);
                            this.groundNodeId = msg.netlist.groundNodeId;
                            this.lastConfigureStatus = 'success';
                            console.log('[worklet] configure: simulator built with',
                                msg.netlist?.elements?.length, 'elements, DC',
                                dcOk ? 'converged' : 'DID NOT CONVERGE (transient runs from partial state)');
                        } else {
                            this.lastConfigureStatus = 'failed_null_sim';
                            console.warn('[worklet] configure: buildSimulator returned null (empty/invalid netlist)');
                        }
                    } catch (e) {
                        this.lastConfigureStatus = 'failed_exception';
                        this.lastError = String(e && e.stack ? e.stack : e);
                        throw e;
                    }
                    if (msg.audioProbe) this.audioProbe = msg.audioProbe;
                    this.adaptiveDt = DT_INIT;
                    this.dcPrevIn  = 0;
                    this.dcPrevOut = 0;
                    this.prevV = 0;
                    this.audioPhase = 0;
                    this.fadePos = 0;
                    this.relayActivePrev = null;
                    this.relayClick.env = 0;
                    this._resetSpeakerFilterState();
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
                    if (!this.sim) {
                        console.log('[worklet] updateControls: no sim exists, falling back to full configure');
                        this.onmessage({ type: 'configure', netlist: msg.netlist });
                        break;
                    }

                    // Performance Optimization: If the number of elements hasn't
                    // changed, attempt an incremental update via the WASM
                    // Simulator's native update methods. This avoids the
                    // heavy structured-clone of the state vectors and the
                    // cost of full LU pattern re-analysis.
                    const isIncremental = msg.netlist && msg.netlist.elements &&
                                          msg.netlist.elements.length === (this.elementCount || 0);

                    if (isIncremental) {
                        let ok = true;
                        for (const el of msg.netlist.elements) {
                            if (el.type === 'resistor') {
                                if (!this.sim.update_resistor(el.componentId, el.resistanceOhms)) {
                                    ok = false; break;
                                }
                            } else if (el.type === 'voltage-source') {
                                if (!this.sim.update_voltage_source(el.componentId, el.voltage)) {
                                    ok = false; break;
                                }
                            } else {
                                // For caps, inductors, transistors, etc., we
                                // still need a full rebuild because their
                                // model params are currently static in the
                                // WASM core.
                                ok = false; break;
                            }
                        }
                        if (ok) {
                            if (this.sim.compile()) {
                                // Successfully updated parameters in-place!
                                break;
                            }
                        }
                    }

                    // Fullback: Full rebuild with state transfer.
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
                    this.elementCount = msg.netlist?.elements?.length || 0;
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

                case 'setSpeakerFilter': {
                    // Live-tune the speaker-resonance bandpass.
                    // Accepts any subset of { enabled, f0, Q, gain }.
                    // Unspecified fields are left at their current values.
                    const sf = this.speakerFilter;
                    if (typeof msg.enabled === 'boolean') sf.enabled = msg.enabled;
                    if (typeof msg.f0      === 'number' && msg.f0 > 0)   sf.f0   = msg.f0;
                    if (typeof msg.Q       === 'number' && msg.Q  > 0.1) sf.Q    = msg.Q;
                    if (typeof msg.gain    === 'number' && msg.gain >= 0) sf.gain = msg.gain;
                    this._recomputeSpeakerFilterCoeffs();
                    // Note: state intentionally NOT reset — keeps tuning
                    // smooth/glitch-free.
                    if (globalThis.__simDebug) {
                        console.log('[worklet] speaker filter:',
                                    sf.enabled ? `f0=${sf.f0}Hz Q=${sf.Q} gain=${sf.gain}` : 'disabled');
                    }
                    this.post({
                        type: 'speakerFilterUpdated',
                        enabled: sf.enabled, f0: sf.f0, Q: sf.Q, gain: sf.gain,
                    });
                    break;
                }

                case 'startDiagnosticCapture': {
                    // Allocate four Float32Arrays sized for the requested
                    // capture duration.  ~768 KB at 1s/48kHz/4-channel —
                    // small enough to clone cheaply across postMessage.
                    const seconds = Math.max(0.05, Math.min(10.0, Number(msg.seconds) || 1.0));
                    const total   = Math.ceil(seconds * sampleRate);
                    this.diagCapture = {
                        raw:        new Float32Array(total),
                        dcBlocked:  new Float32Array(total),
                        postFilter: new Float32Array(total),
                        postTanh:   new Float32Array(total),
                        pos:        0,
                        total,
                        sampleRate,
                    };
                    if (globalThis.__simDebug) {
                        console.log('[worklet] diagnostic capture armed:',
                                    seconds + 's =', total, 'samples');
                    }
                    this.post({ type: 'diagnosticCaptureStarted', total, sampleRate });
                    break;
                }

                case 'ping':
                    // No-op to keep the port/event-loop active.
                    break;

                case 'start':
                    console.log(`[${new Date().toISOString()}] [worklet] start received`);
                    // Only run if WASM mounted cleanly in the constructor.
                    if (this.wasmReady) this.running = true;
                    break;
                case 'stop':
                    console.log(`[${new Date().toISOString()}] [worklet] stop received`);
                    this.running = false;
                    break;
            }
        } catch (err) {
            this.post({ type: 'error', error: String(err && err.stack ? err.stack : err) });
        }
    }

    cacheSpeakerProbes(netlist) {
        this.speakerTopA = -1; this.speakerTopB = -1;
        this.t1PrimaryTop = -1; this.t1CenterTop = -1;

        // The speaker is modeled as nodeA --[Rvc]-- midNode --[Lvc]-- nodeB.
        // We want to probe [nodeA, nodeB] to get the full voltage across the coil.
        let nodeA = -1, nodeB = -1;
        for (const el of netlist.elements) {
            if (el.componentId === 'SPK1:Rvc') nodeA = el.nodes[0];
            if (el.componentId === 'SPK1:Lvc') nodeB = el.nodes[1];
        }

        if (nodeA !== -1 && nodeB !== -1) {
            this.speakerTopA = nodeA;
            this.speakerTopB = nodeB;
            if (globalThis.__simDebug) console.log(`[worklet] Probe: found SPK1 outer nodes [${nodeA}, ${nodeB}]`);
        }

        // T1 primary/centre — look for the LT700 winding-resistor pattern.
        for (const el of netlist.elements) {
            if (el.type === 'resistor' && el.componentId === 'T1:Rp1') {
                this.t1PrimaryTop = el.nodes[0];
            }
            if (el.type === 'inductor' && el.componentId === 'T1:Lp1') {
                this.t1CenterTop = el.nodes[1];
            }
        }

        if (this.speakerTopA === -1 && this.t1PrimaryTop === -1) {
            for (const el of netlist.elements) {
                if (el.type === 'inductor' || el.type === 'transformer') {
                    this.speakerTopA = el.nodes[0];
                    this.speakerTopB = el.nodes[1];
                    console.log(`[worklet] Probe fallback: using ${el.type} ${el.componentId} nodes [${el.nodes[0]}, ${el.nodes[1]}]`);
                    break;
                }
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
                v_ok = true;
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
            // Genuine sim NaN — propagating it would poison the DC blocker → all
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
            // One-shot "process() is alive" beacon. Posted on the very
            // first quantum regardless of __simDebug so we can always
            // confirm from the host whether the audio thread is being
            // scheduled (vs. silently never running, which is hard to
            // distinguish from "simulator produces zero output").
            if (!this._postedAliveBeacon) {
                this._postedAliveBeacon = true;
                this.post({ type: 'alive', running: this.running, hasSim: !!this.sim, wasmReady: this.wasmReady });
            }
            // Heartbeat is disabled by default. DevTools-attached
            // renderers stall the AudioWorklet when the main thread
            // performs console formatting on each postMessage — the
            // exact symptom is "audio cuts out ~500 ms after start
            // when DevTools is open, but works fine when it's closed".
            // Set globalThis.__simDebug = true from the host before
            // calling start() if you need the heartbeat back.
            if (globalThis.__simDebug) {
                if (this._debugCount === undefined) this._debugCount = 0;
                if (this._debugCount % 375 === 0) {
                    this.post({
                        type: 'debug',
                        state: {
                            running: this.running,
                            hasSim: !!this.sim,
                            wasmReady: this.wasmReady,
                            bootTonePos: this.bootTonePos,
                            speakerA: this.speakerTopA,
                            speakerB: this.speakerTopB,
                            t1P: this.t1PrimaryTop,
                            t1C: this.t1CenterTop,
                            audioProbe: this.audioProbe,
                            configureCount: this.configureCount,
                            lastConfigureStatus: this.lastConfigureStatus,
                            lastError: this.lastError,
                            elementCount: this.elementCount
                        }
                    });
                }
                this._debugCount++;
            }

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
        if (globalThis.__simDebug) {
            this._processCount = (this._processCount || 0) + 1;
            if (this._processCount % 100 === 0) console.log('[worklet] process() call', this._processCount, 'running:', this.running);
        }
        if (globalThis.__simDebug && this.running && this.sim && this.wasmReady) {
            this._debugLastRun = true;
        } else if (globalThis.__simDebug && this._debugLastRun) {
            this._debugLastRun = false;
            console.log('[worklet debug]:', {
                running: this.running,
                hasSim: !!this.sim,
                wasmReady: this.wasmReady,
                bootTonePos: this.bootTonePos,
                speakerA: this.speakerTopA,
                speakerB: this.speakerTopB,
                adaptiveDt: this.adaptiveDt,
                audioPhase: this.audioPhase
            });
        }
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
            let i = 0;
            for (; i < frames && this.bootTonePos < this.bootToneSamples; i++) {
                const s = 0.3 * Math.sin(omega * this.bootTonePos);
                ch0[i] = s;
                for (let c = 1; c < out.length; c++) out[c][i] = s;
                this.bootTonePos++;
            }
            if (this.bootTonePos >= this.bootToneSamples) {
                console.log(`[${new Date().toISOString()}] [worklet] boot tone finished`);
                // Clear state carryover so simulation starts at t=0
                this.audioPhase = 0;
                this.prevV = 0;
                this.dcPrevOut = 0;
                this.dcPrevIn = 0;
                this._resetSpeakerFilterState();
                this.didFirstQuantumReport = false;
                
                // If there are remaining frames in this quantum, we MUST
                // continue to the simulation logic instead of returning.
                if (i < frames) {
                    console.log(`[worklet] transitioning to sim in-quantum at frame ${i}`);
                    frame = i;
                } else {
                    return true;
                }
            } else {
                return true;
            }
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
            if (globalThis.__simDebug) {
                console.log('[worklet] first quantum:',
                    'speakerTopA=', this.speakerTopA,
                    'speakerTopB=', this.speakerTopB,
                    'audioProbe=', this.audioProbe,
                );
            }
        }
        this.framesSinceLog += frames;
        if (globalThis.__simDebug && this.framesSinceLog % 100 === 0) {
            console.log('[worklet debug] accumulation:', this.framesSinceLog);
        }
        if (this.framesSinceLog >= sampleRate) {
            const spkPp = this.spkMaxSinceLog - this.spkMinSinceLog;
            const outPp = this.outMaxSinceLog - this.outMinSinceLog;
            const activePct = (this.activeFramesSinceLog / this.framesSinceLog) * 100;
            const tickHz = this.tickEdgesSinceLog * sampleRate / this.framesSinceLog;
            if (globalThis.__simDebug) {
                const simNan = this.simNanCount || 0;
                const vA = this.speakerTopA >= 0 ? this.sim.node_voltage(this.speakerTopA) : 0;
                const vB = this.speakerTopB >= 0 ? this.sim.node_voltage(this.speakerTopB) : 0;
                console.log(
                    `[worklet] last 1s: ` +
                    `active=${activePct.toFixed(1)}% events=${this.tickEdgesSinceLog} (≈${tickHz.toFixed(1)}Hz) ` +
                    `simNaN=${simNan} ` +
                    `vA=${vA.toFixed(3)} vB=${vB.toFixed(3)} ` +
                    `spk[${this.spkMinSinceLog.toFixed(2)}..${this.spkMaxSinceLog.toFixed(2)}]=${spkPp.toFixed(2)} ` +
                    `out[${this.outMinSinceLog.toFixed(3)}..${this.outMaxSinceLog.toFixed(3)}]=${outPp.toFixed(3)} ` +
                    `dcPrevOut=${this.dcPrevOut.toFixed(3)}`
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
            // Check for NaN and count it — helps diagnose solver explosions.
            if (Number.isNaN(rawSpkV)) {
                this.simNanCount = (this.simNanCount || 0) + 1;
                rawSpkV = 0;
            }

            // Diagnostic capture: raw simulator voltage (pre-everything).
            const cap = this.diagCapture;
            if (cap !== null && cap.pos < cap.total) {
                cap.raw[cap.pos] = rawSpkV;
            }

            // Track speaker-V swing for the periodic log.
            if (rawSpkV < this.spkMinSinceLog) this.spkMinSinceLog = rawSpkV;
            if (rawSpkV > this.spkMaxSinceLog) this.spkMaxSinceLog = rawSpkV;
            const isActive = Math.abs(rawSpkV) > 0.05;
            if (isActive) {
                this.activeFramesSinceLog++;
                if (!this.lastWasActive) this.tickEdgesSinceLog++;
            }
            this.lastWasActive = isActive;

            // DC blocker — classic first-order high-pass:
            //   y[n] = x[n] - x[n-1] + R * y[n-1]
            // Responds instantly to DC shifts (no slow convergence),
            // passes all AC content above ~1.5 Hz at 48 kHz.
            let dcBlocked = rawSpkV - this.dcPrevIn + DC_BLOCK_R * this.dcPrevOut;
            if (!Number.isFinite(dcBlocked)) dcBlocked = 0;
            this.dcPrevIn  = rawSpkV;
            this.dcPrevOut = dcBlocked;

            // Diagnostic capture: post-DC-block, pre-tanh.
            if (cap !== null && cap.pos < cap.total) {
                cap.dcBlocked[cap.pos] = dcBlocked;
            }

            // ── Speaker mechanical-resonance bandpass ───────────────────
            // Sits between DC blocker and tanh.  Models the cone's natural
            // resonance, converting the simulator's spike-train output into
            // a continuous tone at ~f0 (default 2800 Hz).  Real small
            // speakers do this acoustically; our SPK1 model is purely
            // electrical, so we apply the equivalent shaping in the audio
            // chain.  Bypassable via `setSpeakerFilter { enabled: false }`.
            const sf = this.speakerFilter;
            let filtered;
            if (sf.enabled) {
                // Direct-Form-I biquad, b1=0 so the x[n-1] term drops out.
                filtered = sf.b0 * dcBlocked
                         + sf.b2 * sf.x2
                         - sf.a1 * sf.y1
                         - sf.a2 * sf.y2;
                if (!Number.isFinite(filtered)) filtered = 0;
                // Shift state.
                sf.x2 = sf.x1;  sf.x1 = dcBlocked;
                sf.y2 = sf.y1;  sf.y1 = filtered;
                // Apply post-filter gain — brings the BPF's output amplitude
                // into the tanh's linear region.
                filtered *= sf.gain;
            } else {
                filtered = dcBlocked;
            }

            // Diagnostic capture: post-filter, pre-tanh.
            if (cap !== null && cap.pos < cap.total) {
                cap.postFilter[cap.pos] = filtered;
            }

            // Audio chain: tanh saturator → fade-in.
            let s = Math.tanh(filtered / AUDIO_SCALE);
            // Fade-in on first connect.
            if (this.fadePos < FADE_IN_SAMPLES) {
                s *= this.fadePos / FADE_IN_SAMPLES;
                this.fadePos++;
            }

            // Mix in the relay click voice (additive — it's a parallel
            // mechanical sound, not part of the simulated electrical path,
            // so it bypasses the speaker filter and tanh).  Clamp to keep
            // the sum inside the AudioContext's [-1, 1] range.
            const clickSample = this._relayClickSample();
            if (clickSample !== 0) {
                s += clickSample;
                if (s >  1) s =  1;
                else if (s < -1) s = -1;
            }

            // Diagnostic capture: post-tanh (= what AudioContext receives).
            if (cap !== null && cap.pos < cap.total) {
                cap.postTanh[cap.pos] = s;
                cap.pos++;
                if (cap.pos >= cap.total) {
                    // Buffer is full — ship it back to the host and clear.
                    // Transfer ownership of the underlying ArrayBuffers
                    // (cheap; avoids ~768 KB of structured-clone copying).
                    this.port.postMessage(
                        {
                            type: 'diagnosticCapture',
                            sampleRate: cap.sampleRate,
                            samplesPerChannel: cap.total,
                            raw:        cap.raw,
                            dcBlocked:  cap.dcBlocked,
                            postFilter: cap.postFilter,
                            postTanh:   cap.postTanh,
                        },
                        [cap.raw.buffer, cap.dcBlocked.buffer,
                         cap.postFilter.buffer, cap.postTanh.buffer],
                    );
                    this.diagCapture = null;
                    if (globalThis.__simDebug) {
                        console.log('[worklet] diagnostic capture delivered:',
                                    cap.total, 'samples per channel');
                    }
                }
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
            // singularity forever.
            let stepDt = Math.max(DT_MIN, Math.min(this.adaptiveDt, nextT - simT));
            // Use the packed-u32 variant of step_with_gear in the audio
            // hot path.  The standard StepResult return crosses the JS↔
            // WASM boundary 5+ times per call (struct alloc + getters +
            // .free()) — at 128+ calls per quantum that's enough overhead
            // to push process() over budget on stiff circuits like the
            // metronome.  Packed u32 = one wasm crossing per step, no
            // alloc, no free.  Encoding: bit 0 = ok, bits 1-7 = issue,
            // bits 8-31 = iters.
            let r = this.sim.step_with_gear_packed(stepDt, 2);
            let stepOk = (r & 1) !== 0;
            let iters  = r >>> 8;

            if (!stepOk) {
                // Adaptive recovery: if a step fails at current dt, try
                // a much smaller step (DT_MIN) with BE.
                this.adaptiveDt = DT_MIN;
                const r2 = this.sim.step_with_gear_packed(DT_MIN, 1);
                if ((r2 & 1) !== 0) {
                    stepOk = true;
                    stepDt = DT_MIN;
                    iters  = r2 >>> 8;
                } else {
                    // Total failure: solve DC to jump to a valid state.
                    try { this.sim.solve_dc(); } catch (_e) { /* very stuck */ }
                }
            }

            if (!stepOk) {
                if (this.failuresSinceLog !== undefined) this.failuresSinceLog++;
                emit(prevV);
                nextT += period;
                continue;
            }

            // Adaptive step size: if Newton converged very quickly, we can
            // likely take larger steps. If it took many iterations, shrink.
            // Standard SPICE-like logic:
            if (iters <= 3) {
                this.adaptiveDt = Math.min(DT_MAX, this.adaptiveDt * 1.2);
            } else if (iters >= 6) {
                this.adaptiveDt = Math.max(DT_MIN, this.adaptiveDt * 0.5);
            }

            const newV = this.speakerV();

            // Relay-active edge detection (sample-accurate buzzer source).
            // export_relay_active() returns one byte per relay; we OR them so
            // any relay toggling triggers a click.  Cheap when no relay is
            // present (empty array → folds to 0).
            if (this.sim) {
                let active = 0;
                try {
                    const flags = this.sim.export_relay_active();
                    for (let i = 0; i < flags.length; i++) active |= flags[i];
                } catch (_e) { active = this.relayActivePrev ?? 0; }
                if (this.relayActivePrev !== null && active !== this.relayActivePrev) {
                    this._triggerRelayClick(active !== 0);
                }
                this.relayActivePrev = active;
            }

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

        // Per-quantum output amplitude diagnostic (every ~1s) — debug only.
        // Even the tight scan loop adds measurable cost on every quantum;
        // gate behind globalThis.__simDebug.
        if (globalThis.__simDebug) {
            if (this._outDiagCount === undefined) { this._outDiagCount = 0; this._outDiagMax = 0; this._outDiagNonZero = 0; this._outDiagTotal = 0; }
            let qMax = 0;
            let qNonZero = 0;
            for (let i = 0; i < frames; i++) {
                const abs = Math.abs(ch0[i]);
                if (abs > qMax) qMax = abs;
                if (abs > 1e-6) qNonZero++;
            }
            if (qMax > this._outDiagMax) this._outDiagMax = qMax;
            this._outDiagNonZero += qNonZero;
            this._outDiagTotal += frames;
            this._outDiagCount++;
            if (this._outDiagCount >= 375) {
                console.log(`[worklet] output 1s: maxAmp=${this._outDiagMax.toFixed(4)} nonZero=${this._outDiagNonZero}/${this._outDiagTotal} (${(100*this._outDiagNonZero/this._outDiagTotal).toFixed(1)}%)`);
                this._outDiagCount = 0; this._outDiagMax = 0; this._outDiagNonZero = 0; this._outDiagTotal = 0;
            }
        }

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
