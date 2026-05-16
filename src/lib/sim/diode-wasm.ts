/**
 * WASM-backed diode stamp.
 *
 * Drop-in replacement for `$lib/sim/diode` once the WASM build is in place.
 * Same function signature, same numerical output.
 *
 * Lifecycle
 * ---------
 *   await initSimWasm();                 // call once at app startup
 *   const stamp = computeDiodeStamp(...);
 *
 * Phase 2 caveat
 * --------------
 * This adapter constructs a fresh WASM `Diode` handle per call.  Allocation
 * cost is ~hundreds of nanoseconds per stamp — fine for the parity test
 * but undesirable at audio rate.  Phase 3 moves the elements permanently
 * into wasm memory; this adapter then becomes obsolete.
 */

import init, {
    Diode as WasmDiode,
    computeDiodeStamp as wasmComputeDiodeStamp,
} from '$lib/sim/wasm/sim_wasm.js';
import type { SimulationDiodeElement } from '$lib/types';

export interface DiodeStamp {
    gd: number;
    ieq: number;
}

let _ready: Promise<void> | null = null;

/** Initialize the WASM module.  Idempotent; safe to call multiple times. */
export function initSimWasm(): Promise<void> {
    if (_ready === null) {
        _ready = init().then(() => undefined);
    }
    return _ready as Promise<void>;
}

export function computeDiodeStamp(
    diode: SimulationDiodeElement,
    volts: Float64Array,
    ai: number,
    ki: number,
    prevVolts?: Float64Array,
): DiodeStamp {
    // Construct the WASM-side element.  See module docstring re: lifetime —
    // we trade a per-call allocation for a much simpler API; cleaned up in
    // Phase 3 when elements live permanently in wasm memory.
    const wasmDiode = diode.bv !== undefined
        ? WasmDiode.zener(diode.is, diode.n, diode.bv, diode.ibv)
        : WasmDiode.shockley(diode.is, diode.n);

    // Pass undefined through as undefined; wasm-bindgen's Option<Vec<f64>>
    // accepts that natively.
    const stamp = wasmComputeDiodeStamp(wasmDiode, volts, ai, ki, prevVolts);

    // Pull the values out before the handle goes out of scope.  wasm-bindgen
    // garbage-collects the wrapper objects via FinalizationRegistry, so
    // there's no manual free() needed here.
    const result: DiodeStamp = { gd: stamp.gd, ieq: stamp.ieq };

    // Free explicitly anyway — FinalizationRegistry runs at GC time, which
    // for audio-rate calls would mean accumulating thousands of wasm-side
    // allocations before being collected.  Explicit free keeps wasm heap
    // pressure low.
    wasmDiode.free();
    stamp.free();
    return result;
}
