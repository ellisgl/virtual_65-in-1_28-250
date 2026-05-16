/// <reference lib="webworker" />
/**
 * sim-worker.ts — the entire circuit simulation runs here.
 *
 * Lifecycle
 * ---------
 *   configure      → build topology/netlist/DC from scratch, reset transient state, wait for 'start'
 *   updateControls → recompile netlist with new values, keep running transient state
 *   start          → begin setInterval loop
 *   stop           → clear interval, preserve state for possible resume
 *   audioRate      → update the audio sample rate used for resampling
 *   backpressure   → throttle audio output when worklet buffer is full
 *
 * Outputs (postMessage)
 * ---------------------
 *   snapshot     → node-voltage map at ~30 fps for UI rendering
 *   audioSamples → Float32Array (transferred, zero-copy) forwarded to worklet
 */

import { KIT_COMPONENTS } from '$lib/data/components';
import { buildCircuitTopology } from '$lib/sim/topology';
import { buildSimulationNetlist } from '$lib/sim/netlist';
import { createEngine, type SolverEngineInstance } from '$lib/sim/solver-engine';
import type { MainToWorker, WorkerToMain, WireSpec, ControlState, SolverEngine } from '$lib/sim/worker-protocol';

// ── Simulation constants ────────────────────────────────────────────────────

const DT_MIN   = 1e-6;    // 1 µs  — captures fast transformer pulses
const DT_MAX   = 0.5e-3;  // 0.5 ms — must capture audio-frequency oscillations
const DT_INIT  = 10e-6;   // 10 µs — conservative cold start
const STARTUP_KICK_AMPLITUDE  = 0.005;   // volts
const SPEAKER_AUDIO_SCALE_VOLTS = 3;
const SPEAKER_DC_BLOCK_ALPHA    = 0.9985;
const SPEAKER_FLUSH_BATCH       = 128;   // samples per audio message — one worklet quantum at 48kHz
const BACKPRESSURE_THRESHOLD    = 1024;  // worklet samples (~21ms) before pausing production
const MAX_CATCHUP_SIMTIME       = 0.010; // 10 ms — limits one-tick burst after a stall
const MAX_SUBSTEPS_PER_TICK     = 2000;
const SNAPSHOT_INTERVAL_MS      = 33;    // ~30 fps voltage updates
const TICK_INTERVAL_MS          = 4;     // worker setInterval period

// ── Worker state ────────────────────────────────────────────────────────────

let running = false;
let intervalId: ReturnType<typeof setInterval> | null = null;

// Last received wire list — kept so updateControls can rebuild without resending wires.
let currentWires: WireSpec[] = [];

// Active simulation objects.
let engine: SolverEngineInstance | null = null;
let currentTopology: ReturnType<typeof buildCircuitTopology> | null = null;
let adaptiveDt = DT_INIT;

// Audio resampling state.
let audioSampleRate: number | null = null;
let audioSimTime        = 0;  // total sim-time elapsed since audio was enabled
let audioNextSampleTime = 0;  // next absolute sim-time at which to emit a sample
let audioPrevSpkV       = 0;  // speaker voltage at the previous solver step
let speakerDcEstimate   = 0;

/**
 * Pre-allocated audio sample buffer.  The previous `number[]` with `push()`
 * was allocating heavily at audio rate (48 k boxed-number writes/sec + array
 * grow events + the splice() return-array allocation per flush).  A typed
 * array with an explicit write index keeps all writes in-place, zero GC.
 * Capacity sized for one catch-up burst worth of samples.
 */
const AUDIO_BUFFER_CAPACITY = 4096;
const audioBuffer = new Float32Array(AUDIO_BUFFER_CAPACITY);
let audioBufferWriteIdx = 0;

/**
 * Worker's local estimate of the worklet's ring-buffer fill (samples).
 * The worklet reports its own fill periodically, but with a ~44 ms round-trip
 * delay (REPORT_EVERY × quantum + message latency).  By tracking the estimate
 * locally — incrementing on send, decrementing by audioSampleRate × wallElapsed
 * on each tick — backpressure decisions are sample-accurate with zero feedback
 * lag.  The worklet's reports are still used to *correct* drift on arrival.
 */
let estimatedBufferFill = 0;

// Speaker / transformer topology node IDs.  Used to read voltages from
// the engine via `nodeVoltageByTopologyId`.  -1 = not in the current circuit.
let speakerTopA: number = -1;
let speakerTopB: number = -1;
let t1PrimaryTop: number = -1;
let t1CenterTop:  number = -1;

// Snapshot timing.
let lastTickWallTime = 0;
let lastSnapshotTime = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

function post(msg: WorkerToMain, transfer?: Transferable[]): void {
    (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

/** Wires from the protocol (no id/color) → Wire objects the topology builder wants. */
function toWireObjects(specs: WireSpec[]) {
    return specs.map((w) => ({ fromTerminal: w.fromTerminal, toTerminal: w.toTerminal, id: '', color: '' }));
}

/** Cache speaker/transformer topology node IDs after each compile. */
function cacheSpeakerNodes(topology: ReturnType<typeof buildCircuitTopology>): void {
    const get = (terminalId: number): number => {
        const topNode = topology.terminalToNode[terminalId];
        return typeof topNode === 'number' ? topNode : -1;
    };

    const spk = KIT_COMPONENTS.find((c) => c.id === 'SPK1');
    if (spk && spk.terminals.length >= 2) {
        speakerTopA = get(spk.terminals[0]);
        speakerTopB = get(spk.terminals[1]);
    } else {
        speakerTopA = speakerTopB = -1;
    }
    t1PrimaryTop = get(70);
    t1CenterTop  = get(71);
}

/**
 * Extract speaker voltage from the compact nodeVolts array.
 * Uses precomputed compact indices — zero hash-table overhead per audio sample.
 * A compact index of -1 means the node is ground (V = 0).
 */
function getSpeakerVoltage(): number {
    if (!engine) return 0;
    if (speakerTopA >= 0 || speakerTopB >= 0) {
        const va = speakerTopA >= 0 ? engine.nodeVoltageByTopologyId(speakerTopA) : 0;
        const vb = speakerTopB >= 0 ? engine.nodeVoltageByTopologyId(speakerTopB) : 0;
        const v = va - vb;
        if (Math.abs(v) > 0.001) return v;
    }
    if (t1PrimaryTop >= 0 || t1CenterTop >= 0) {
        const vp = t1PrimaryTop >= 0 ? engine.nodeVoltageByTopologyId(t1PrimaryTop) : 0;
        const vc = t1CenterTop  >= 0 ? engine.nodeVoltageByTopologyId(t1CenterTop)  : 0;
        return (vp - vc) / 10;
    }
    return 0;
}

function resetAudioState(): void {
    audioSimTime        = 0;
    audioNextSampleTime = 0;
    audioPrevSpkV       = 0;
    speakerDcEstimate   = 0;
    audioBufferWriteIdx = 0;
    estimatedBufferFill = 0;
}

// ── Configure / update ───────────────────────────────────────────────────────

async function configure(
    wires: WireSpec[],
    controls: ControlState,
    requestedEngine: SolverEngine,
): Promise<void> {
    currentWires = wires;
    const topology = buildCircuitTopology(toWireObjects(wires), KIT_COMPONENTS);
    const netlist  = buildSimulationNetlist(topology, KIT_COMPONENTS, controls);

    // Dispose any previous engine (e.g. on a reconfigure) before swapping.
    if (engine) {
        engine.dispose();
        engine = null;
    }

    const { engine: newEngine, actual } = await createEngine(requestedEngine);
    if (!newEngine.configure(netlist, STARTUP_KICK_AMPLITUDE)) {
        // Empty/invalid netlist — leave engine null; tick() will no-op.
        post({ type: 'engineReady', engine: actual });
        return;
    }
    engine = newEngine;
    currentTopology = topology;
    cacheSpeakerNodes(topology);

    adaptiveDt = DT_INIT;
    resetAudioState();
    post({ type: 'engineReady', engine: actual });
}

/**
 * Recompile the netlist with updated values (pot position, capacitance, switch)
 * without resetting the running transient state.  TS engine preserves state
 * across this; Rust engine currently rebuilds (Phase 3d limitation —
 * documented in solver-engine.ts).
 */
function updateControls(controls: ControlState): void {
    if (!currentWires.length || !engine || !currentTopology) return;
    const netlist = buildSimulationNetlist(currentTopology, KIT_COMPONENTS, controls);
    engine.updateControls(netlist);
    cacheSpeakerNodes(currentTopology);
}

// ── Simulation loop ──────────────────────────────────────────────────────────

function tick(): void {
    if (!running || !engine) return;

    const now         = performance.now();
    const wallElapsed = (now - lastTickWallTime) / 1000;
    lastTickWallTime  = now;

    // Drain the local buffer estimate by the audio the worklet has consumed
    // since the previous tick.  Used for zero-lag backpressure decisions —
    // we don't have to wait for the worklet's bufferFill round-trip.
    if (audioSampleRate !== null) {
        estimatedBufferFill = Math.max(0, estimatedBufferFill - wallElapsed * audioSampleRate);
    }

    // Sim time advanced this tick: at most wallElapsed (never get ahead of
    // real time → no buffer growth), capped at MAX_CATCHUP_SIMTIME so a stall
    // can't push out a huge catch-up batch.
    const budget = Math.min(wallElapsed, MAX_CATCHUP_SIMTIME);

    const audioPeriod   = audioSampleRate ? 1 / audioSampleRate : 0;
    const audioEnabled  = audioSampleRate !== null && estimatedBufferFill < BACKPRESSURE_THRESHOLD;

    let simTimeAdvanced = 0;
    let substeps        = 0;
    let dt = Math.max(DT_MIN, Math.min(DT_MAX, adaptiveDt));

    while (simTimeAdvanced < budget && substeps < MAX_SUBSTEPS_PER_TICK) {
        const stepDt = Math.min(dt, budget - simTimeAdvanced);

        const result = engine.step(stepDt);

        if (!result.ok) {
            // Solver diverged — stop and report via a silence snapshot.
            running = false;
            if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
            post({ type: 'snapshot', nodeVoltages: {} });
            return;
        }

        // ── Audio resampling ────────────────────────────────────────────────
        // The audio clock (audioSimTime / audioNextSampleTime / audioPrevSpkV)
        // ALWAYS advances at real-time rate as long as audioSampleRate is set.
        // Backpressure is handled by *dropping* generated samples — not by
        // pausing the clock — so when the buffer drains we resume cleanly
        // from the current circuit state instead of replaying stale samples.
        if (audioPeriod > 0) {
            const stepStart = audioSimTime + simTimeAdvanced;
            const stepEnd   = stepStart + stepDt;
            const spkVNew   = getSpeakerVoltage();

            while (audioNextSampleTime <= stepEnd) {
                if (audioNextSampleTime < stepStart) audioNextSampleTime = stepStart;
                const alpha = stepDt > 0 ? (audioNextSampleTime - stepStart) / stepDt : 0;
                const spkV  = audioPrevSpkV + (spkVNew - audioPrevSpkV) * alpha;
                speakerDcEstimate =
                    speakerDcEstimate * SPEAKER_DC_BLOCK_ALPHA + spkV * (1 - SPEAKER_DC_BLOCK_ALPHA);
                const acV = spkV - speakerDcEstimate;
                if (audioEnabled && audioBufferWriteIdx < AUDIO_BUFFER_CAPACITY) {
                    audioBuffer[audioBufferWriteIdx++] = Math.tanh(acV / SPEAKER_AUDIO_SCALE_VOLTS);
                }
                audioNextSampleTime += audioPeriod;
            }
            audioPrevSpkV = spkVNew;
        }
        // ────────────────────────────────────────────────────────────────────

        simTimeAdvanced += stepDt;
        substeps++;
        if (result.recommendedDt !== undefined) {
            dt = Math.max(DT_MIN, Math.min(DT_MAX, result.recommendedDt));
        }
    }

    if (audioPeriod > 0) audioSimTime += simTimeAdvanced;
    adaptiveDt = dt;

    // Flush whatever audio we generated this tick — small batches keep latency
    // close to one tick interval (~4 ms) instead of waiting for a fixed buffer.
    // SPEAKER_FLUSH_BATCH still acts as an upper bound on a single batch so a
    // long catch-up stall doesn't send one huge message.
    if (audioBufferWriteIdx > 0) {
        const batchSize = Math.min(audioBufferWriteIdx, SPEAKER_FLUSH_BATCH);
        // One Float32Array allocation per flush is unavoidable — the buffer is
        // detached when transferred to the main thread, so it can't be reused.
        // At 250 flushes/sec × 512 bytes that's ~128 kB/sec of nursery churn,
        // about three orders of magnitude less than the old push()-loop pattern.
        const samples = new Float32Array(batchSize);
        samples.set(audioBuffer.subarray(0, batchSize));
        if (audioBufferWriteIdx > batchSize) {
            audioBuffer.copyWithin(0, batchSize, audioBufferWriteIdx);
        }
        audioBufferWriteIdx -= batchSize;
        estimatedBufferFill += batchSize;
        post({ type: 'audioSamples', samples }, [samples.buffer]);

        // Catch-up overflow: send the rest in one more message rather than
        // dribbling out across ticks.
        if (audioBufferWriteIdx > 0) {
            const rest = new Float32Array(audioBufferWriteIdx);
            rest.set(audioBuffer.subarray(0, audioBufferWriteIdx));
            estimatedBufferFill += audioBufferWriteIdx;
            audioBufferWriteIdx = 0;
            post({ type: 'audioSamples', samples: rest }, [rest.buffer]);
        }
    }

    // Periodic voltage snapshot for the UI.
    if (now - lastSnapshotTime >= SNAPSHOT_INTERVAL_MS && engine) {
        post({ type: 'snapshot', nodeVoltages: engine.snapshot() });
        lastSnapshotTime = now;
    }
}

// ── Message handler ──────────────────────────────────────────────────────────

(self as unknown as Worker).onmessage = (e: MessageEvent<MainToWorker>): void => {
    const msg = e.data;
    switch (msg.type) {
        case 'configure':
            if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
            running = false;
            // configure is async — fire-and-forget; the engineReady message
            // tells the main thread when it's safe to send 'start'.
            void configure(msg.wires, msg.controls, msg.engine ?? 'ts');
            break;

        case 'updateControls':
            updateControls(msg.controls);
            break;

        case 'start':
            if (!running) {
                running          = true;
                lastTickWallTime = performance.now();
                lastSnapshotTime = performance.now();
                intervalId       = setInterval(tick, TICK_INTERVAL_MS);
            }
            break;

        case 'stop':
            running = false;
            if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
            break;

        case 'audioRate':
            audioSampleRate = msg.sampleRate;
            // Reset resampler timing so the next start is phase-correct.
            resetAudioState();
            break;

        case 'backpressure':
            // Snap the local estimate to the authoritative worklet report.
            // The estimate drifts slowly because the worklet's adaptive rate
            // doesn't consume at exactly audioSampleRate; this corrects that.
            estimatedBufferFill = msg.bufferFill;
            break;
    }
};
