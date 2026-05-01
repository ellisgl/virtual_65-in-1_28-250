/**
 * Gaussian elimination with partial pivoting.
 *
 * Uses a flat Float64Array (row-major) instead of a jagged number[][] to
 * avoid per-call heap allocation and improve cache locality. The matrix
 * is copied into a scratch buffer on each call so the caller's data is
 * not mutated.
 */
export function solveLinearSystem(matrix: number[][], rhs: number[]): number[] | null {
	const n = rhs.length;
	if (matrix.length !== n) return null;

	// Flat scratch buffers (row-major).
	const a = new Float64Array(n * n);
	const b = new Float64Array(n);

	for (let i = 0; i < n; i++) {
		const row = matrix[i];
		if (row.length !== n) return null;
		const off = i * n;
		for (let j = 0; j < n; j++) a[off + j] = row[j];
		b[i] = rhs[i];
	}

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
			// Swap rows in flat buffer.
			const pOff = pivot * n;
			const mOff = maxRow * n;
			for (let j = 0; j < n; j++) {
				const tmp = a[pOff + j]; a[pOff + j] = a[mOff + j]; a[mOff + j] = tmp;
			}
			const tmp = b[pivot]; b[pivot] = b[maxRow]; b[maxRow] = tmp;
		}

		const pivotOff = pivot * n;
		const pivotVal = a[pivotOff + pivot];
		for (let row = pivot + 1; row < n; row++) {
			const rowOff = row * n;
			const factor = a[rowOff + pivot] / pivotVal;
			if (factor === 0) continue;
			for (let col = pivot; col < n; col++) {
				a[rowOff + col] -= factor * a[pivotOff + col];
			}
			b[row] -= factor * b[pivot];
		}
	}

	// Back-substitution.
	const x = new Float64Array(n);
	for (let row = n - 1; row >= 0; row--) {
		let sum = b[row];
		const rowOff = row * n;
		for (let col = row + 1; col < n; col++) sum -= a[rowOff + col] * x[col];
		x[row] = sum / a[rowOff + row];
	}

	// Return as plain number[] to match existing call sites.
	return Array.from(x);
}
