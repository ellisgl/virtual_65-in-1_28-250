/**
 * Sparse LU factorization for Modified Nodal Analysis (MNA) matrices.
 *
 * ## Two-phase approach
 *
 * 1. analyzePattern()      Symbolic phase — O(N³), run once per compiled netlist.
 *                          Propagates fill-in and records which (i,j) positions are
 *                          non-zero in L and U, and in what order to visit them.
 *
 * 2. numericFactor()       Numeric phase — O(nnz × fill), run every Newton step.
 *                          Only touches positions recorded in phase 1.
 *
 * 3. sparseSolveInPlace()  Forward + backward substitution — O(nnz).
 *
 * ## No pivoting
 * MNA matrices are diagonally dominant via gmin regularisation (every diagonal
 * carries at least gmin ≈ 1e-9 S from every node).  Partial pivoting is not
 * needed, so the pattern computed in phase 1 stays valid for the lifetime of the
 * compiled netlist.  If a diagonal falls below PIVOT_THRESHOLD (indicating a
 * genuinely singular system), numericFactor returns false and the caller can
 * fall back to the dense solver.
 *
 * ## Speedup
 * For a 30-node circuit at ~8 % density the dense O(N³) kernel executes ~27 k
 * floating-point operations.  The sparse kernel executes ~3–5 k, yielding a
 * 5–9× reduction in inner-loop work — the dominant cost at audio sample rate.
 */

import type { SparseLUPattern } from '$lib/types';

export type { SparseLUPattern };

/**
 * Greedy Minimum Degree elimination ordering.
 *
 * Sparse LU fill-in is minimised when low-degree rows are eliminated first.
 * At each step, picks the non-eliminated row with the fewest off-diagonal
 * non-zeros, "eliminates" it (which adds fill edges between its neighbours,
 * exactly mirroring what LU factorisation would produce), and repeats.
 *
 * For our small MNA matrices (size ≤ ~40) this O(n²·degree) implementation is
 * well under 1 ms per compile and is run once.  Returns a permutation
 * `order[k] = i` meaning "eliminate row i at step k".  Apply by relocating
 * the rows so the new row order matches the elimination order.
 *
 * @param n          Matrix dimension.
 * @param edges      Iterable of [i, j] pairs with i ≠ j and 0 ≤ i,j < n.
 *                   Both directions of each undirected edge are taken into
 *                   account internally; you can pass each edge once or twice
 *                   — duplicates are deduplicated by the Set.
 */
export function minimumDegreeOrder(
    n: number,
    edges: Iterable<readonly [number, number]>,
): Int32Array {
    const adj: Set<number>[] = new Array(n);
    for (let i = 0; i < n; i++) adj[i] = new Set();
    for (const [i, j] of edges) {
        if (i === j || i < 0 || j < 0 || i >= n || j >= n) continue;
        adj[i].add(j);
        adj[j].add(i);
    }

    const order = new Int32Array(n);
    const eliminated = new Uint8Array(n);
    for (let step = 0; step < n; step++) {
        // Find the non-eliminated row with the lowest degree.  Ties broken by
        // lowest index for determinism.
        let best = -1;
        let bestDeg = Infinity;
        for (let i = 0; i < n; i++) {
            if (eliminated[i]) continue;
            const d = adj[i].size;
            if (d < bestDeg) { bestDeg = d; best = i; }
        }
        if (best < 0) break; // should not happen, but defensive
        order[step] = best;
        eliminated[best] = 1;

        // Mark fill edges: every pair of still-active neighbours of `best`
        // becomes connected after elimination, mirroring LU fill-in.
        const neighbours: number[] = [];
        adj[best].forEach((j) => { if (!eliminated[j]) neighbours.push(j); });
        for (let a = 0; a < neighbours.length; a++) {
            const i = neighbours[a];
            adj[i].delete(best);
            for (let b = 0; b < neighbours.length; b++) {
                if (a !== b) adj[i].add(neighbours[b]);
            }
        }
    }
    return order;
}

const PIVOT_THRESHOLD = 1e-14;

/**
 * Build a SparseLUPattern from a boolean occupancy marker.
 *
 * @param marker  Uint8Array of length n², marker[i*n+j] = 1 means (i,j) can be non-zero.
 * @param n       Matrix dimension.
 */
export function analyzePattern(marker: Uint8Array, n: number): SparseLUPattern {
    // ── Symbolic elimination: propagate fill-in ──────────────────────────────
    // For each pivot column k, every row i that has a non-zero in column k will
    // receive fill-in at all positions (i,j) where U[k,j] ≠ 0 and j > k.
    // After this loop `fill` is the complete structural pattern of L + U.
    const fill = new Uint8Array(marker); // copy; grows with fill-in

    for (let k = 0; k < n; k++) {
        for (let i = k + 1; i < n; i++) {
            if (!fill[i * n + k]) continue; // row i does not touch column k
            for (let j = k + 1; j < n; j++) {
                if (fill[k * n + j]) fill[i * n + j] = 1; // fill at (i,j)
            }
        }
    }

    // ── Build per-pivot access lists ─────────────────────────────────────────
    // Pre-compute the exact set of operations needed for each pivot step so the
    // numeric phase loops over Int32Arrays without any conditional branching.
    const lCols:          Int32Array[] = new Array(n);
    const uRows:          Int32Array[] = new Array(n);
    const rankOneUpdates: Int32Array[] = new Array(n);

    for (let k = 0; k < n; k++) {
        // L column k — rows strictly below the diagonal that are in the fill pattern.
        const lRows: number[] = [];
        for (let i = k + 1; i < n; i++) {
            if (fill[i * n + k]) lRows.push(i);
        }
        lCols[k] = new Int32Array(lRows);

        // U row k — columns strictly to the right of the diagonal.
        const uCols: number[] = [];
        for (let j = k + 1; j < n; j++) {
            if (fill[k * n + j]) uCols.push(j);
        }
        uRows[k] = new Int32Array(uCols);

        // Rank-1 update pairs — (i,j) pairs where A[i,j] -= L[i,k]*U[k,j].
        // Stored flat as [i₀,j₀, i₁,j₁, …] for tight cache access.
        const upds: number[] = [];
        for (const i of lRows) {
            for (const j of uCols) {
                if (fill[i * n + j]) upds.push(i, j);
            }
        }
        rankOneUpdates[k] = new Int32Array(upds);
    }

    return { n, lCols, uRows, rankOneUpdates };
}

/**
 * Numeric LU factorization in-place using the precomputed symbolic pattern.
 *
 * On entry:  mat[i*n+j] = A[i][j]  (row-major, size n×n)
 * On return: lower triangle stores L (unit diagonal not written),
 *            upper triangle and diagonal store U.
 *
 * Returns true on success, false if a pivot falls below PIVOT_THRESHOLD.
 */
export function numericFactor(mat: Float64Array, n: number, pat: SparseLUPattern): boolean {
    for (let k = 0; k < n; k++) {
        const ukk = mat[k * n + k];
        if (Math.abs(ukk) < PIVOT_THRESHOLD) return false;
        const inv = 1.0 / ukk;

        // Scale the L column: L[i,k] = A[i,k] / U[k,k]
        const lc = pat.lCols[k];
        const lcLen = lc.length;
        for (let p = 0; p < lcLen; p++) {
            mat[lc[p] * n + k] *= inv;
        }

        // Rank-1 update: A[i,j] -= L[i,k] * U[k,j] for every recorded (i,j) pair.
        // The pairs are stored flat as [i₀,j₀, i₁,j₁, …] for sequential access.
        const upd = pat.rankOneUpdates[k];
        const updLen = upd.length;
        const kRow = k * n; // base offset for row k — avoid multiplying twice
        for (let p = 0; p < updLen; p += 2) {
            const i = upd[p];
            const j = upd[p + 1];
            mat[i * n + j] -= mat[i * n + k] * mat[kRow + j];
        }
    }
    return true;
}

/**
 * Solve (L·U)·x = rhs using an already factorized matrix.
 * The solution x overwrites rhs on return.
 *
 * @param mat  n×n row-major matrix containing L (lower) and U (upper+diag) from numericFactor().
 * @param rhs  Right-hand side on entry; solution on return.
 * @param n    Matrix dimension.
 * @param pat  The symbolic pattern from analyzePattern().
 */
export function sparseSolveInPlace(
    mat:  Float64Array,
    rhs:  Float64Array,
    n:    number,
    pat:  SparseLUPattern,
): void {
    // Forward substitution: L · y = b   (L is unit lower triangular)
    for (let k = 0; k < n; k++) {
        const yk = rhs[k];
        if (yk === 0.0) continue; // sparse RHS — skip zero entries for free
        const lc = pat.lCols[k];
        const lcLen = lc.length;
        for (let p = 0; p < lcLen; p++) {
            rhs[lc[p]] -= mat[lc[p] * n + k] * yk;
        }
    }

    // Backward substitution: U · x = y
    for (let k = n - 1; k >= 0; k--) {
        let s = rhs[k];
        const ur = pat.uRows[k];
        const urLen = ur.length;
        const kRow = k * n;
        for (let p = 0; p < urLen; p++) {
            s -= mat[kRow + ur[p]] * rhs[ur[p]];
        }
        rhs[k] = s / mat[kRow + k];
    }
}
