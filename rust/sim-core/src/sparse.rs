//! Sparse LU factorization for MNA matrices.
//!
//! Mirrors `src/lib/sim/sparse.ts` 1-to-1.  Algorithm notes are in the TS
//! file; this file is the Rust port.  Each public function has a matching
//! TS unit test target in the existing codebase that the Rust tests check
//! against (see `tests/parity.rs` for the cross-check vectors).
//!
//! Performance notes
//! -----------------
//! - All inner loops index into preallocated buffers; no allocations in the
//!   numeric kernel.
//! - `numericFactor` and `sparseSolveInPlace` borrow the matrix mutably/
//!   immutably so the caller controls the buffer.  No internal scratch.
//! - We deliberately use safe indexing for the first port.  If profiling
//!   shows bounds-check overhead dominates, we can switch to
//!   `get_unchecked` in the hot loops — same approach as the TS version
//!   which uses plain `arr[i]` rather than `arr.at(i)`.

const PIVOT_THRESHOLD: f64 = 1e-14;

/// Symbolic pattern for the sparse LU factorization.
///
/// `l_cols[k]` is the set of row indices `i > k` for which `L[i,k]` is
/// structurally non-zero.  `u_rows[k]` is the set of column indices
/// `j > k` for which `U[k,j]` is structurally non-zero.  `rank_one_updates[k]`
/// is the flat list of `(i,j)` pairs where `A[i,j] -= L[i,k]*U[k,j]` is
/// performed — stored as `[i0,j0,i1,j1,…]` for sequential access.
#[derive(Debug, Clone)]
pub struct SparseLuPattern {
    pub n: usize,
    pub l_cols: Vec<Box<[i32]>>,
    pub u_rows: Vec<Box<[i32]>>,
    pub rank_one_updates: Vec<Box<[i32]>>,
}

/// Build a `SparseLuPattern` from a boolean occupancy marker.
///
/// `marker` must be of length `n*n`.  `marker[i*n+j] != 0` means position
/// `(i,j)` may carry a non-zero value at any point in the factorization;
/// the symbolic phase here propagates additional fill-in.
///
/// Panics if `marker.len() != n*n`.
pub fn analyze_pattern(marker: &[u8], n: usize) -> SparseLuPattern {
    assert_eq!(marker.len(), n * n, "marker length must equal n*n");

    // Symbolic elimination: propagate fill-in.  After this loop `fill` is
    // the complete structural pattern of L + U.
    let mut fill: Vec<u8> = marker.to_vec();
    for k in 0..n {
        for i in (k + 1)..n {
            if fill[i * n + k] == 0 {
                continue;
            }
            for j in (k + 1)..n {
                if fill[k * n + j] != 0 {
                    fill[i * n + j] = 1;
                }
            }
        }
    }

    // Build per-pivot access lists.
    let mut l_cols: Vec<Box<[i32]>> = Vec::with_capacity(n);
    let mut u_rows: Vec<Box<[i32]>> = Vec::with_capacity(n);
    let mut rank_one_updates: Vec<Box<[i32]>> = Vec::with_capacity(n);

    for k in 0..n {
        // L column k — rows strictly below the diagonal in the fill pattern.
        let mut l_rows_k: Vec<i32> = Vec::new();
        for i in (k + 1)..n {
            if fill[i * n + k] != 0 {
                l_rows_k.push(i as i32);
            }
        }

        // U row k — columns strictly to the right of the diagonal.
        let mut u_cols_k: Vec<i32> = Vec::new();
        for j in (k + 1)..n {
            if fill[k * n + j] != 0 {
                u_cols_k.push(j as i32);
            }
        }

        // Rank-1 update pairs: A[i,j] -= L[i,k]*U[k,j] for fill positions.
        let mut updates_k: Vec<i32> = Vec::new();
        for &i in &l_rows_k {
            for &j in &u_cols_k {
                if fill[(i as usize) * n + (j as usize)] != 0 {
                    updates_k.push(i);
                    updates_k.push(j);
                }
            }
        }

        l_cols.push(l_rows_k.into_boxed_slice());
        u_rows.push(u_cols_k.into_boxed_slice());
        rank_one_updates.push(updates_k.into_boxed_slice());
    }

    SparseLuPattern { n, l_cols, u_rows, rank_one_updates }
}

/// Numeric LU factorization in place using a precomputed symbolic pattern.
///
/// On entry  `mat[i*n+j] = A[i][j]` (row-major, n×n).
/// On return  the lower triangle stores L (unit diagonal not written),
/// and the upper triangle + diagonal store U.
///
/// Returns `true` on success, `false` if a pivot fell below `PIVOT_THRESHOLD`
/// (indicating a numerically singular matrix — caller should fall back to a
/// pivoting solver).
pub fn numeric_factor(mat: &mut [f64], n: usize, pat: &SparseLuPattern) -> bool {
    debug_assert_eq!(mat.len(), n * n);
    debug_assert_eq!(pat.n, n);

    for k in 0..n {
        let ukk = mat[k * n + k];
        if ukk.abs() < PIVOT_THRESHOLD {
            return false;
        }
        let inv = 1.0 / ukk;

        // Scale the L column: L[i,k] = A[i,k] / U[k,k]
        for &i in pat.l_cols[k].iter() {
            mat[(i as usize) * n + k] *= inv;
        }

        // Rank-1 update: A[i,j] -= L[i,k] * U[k,j] for every recorded pair.
        let upd = &pat.rank_one_updates[k];
        let k_row = k * n;
        let mut p = 0;
        while p < upd.len() {
            let i = upd[p] as usize;
            let j = upd[p + 1] as usize;
            // mat[i,j] -= mat[i,k] * mat[k,j]
            let lik = mat[i * n + k];
            let ukj = mat[k_row + j];
            mat[i * n + j] -= lik * ukj;
            p += 2;
        }
    }
    true
}

/// Solve `(L * U) * x = rhs` using a matrix already factored by
/// `numeric_factor`.  The solution `x` overwrites `rhs` on return.
pub fn sparse_solve_in_place(
    mat: &[f64],
    rhs: &mut [f64],
    n: usize,
    pat: &SparseLuPattern,
) {
    debug_assert_eq!(mat.len(), n * n);
    debug_assert_eq!(rhs.len(), n);
    debug_assert_eq!(pat.n, n);

    // Forward substitution: L · y = b   (L is unit lower triangular)
    for k in 0..n {
        let yk = rhs[k];
        if yk == 0.0 {
            continue; // sparse RHS — skip zero entries for free
        }
        for &i in pat.l_cols[k].iter() {
            let i = i as usize;
            rhs[i] -= mat[i * n + k] * yk;
        }
    }

    // Backward substitution: U · x = y
    for k in (0..n).rev() {
        let mut s = rhs[k];
        let k_row = k * n;
        for &j in pat.u_rows[k].iter() {
            let j = j as usize;
            s -= mat[k_row + j] * rhs[j];
        }
        rhs[k] = s / mat[k_row + k];
    }
}

/// Greedy Minimum Degree elimination ordering.
///
/// Returns `order[k] = i` meaning "eliminate row `i` at step `k`".  The caller
/// applies the permutation by relocating rows so the new ordering matches
/// the elimination order.
///
/// Sparse LU fill-in is minimised when low-degree rows are eliminated first.
/// At each step we pick the non-eliminated row with the fewest off-diagonal
/// non-zeros, eliminate it (which adds fill edges between its neighbours,
/// mirroring what LU factorisation would produce), and repeat.
///
/// `edges` is an iterator of `(i, j)` pairs with `0 <= i, j < n`.  The graph
/// is treated as undirected; duplicates and self-loops are filtered.
///
/// Complexity: O(n² · avg_degree) — adequate for the n ≤ 40 matrices we use
/// at compile time.
pub fn minimum_degree_order<I>(n: usize, edges: I) -> Box<[i32]>
where
    I: IntoIterator<Item = (usize, usize)>,
{
    // Build adjacency.  std::collections::BTreeSet keeps the inner ordering
    // deterministic so ties break by lowest index identically to the TS port
    // (which uses Set + index order).
    use std::collections::BTreeSet;
    let mut adj: Vec<BTreeSet<usize>> = (0..n).map(|_| BTreeSet::new()).collect();
    for (i, j) in edges {
        if i == j || i >= n || j >= n {
            continue;
        }
        adj[i].insert(j);
        adj[j].insert(i);
    }

    let mut order = vec![0i32; n].into_boxed_slice();
    let mut eliminated = vec![false; n];

    for step in 0..n {
        // Find the non-eliminated row with the lowest degree.  Ties broken
        // by lowest index for determinism.
        let mut best: Option<usize> = None;
        let mut best_deg: usize = usize::MAX;
        for i in 0..n {
            if eliminated[i] {
                continue;
            }
            let d = adj[i].len();
            if d < best_deg {
                best_deg = d;
                best = Some(i);
            }
        }
        let Some(best) = best else { break };
        order[step] = best as i32;
        eliminated[best] = true;

        // Collect still-active neighbours, then mark fill edges between
        // every pair of them.  Taking a snapshot first avoids mutating
        // a set we're iterating.
        let neighbours: Vec<usize> = adj[best]
            .iter()
            .copied()
            .filter(|&j| !eliminated[j])
            .collect();
        // Remove `best` from each neighbour's set, then connect neighbours
        // pairwise.
        for &i in &neighbours {
            adj[i].remove(&best);
        }
        for a in 0..neighbours.len() {
            let i = neighbours[a];
            for b in 0..neighbours.len() {
                if a != b {
                    adj[i].insert(neighbours[b]);
                }
            }
        }
    }

    order
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    /// Solve a 3×3 system Ax = b, verify against a known-good answer.
    /// Same numbers used in TS unit tests for parity.
    #[test]
    fn lu_factor_and_solve_3x3() {
        // A = [[ 4, 1, 0 ],
        //      [ 1, 3, 1 ],
        //      [ 0, 1, 2 ]]
        // b = [ 5, 6, 4 ]
        // Solved by hand: x = [17/18, 11/9, 25/18].
        let n = 3;
        let mut marker = vec![0u8; n * n];
        for i in 0..n {
            for j in 0..n {
                marker[i * n + j] = 1;
            }
        }
        let pat = analyze_pattern(&marker, n);

        let mut mat = vec![4.0, 1.0, 0.0,
                           1.0, 3.0, 1.0,
                           0.0, 1.0, 2.0];
        let mut rhs = vec![5.0, 6.0, 4.0];

        assert!(numeric_factor(&mut mat, n, &pat));
        sparse_solve_in_place(&mat, &mut rhs, n, &pat);

        assert_relative_eq!(rhs[0], 17.0 / 18.0, epsilon = 1e-12);
        assert_relative_eq!(rhs[1], 11.0 / 9.0,  epsilon = 1e-12);
        assert_relative_eq!(rhs[2], 25.0 / 18.0, epsilon = 1e-12);
    }

    /// Singular system — pivot below threshold, should report failure.
    #[test]
    fn singular_matrix_returns_false() {
        let n = 2;
        let marker = vec![1u8; n * n];
        let pat = analyze_pattern(&marker, n);

        // A = [[0, 1], [0, 1]]  — rank 1, singular.
        let mut mat = vec![0.0, 1.0,
                           0.0, 1.0];
        assert!(!numeric_factor(&mut mat, n, &pat));
    }

    /// Sparse arrow matrix — diagonal plus first row plus first column.
    /// This is the worst case for naive LU (full fill) but the symbolic
    /// phase should detect the actual pattern correctly.
    #[test]
    fn arrow_matrix_5x5() {
        let n = 5;
        let mut marker = vec![0u8; n * n];
        for i in 0..n {
            marker[i * n + i] = 1;       // diagonal
            marker[0 * n + i] = 1;       // first row
            marker[i * n + 0] = 1;       // first column
        }
        let pat = analyze_pattern(&marker, n);

        // Build a well-conditioned arrow matrix.
        let mut mat = vec![0.0; n * n];
        for i in 0..n { mat[i * n + i] = 5.0 + i as f64; }
        for i in 1..n {
            mat[0 * n + i] = 1.0;
            mat[i * n + 0] = 1.0;
        }
        // Reference solution: pick x = [1,2,3,4,5], compute b = A·x.
        let x_ref = [1.0, 2.0, 3.0, 4.0, 5.0];
        let mut rhs = vec![0.0; n];
        for i in 0..n {
            for j in 0..n {
                rhs[i] += mat[i * n + j] * x_ref[j];
            }
        }

        assert!(numeric_factor(&mut mat, n, &pat));
        sparse_solve_in_place(&mat, &mut rhs, n, &pat);
        for i in 0..n {
            assert_relative_eq!(rhs[i], x_ref[i], epsilon = 1e-10);
        }
    }

    /// Minimum-degree ordering of a path graph: 0 — 1 — 2 — 3 — 4.
    /// Endpoints (0 and 4) have degree 1, should be eliminated first.
    #[test]
    fn md_path_graph_5() {
        let edges = vec![(0, 1), (1, 2), (2, 3), (3, 4)];
        let order = minimum_degree_order(5, edges);
        // First eliminated: a degree-1 node (0 or 4 — tie broken to lowest index → 0).
        assert_eq!(order[0], 0);
        // After 0 is eliminated, 4 still has degree 1 (only 3) → eliminated next.
        // Actually after eliminating 0, the graph is 1—2—3—4; degrees: 1→1, 2→2, 3→2, 4→1.
        // Tie 1 vs 4, lowest index wins → 1.
        assert_eq!(order[1], 1);
    }

    /// MD on a complete graph K3: every node has degree 2, tie-break by
    /// index → eliminate in order 0, 1, 2.
    #[test]
    fn md_complete_graph_3() {
        let edges = vec![(0, 1), (1, 2), (0, 2)];
        let order = minimum_degree_order(3, edges);
        assert_eq!(order[0], 0);
        assert_eq!(order[1], 1);
        assert_eq!(order[2], 2);
    }

    /// Self-loops and out-of-range indices must be filtered, not panic.
    #[test]
    fn md_filters_invalid_edges() {
        let edges = vec![(0, 0), (1, 999), (0, 1)];
        let order = minimum_degree_order(2, edges);
        // Only valid edge is (0,1); both nodes have degree 1; order = [0, 1].
        assert_eq!(order[0], 0);
        assert_eq!(order[1], 1);
    }
}
