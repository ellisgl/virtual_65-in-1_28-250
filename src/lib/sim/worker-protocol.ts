/**
 * Message protocol between Board.svelte (main thread) and sim-worker.ts.
 *
 * Two reconfiguration modes:
 *   configure      – topology changed; worker rebuilds everything and resets transient state.
 *   updateControls – only values changed (pot, capacitor, switch); worker recompiles the
 *                    netlist with the new values but preserves the running transient state
 *                    so continuous knob sweeps produce no audible glitch or restart.
 *
 * Solver engine selection:
 *   `engine: 'ts'`   – TypeScript reference solver (default).
 *   `engine: 'rust'` – WASM-backed Rust solver.  Requires the WASM module to
 *                      be built (`cd rust && ./build.sh`).  Falls back to TS
 *                      with a console warning if WASM init fails.
 *
 *   The engine is locked at `configure` time; switching engines requires a
 *   full reconfigure.  `updateControls` cannot change engine.
 */

export interface WireSpec {
    fromTerminal: number;
    toTerminal: number;
}

export type SolverEngine = 'ts' | 'rust';

/** Mirrors the options object accepted by buildSimulationNetlist(). */
export interface ControlState {
    valueOverrides:    Record<string, number>;   // e.g. { VC1: 123e-12 }
    positionOverrides: Record<string, number>;   // e.g. { VR1: 0.75 }
    switchStates:      Record<string, boolean>;  // e.g. { KEY1: true }
}

// ── Main thread → Worker ─────────────────────────────────────────────────────

export type MainToWorker =
    /** Topology changed: rebuild everything, reset transient state, wait for 'start'. */
    | { type: 'configure'; wires: WireSpec[]; controls: ControlState; engine?: SolverEngine }
    /** Only values changed: recompile netlist, keep running transient state. */
    | { type: 'updateControls'; controls: ControlState }
    /** Begin the simulation loop. */
    | { type: 'start' }
    /** Pause the simulation loop (transient state is preserved). */
    | { type: 'stop' }
    /** Inform the worker of the current audio sample rate (null = audio disabled). */
    | { type: 'audioRate'; sampleRate: number | null }
    /** Relay worklet buffer fill so the worker can back off when the buffer is full. */
    | { type: 'backpressure'; bufferFill: number };

// ── Worker → Main thread ─────────────────────────────────────────────────────

export type WorkerToMain =
    /** Periodic node-voltage snapshot for UI rendering (~30 fps). */
    | { type: 'snapshot'; nodeVoltages: Record<number, number> }
    /**
     * Batch of normalised audio samples [-1, 1].
     * Sent as a transferable Float32Array — the buffer is detached after postMessage,
     * so the main thread must forward it promptly and not hold a reference.
     */
    | { type: 'audioSamples'; samples: Float32Array }
    /**
     * Sent once after `configure` completes, reporting which engine actually
     * activated (matters when 'rust' was requested but WASM init failed and
     * the worker fell back to 'ts').
     */
    | { type: 'engineReady'; engine: SolverEngine };
