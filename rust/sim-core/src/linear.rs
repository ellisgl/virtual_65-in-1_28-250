//! Dense Gaussian elimination with partial pivoting.
//!
//! Used as a fallback by the Newton solver when the sparse LU detects a
//! singular pivot.  Same algorithm as `src/lib/sim/linear.ts` — partial
//! pivoting, in-place factorisation, forward + backward substitution.
//!
//! Performance is intentionally not optimised: this path runs only when
//! the sparse LU has failed, which should never happen on a well-formed
//! MNA matrix with gmin regularisation.  The point is correctness as a
//! safety net, not speed.

/// Solve `A x = b` for `x`, returning `Some(x)` on success or `None` if
/// the matrix is numerically singular (pivot below threshold even after
/// partial pivoting).
///
/// `mat` is `n*n` row-major and is consumed (mutated in place).  `rhs` is
/// length `n` and is also consumed.  Result is a freshly-allocated `Vec`
/// of length `n`.
pub fn solve_linear_system(mat: &mut [f64], rhs: &mut [f64], n: usize) -> Option<Vec<f64>> {
    debug_assert_eq!(mat.len(), n * n);
    debug_assert_eq!(rhs.len(), n);

    const PIVOT_THRESHOLD: f64 = 1e-14;

    for k in 0..n {
        // Partial pivot — find the row with the largest abs value in column k.
        let mut piv = k;
        let mut max_abs = mat[k * n + k].abs();
        for i in (k + 1)..n {
            let av = mat[i * n + k].abs();
            if av > max_abs {
                max_abs = av;
                piv = i;
            }
        }
        if max_abs < PIVOT_THRESHOLD {
            return None;
        }
        if piv != k {
            for j in 0..n {
                mat.swap(k * n + j, piv * n + j);
            }
            rhs.swap(k, piv);
        }
        let pivot = mat[k * n + k];
        let inv = 1.0 / pivot;
        for i in (k + 1)..n {
            let factor = mat[i * n + k] * inv;
            for j in k..n {
                mat[i * n + j] -= factor * mat[k * n + j];
            }
            rhs[i] -= factor * rhs[k];
        }
    }

    // Back substitution.
    let mut x = vec![0.0; n];
    for k in (0..n).rev() {
        let mut s = rhs[k];
        for j in (k + 1)..n {
            s -= mat[k * n + j] * x[j];
        }
        x[k] = s / mat[k * n + k];
    }
    Some(x)
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn solve_3x3_known_answer() {
        // Same system as sparse::tests::lu_factor_and_solve_3x3.
        let mut mat = vec![4.0, 1.0, 0.0,
                           1.0, 3.0, 1.0,
                           0.0, 1.0, 2.0];
        let mut rhs = vec![5.0, 6.0, 4.0];
        let x = solve_linear_system(&mut mat, &mut rhs, 3).unwrap();
        assert_relative_eq!(x[0], 17.0 / 18.0, epsilon = 1e-12);
        assert_relative_eq!(x[1], 11.0 / 9.0,  epsilon = 1e-12);
        assert_relative_eq!(x[2], 25.0 / 18.0, epsilon = 1e-12);
    }

    #[test]
    fn singular_returns_none() {
        let mut mat = vec![0.0, 1.0,
                           0.0, 1.0];
        let mut rhs = vec![1.0, 1.0];
        assert!(solve_linear_system(&mut mat, &mut rhs, 2).is_none());
    }

    #[test]
    fn pivot_swap_works() {
        // Matrix where pivoting is mandatory — the natural pivot is 0.
        let mut mat = vec![0.0, 1.0, 1.0,
                           1.0, 1.0, 0.0,
                           1.0, 0.0, 1.0];
        let mut rhs = vec![3.0, 2.0, 2.0];
        // Solution: subtract eqs to get x=0, y=2, z=1? Let's verify.
        // Row 0: 0*x + 1*y + 1*z = 3
        // Row 1: 1*x + 1*y + 0*z = 2
        // Row 2: 1*x + 0*y + 1*z = 2
        // From rows 1,2: x = 2 - y, x = 2 - z → y = z.
        // Row 0: y + z = 3 → 2y = 3 → y = z = 1.5; x = 0.5.
        let x = solve_linear_system(&mut mat, &mut rhs, 3).unwrap();
        assert_relative_eq!(x[0], 0.5, epsilon = 1e-12);
        assert_relative_eq!(x[1], 1.5, epsilon = 1e-12);
        assert_relative_eq!(x[2], 1.5, epsilon = 1e-12);
    }
}
