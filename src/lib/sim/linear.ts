/**
 * Gaussian elimination with partial pivoting.
 *
 * Two signatures:
 *   solveLinearSystem(matrix: number[][], rhs: number[]) — legacy interface
 *   solveLinearSystem(matFlat: Float64Array, rhsFlat: Float64Array, n: number, scratch: Float64Array) — fast path
 *
 * The fast path takes the already-populated flat buffers and a pre-allocated
 * scratch Float64Array of length n*n + n (modified in place, result in rhsFlat[0..n]).
 */
export function solveLinearSystem(
    matrix: number[][] | Float64Array,
    rhs: number[] | Float64Array,
    n?: number,
    scratch?: Float64Array
): number[] | null {
    if (matrix instanceof Float64Array) {
        // Fast path: flat preallocated buffers
        return _solveFast(matrix, rhs as Float64Array, n!, scratch!);
    }
    // Legacy path
    const size = (rhs as number[]).length;
    if ((matrix as number[][]).length !== size) return null;
    const a = new Float64Array(size * size);
    const b = new Float64Array(size);
    for (let i = 0; i < size; i++) {
        const row = (matrix as number[][])[i];
        if (row.length !== size) return null;
        const off = i * size;
        for (let j = 0; j < size; j++) a[off + j] = row[j];
        b[i] = (rhs as number[])[i];
    }
    return _solveFlatInPlace(a, b, size);
}

/**
 * Fast path: solve in-place using the provided flat buffer.
 * scratch must be Float64Array of length n*n + n.
 * Returns solution as a plain number[] for compatibility.
 */
function _solveFast(matFlat: Float64Array, rhsFlat: Float64Array, n: number, scratch: Float64Array): number[] | null {
    // Copy into scratch so we don't destroy the caller's preallocated matrix.
    scratch.set(matFlat, 0);
    scratch.set(rhsFlat, n * n);
    const a = scratch.subarray(0, n * n);
    const b = scratch.subarray(n * n, n * n + n);
    return _solveFlatInPlace(a, b, n);
}

function _solveFlatInPlace(a: Float64Array, b: Float64Array, n: number): number[] | null {
    for (let pivot = 0; pivot < n; pivot++) {
        // Partial pivoting.
        let maxRow = pivot;
        let maxVal = Math.abs(a[pivot * n + pivot]);
        for (let row = pivot + 1; row < n; row++) {
            const val = Math.abs(a[row * n + pivot]);
            if (val > maxVal) { maxVal = val; maxRow = row; }
        }
        if (maxVal < 1e-12) return null;
        if (maxRow !== pivot) {
            const pOff = pivot * n, mOff = maxRow * n;
            for (let j = 0; j < n; j++) {
                const tmp = a[pOff + j]; a[pOff + j] = a[mOff + j]; a[mOff + j] = tmp;
            }
            const tmp = b[pivot]; b[pivot] = b[maxRow]; b[maxRow] = tmp;
        }
        const pivVal = a[pivot * n + pivot];
        for (let row = pivot + 1; row < n; row++) {
            const rowOff = row * n;
            const factor = a[rowOff + pivot] / pivVal;
            if (factor === 0) continue;
            for (let col = pivot; col < n; col++) a[rowOff + col] -= factor * a[pivot * n + col];
            b[row] -= factor * b[pivot];
        }
    }
    // Back-substitution — write result back into b.
    for (let row = n - 1; row >= 0; row--) {
        let sum = b[row];
        const rowOff = row * n;
        for (let col = row + 1; col < n; col++) sum -= a[rowOff + col] * b[col];
        b[row] = sum / a[rowOff + row];
    }
    return Array.from(b);
}
