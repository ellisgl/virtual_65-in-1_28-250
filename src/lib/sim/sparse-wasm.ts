/**
 * WASM-backed sparse LU module.
 *
 * Drop-in replacement for `$lib/sim/sparse` once the WASM build is in place.
 * Same API surface as the TypeScript module — same function names, same
 * argument order, same numerical output (verified by parity tests).
 *
 * Lifecycle
 * ---------
 *   await initSparseWasm();           // call once at app startup
 *   const pat = analyzePattern(...);  // synchronous after init
 *
 * The `initSparseWasm` promise resolves once the .wasm binary is downloaded
 * and instantiated.  After that all calls are synchronous and run inside
 * the wasm linear memory.
 *
 * Implementation note
 * -------------------
 * This file deliberately mirrors the TypeScript reference module's exports
 * 1-to-1.  At Phase 1 it's a thin adapter; at Phase 3 the rest of the
 * solver moves into wasm and this module becomes obsolete (consumers will
 * import a `Simulator` class from `sim-wasm` directly).
 */

import init, {
    analyzePattern as _wasmAnalyze,
    numericFactor as _wasmFactor,
    sparseSolveInPlace as _wasmSolve,
    minimumDegreeOrder as _wasmMd,
    SparseLuPattern as _WasmSparseLuPattern,
} from '$lib/sim/wasm/sim_wasm.js';

// Re-exported under the JS-facing name so the wasm `SparseLuPattern` is a
// plug-in replacement for the existing TS `SparseLUPattern` type at use sites.
export type SparseLUPattern = _WasmSparseLuPattern;

let _ready: Promise<void> | null = null;

/**
 * Fetch and instantiate the WASM module.  Idempotent — safe to call multiple
 * times; resolves once.
 *
 * Call this at app startup (e.g. in `+layout.ts` or before the first sim
 * step).  All other functions in this module require it to have resolved
 * before they're called.
 */
export function initSparseWasm(): Promise<void> {
    if (_ready === null) {
        // `init()` defaults to fetching the .wasm file from the URL embedded
        // in the wasm-bindgen glue — Vite resolves this correctly during
        // dev and build.
        _ready = init().then(() => undefined);
    }
    // After the if-block _ready is guaranteed non-null; TypeScript can't see
    // through the assignment, so an explicit assertion is needed.
    return _ready as Promise<void>;
}

/**
 * Build a SparseLuPattern from a boolean occupancy marker.
 *
 * `marker[i*n+j] != 0` means position (i,j) may carry a non-zero value
 * during factorization.  Returns an opaque pattern handle that lives in
 * wasm memory.
 */
export function analyzePattern(marker: Uint8Array, n: number): SparseLUPattern {
    return _wasmAnalyze(marker, n);
}

/**
 * Numeric LU factorization in place using a precomputed symbolic pattern.
 *
 * On return the lower triangle of `mat` stores L (unit diagonal not written)
 * and the upper triangle + diagonal store U.  Returns `false` if a pivot
 * fell below the numerical threshold (caller should fall back to a
 * pivoting solver).
 *
 * **Note:** the `Float64Array` is copied into wasm memory on call and the
 * mutated result copied back on return.  For circuits of n ≤ ~40 this is
 * microseconds per call.  Phase 3 moves the matrix permanently into wasm
 * so the copy disappears.
 */
export function numericFactor(
    mat: Float64Array,
    n: number,
    pat: SparseLUPattern,
): boolean {
    return _wasmFactor(mat, n, pat);
}

/**
 * Solve `(L * U) * x = rhs` using a matrix already factored by
 * `numericFactor`.  Solution overwrites `rhs` on return.
 */
export function sparseSolveInPlace(
    mat: Float64Array,
    rhs: Float64Array,
    n: number,
    pat: SparseLUPattern,
): void {
    _wasmSolve(mat, rhs, n, pat);
}

/**
 * Greedy Minimum Degree elimination ordering.
 *
 * Takes the same `Iterable<readonly [number, number]>` as the TypeScript
 * reference.  We flatten into `Int32Array` for the wasm boundary.
 */
export function minimumDegreeOrder(
    n: number,
    edges: Iterable<readonly [number, number]>,
): Int32Array {
    // Flatten edge pairs into [i0, j0, i1, j1, …].
    const flat: number[] = [];
    for (const [i, j] of edges) {
        flat.push(i, j);
    }
    const result = _wasmMd(n, new Int32Array(flat));
    // wasm-bindgen returns Int32Array — pass it straight through.
    return result;
}
