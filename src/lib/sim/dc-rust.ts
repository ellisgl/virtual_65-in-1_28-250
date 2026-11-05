/**
 * dc-rust.ts — main-thread DC solver routed through the Rust WASM core.
 *
 * Replaces the TypeScript DC solver in `dc.ts` for the live UI snapshot
 * that Board.svelte uses for voltmeter readings, lamp brightness, and
 * other always-on overlays.  The TS solver had a relay-sparsity bug
 * (contact stamp positions weren't in `dcPatMark`) and a too-strict
 * floating-throw filter; the Rust path has neither, plus all the BJT
 * junction-capacitance + pnjlim fixes from Phase 4.
 *
 * Lifecycle:
 *   - On client-side module load, kick off WASM init asynchronously.
 *   - Until init resolves, `solveDcRust()` returns an empty result with
 *     ok=false.  Board.svelte should default to a sentinel DcSolution
 *     during the first few frames after page load.  In practice the
 *     load completes within ~50ms of first paint on a warm cache.
 *   - Once ready, calls are fully synchronous — wasm-bindgen exports
 *     have no async overhead inside.  Each call builds a fresh Simulator
 *     from the netlist, solves DC, reads back voltages + VS currents,
 *     and frees the simulator.  Matches the TS solver's "fresh state
 *     per call" semantics; no caching.
 *
 * The shape returned matches `DcSolution` from `types.ts`, byte-for-byte
 * compatible with everything that currently consumes TS DC output.
 */

import init from '#lib/sim/wasm/sim_wasm.js';
import wasmUrl from '#lib/sim/wasm/sim_wasm_bg.wasm?url';
import { browser } from '$app/env';
import { solveDcWasm } from '#lib/sim/dc-wasm';
import type { DcSolution, SimulationNetlist } from '#lib/types';

// ── WASM init ───────────────────────────────────────────────────────────────

let _readyPromise: Promise<void> | null = null;
let _ready = false;

/** Kick off WASM init.  Idempotent — returns the same Promise on each call.
 *  Called at module load on the client; callers can `await` to make sure
 *  the synchronous `solveDcRust()` will work. */
export function initRustDc(): Promise<void> {
    if (_readyPromise) return _readyPromise;
    _readyPromise = init({ module_or_path: wasmUrl }).then(() => {
        _ready = true;
    });
    return _readyPromise;
}

/** True once `initRustDc()` has resolved.  Reactive code can read this
 *  to know whether `solveDcRust()` will produce real output. */
export function isRustDcReady(): boolean {
    return _ready;
}

// Fire init as soon as this module loads in the browser.  On SvelteKit
// SSR (typeof window === 'undefined'), the `browser` guard keeps the
// fetch from running where it'd fail.
if (browser) {
    initRustDc().catch((err) => {
        console.error('[dc-rust] WASM init failed:', err);
    });
}

// ── DC solver ───────────────────────────────────────────────────────────────

const EMPTY_LOADING: DcSolution = {
    ok: false,
    nodeVoltages: {},
    sourceCurrents: {},
    warnings: [],
    issue: { code: 'singular-matrix', message: 'WASM not yet loaded' },
};

/**
 * Solve the DC operating point of `netlist` using the Rust WASM core.
 * Synchronous after WASM has loaded; returns an empty result before then.
 * See `solveDcWasm` in `dc-wasm.ts` for the solve itself.
 */
export function solveDcRust(netlist: SimulationNetlist): DcSolution {
    if (!_ready) return EMPTY_LOADING;
    return solveDcWasm(netlist);
}
