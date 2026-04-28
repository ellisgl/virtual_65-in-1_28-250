export function solveLinearSystem(matrix: number[][], rhs: number[]): number[] | null {
	const n = rhs.length;
	if (matrix.length !== n || matrix.some((row) => row.length !== n)) return null;

	const a = matrix.map((row) => [...row]);
	const b = [...rhs];

	for (let pivot = 0; pivot < n; pivot++) {
		let maxRow = pivot;
		let maxVal = Math.abs(a[pivot][pivot]);

		for (let row = pivot + 1; row < n; row++) {
			const val = Math.abs(a[row][pivot]);
			if (val > maxVal) {
				maxVal = val;
				maxRow = row;
			}
		}

		if (maxVal < 1e-12) return null;

		if (maxRow !== pivot) {
			[a[pivot], a[maxRow]] = [a[maxRow], a[pivot]];
			[b[pivot], b[maxRow]] = [b[maxRow], b[pivot]];
		}

		for (let row = pivot + 1; row < n; row++) {
			const factor = a[row][pivot] / a[pivot][pivot];
			if (factor === 0) continue;
			for (let col = pivot; col < n; col++) {
				a[row][col] -= factor * a[pivot][col];
			}
			b[row] -= factor * b[pivot];
		}
	}

	const x = new Array(n).fill(0);
	for (let row = n - 1; row >= 0; row--) {
		let sum = b[row];
		for (let col = row + 1; col < n; col++) {
			sum -= a[row][col] * x[col];
		}
		x[row] = sum / a[row][row];
	}

	return x;
}

