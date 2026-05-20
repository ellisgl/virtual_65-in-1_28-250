/**
 * Parity test: TypeScript vs WASM sparse LU.
 *
 * Run after building the WASM module (in the `rust-e-sim` repo).  Loads both
 * implementations, runs the exact same inputs through each, asserts outputs
 * match within floating-point tolerance.
 *
 * To run in the dev server:
 *   1. Add a route that imports this file and calls `runSparseParityTests()`.
 *   2. Open the page in the browser and check the console.
 *
 * To run as a script with bun:
 *   bun scripts/test-sparse-parity.ts
 *
 * Note: Vite serves the .wasm with the right MIME type; bun may need
 * explicit fetch handling.  Browser is the canonical environment.
 */

import * as tsSparse from '$lib/sim/sparse';
import * as wasmSparse from '$lib/sim/sparse-wasm';

const TOL = 1e-12;

interface TestCase {
    name: string;
    n: number;
    /** Row-major n×n. */
    matrix: number[];
    /** Length n. */
    rhs: number[];
}

const CASES: TestCase[] = [
    {
        name: '3x3 simple tridiagonal',
        n: 3,
        matrix: [4, 1, 0,
                 1, 3, 1,
                 0, 1, 2],
        rhs: [5, 6, 4],
    },
    {
        name: '5x5 arrow matrix',
        n: 5,
        matrix: [
            5, 1, 1, 1, 1,
            1, 6, 0, 0, 0,
            1, 0, 7, 0, 0,
            1, 0, 0, 8, 0,
            1, 0, 0, 0, 9,
        ],
        rhs: [10, 7, 8, 9, 10],
    },
    {
        name: '4x4 dense',
        n: 4,
        matrix: [
            10, -2,  1,  0,
            -1,  8, -1,  3,
             2,  0,  7, -1,
             0,  1, -2,  5,
        ],
        rhs: [9, 9, 8, 4],
    },
];

function buildMarker(matrix: number[], n: number): Uint8Array {
    const marker = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) {
        if (matrix[i] !== 0) marker[i] = 1;
    }
    return marker;
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let m = 0;
    for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > m) m = d;
    }
    return m;
}

export async function runSparseParityTests(): Promise<{ passed: number; failed: number }> {
    await wasmSparse.initSparseWasm();
    let passed = 0, failed = 0;

    for (const tc of CASES) {
        // TS reference.
        const tsMarker = buildMarker(tc.matrix, tc.n);
        const tsPat    = tsSparse.analyzePattern(tsMarker, tc.n);
        const tsMat    = new Float64Array(tc.matrix);
        const tsRhs    = new Float64Array(tc.rhs);
        const tsOk     = tsSparse.numericFactor(tsMat, tc.n, tsPat);
        tsSparse.sparseSolveInPlace(tsMat, tsRhs, tc.n, tsPat);

        // WASM under test.
        const wMarker = buildMarker(tc.matrix, tc.n);
        const wPat    = wasmSparse.analyzePattern(wMarker, tc.n);
        const wMat    = new Float64Array(tc.matrix);
        const wRhs    = new Float64Array(tc.rhs);
        const wOk     = wasmSparse.numericFactor(wMat, tc.n, wPat);
        wasmSparse.sparseSolveInPlace(wMat, wRhs, tc.n, wPat);

        const okMatches  = tsOk === wOk;
        const rhsDiff    = maxAbsDiff(tsRhs, wRhs);
        const matDiff    = maxAbsDiff(tsMat, wMat);

        const ok = okMatches && rhsDiff < TOL && matDiff < TOL;
        if (ok) {
            passed++;
            console.log(`✓ ${tc.name}  (max Δrhs=${rhsDiff.toExponential(2)}, Δmat=${matDiff.toExponential(2)})`);
        } else {
            failed++;
            console.error(`✗ ${tc.name}`);
            console.error(`  okMatches=${okMatches} rhsDiff=${rhsDiff} matDiff=${matDiff}`);
            console.error(`  ts rhs: [${Array.from(tsRhs).join(', ')}]`);
            console.error(`  ws rhs: [${Array.from(wRhs).join(', ')}]`);
        }
    }

    // Also exercise minimumDegreeOrder.
    {
        const edges: [number, number][] = [[0,1],[1,2],[2,3],[3,4]];
        const tsOrder = tsSparse.minimumDegreeOrder(5, edges);
        const wOrder  = wasmSparse.minimumDegreeOrder(5, edges);
        const ok = tsOrder.length === wOrder.length &&
                   Array.from(tsOrder).every((v, i) => v === wOrder[i]);
        if (ok) { passed++; console.log('✓ minimumDegreeOrder path-graph'); }
        else    { failed++; console.error('✗ minimumDegreeOrder path-graph',
                    Array.from(tsOrder), '!=', Array.from(wOrder)); }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed };
}
