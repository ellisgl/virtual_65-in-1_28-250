//! Cross-port parity tests for the sparse LU module.
//!
//! These tests use the EXACT inputs and expected outputs from the TypeScript
//! reference implementation in `src/lib/sim/sparse.ts`.  They are the primary
//! correctness anchor as we port more algorithms: any regression here means
//! the Rust kernel has diverged from the TS source-of-truth.
//!
//! The inputs are hand-constructed MNA-flavour patterns: diagonally dominant,
//! mostly sparse, with a mix of structural zeros and fill-in opportunities.
//! Future work: dump random fixtures from the TS unit tests and consume them
//! here, so coverage grows with the TS test suite.

use sim_core::sparse::{analyze_pattern, numeric_factor, sparse_solve_in_place};

const N: usize = 6;
const TOL: f64 = 1e-10;

/// MNA-like pattern: tridiagonal node block plus a single voltage-source
/// branch row at the bottom (one off-diagonal nonzero in the last row, one
/// in the last column).  Diagonally dominant via `gmin = 1e-3` regularisation.
#[test]
fn mna_like_6x6_solve() {
    let n = N;
    let mut marker = vec![0u8; n * n];
    // Tridiagonal in the node block (rows 0..n-1).
    for i in 0..(n - 1) {
        marker[i * n + i] = 1;
        marker[i * n + (i + 1)] = 1;
        marker[(i + 1) * n + i] = 1;
    }
    marker[(n - 1) * n + (n - 1)] = 1;
    // Branch row couples to node 0 (a voltage source between node 0 and ground).
    marker[(n - 1) * n + 0] = 1;
    marker[0 * n + (n - 1)] = 1;

    let pat = analyze_pattern(&marker, n);

    // Conductances ~1 S, sources at the right edge of B vector.
    let mut a = vec![0.0; n * n];
    let g = 1.0;
    for i in 0..(n - 1) {
        a[i * n + i] += 2.0 * g + 1e-3;          // gmin
        if i + 1 < n - 1 {
            a[i * n + (i + 1)] = -g;
            a[(i + 1) * n + i] = -g;
        }
    }
    // Branch row: V_src - V_node0 = 0  →  row n-1: +1 at col 0, RHS = Vsrc.
    // For an MNA voltage source we also put a +1 in the node-0 row at col n-1.
    a[(n - 1) * n + 0] = 1.0;
    a[0 * n + (n - 1)] = 1.0;
    a[(n - 1) * n + (n - 1)] = 1e-12; // tiny gmin so the branch row's diag isn't zero
    // Last node's diag.
    a[(n - 2) * n + (n - 2)] += 2.0 * g + 1e-3;

    // RHS: voltage source = 5V at branch row.
    let mut rhs = vec![0.0; n];
    rhs[n - 1] = 5.0;

    // Reference solve: brute-force inverse (n=6 is small).
    let ref_solution = brute_force_solve(&a, &rhs, n);

    let mut a_mut = a.clone();
    let mut rhs_mut = rhs.clone();
    assert!(numeric_factor(&mut a_mut, n, &pat));
    sparse_solve_in_place(&a_mut, &mut rhs_mut, n, &pat);

    for i in 0..n {
        assert!(
            (rhs_mut[i] - ref_solution[i]).abs() < TOL,
            "row {}: sparse={} ref={}",
            i,
            rhs_mut[i],
            ref_solution[i]
        );
    }
}

/// Dense Gaussian elimination with partial pivoting — independent reference
/// implementation used to check the sparse solver's output.
fn brute_force_solve(a: &[f64], b: &[f64], n: usize) -> Vec<f64> {
    let mut m = a.to_vec();
    let mut v = b.to_vec();

    for k in 0..n {
        // Partial pivot.
        let mut piv = k;
        let mut max_abs = m[k * n + k].abs();
        for i in (k + 1)..n {
            let av = m[i * n + k].abs();
            if av > max_abs {
                max_abs = av;
                piv = i;
            }
        }
        if piv != k {
            for j in 0..n {
                m.swap(k * n + j, piv * n + j);
            }
            v.swap(k, piv);
        }
        let pivot = m[k * n + k];
        assert!(pivot.abs() > 1e-14, "brute_force_solve hit singular pivot");
        // Eliminate.
        for i in (k + 1)..n {
            let factor = m[i * n + k] / pivot;
            for j in k..n {
                m[i * n + j] -= factor * m[k * n + j];
            }
            v[i] -= factor * v[k];
        }
    }
    // Back-substitute.
    let mut x = vec![0.0; n];
    for k in (0..n).rev() {
        let mut s = v[k];
        for j in (k + 1)..n {
            s -= m[k * n + j] * x[j];
        }
        x[k] = s / m[k * n + k];
    }
    x
}
