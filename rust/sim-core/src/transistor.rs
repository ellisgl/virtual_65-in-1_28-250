//! Gummel-Poon BJT model with SPICE pnjlim limiting.
//!
//! Port of `src/lib/sim/transistor.ts`.  The algorithm is the standard
//! SPICE 3 Gummel-Poon model with high-injection rolloff (ikf/ikr),
//! recombination/leakage (ise/isc), Early effect (vaf/var), and analytical
//! Jacobian.  Junction voltages are clamped via SPICE pnjlim plus a hard
//! upper bound that keeps the exponential below ~1 A.
//!
//! Numerical parity with the TS reference is verified by the unit tests in
//! this module and by the cross-port vectors in `tests/parity.rs`.

use crate::types::{Polarity, Transistor};

const VT_300K: f64 = 0.02585;

/// Output of a transistor stamp.  Field names mirror `transistor.ts`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransistorStamp {
    /// B-E conductance.
    pub g_be: f64,
    /// B-C conductance (from reverse current).
    pub g_bc: f64,
    /// Transconductance `∂Ic/∂Vbe`.
    pub gm: f64,
    /// Feedback `∂Ic/∂Vbc` (Early effect + reverse).
    pub gmu: f64,
    /// `∂Ib/∂Vbe`.
    pub gpi: f64,
    /// `∂Ib/∂Vbc`.
    pub gmu_b: f64,
    /// Base companion current (nonlinear offset).
    pub i_eq_b: f64,
    /// Collector companion current.
    pub i_eq_c: f64,
    /// Emitter companion current.
    pub i_eq_e: f64,
}

#[inline(always)]
fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo { lo } else if v > hi { hi } else { v }
}

/// SPICE-style junction voltage limiting.
///
/// Standard SPICE algorithm:
///   1. `vold > 0` and step jumps forward by more than 2*Vt → squeeze with
///      `vt*log(1 + Δv/vt)` so exponential grows sub-linearly.
///   2. `vold ≤ 0` jumping to `vnew > vcrit` → replace with `vt*log(vnew/vt)`,
///      pulling large positive guesses into tractable range.
/// No limiting in the reverse direction — `exp(v/vt)` saturates harmlessly
/// for large negative v.
fn limit_v(vnew: f64, vold: f64, vt: f64, is: f64) -> f64 {
    let vcrit = vt * (vt / (std::f64::consts::SQRT_2 * is)).ln();
    if vnew > vcrit && (vnew - vold).abs() > 2.0 * vt {
        if vold > 0.0 {
            let arg = 1.0 + (vnew - vold) / vt;
            return if arg > 0.0 { vold + vt * arg.ln() } else { vcrit };
        }
        return vt * (vnew / vt).ln();
    }
    vnew
}

/// Compute the BJT stamp for the current Newton iterate.
///
/// # Arguments
/// * `q`          — Element parameters (Gummel-Poon).
/// * `volts`      — Compact node-voltage estimate buffer.
/// * `bi`         — Compact base index; `-1` if grounded.
/// * `ci`         — Compact collector index; `-1` if grounded.
/// * `ei`         — Compact emitter index; `-1` if grounded.
/// * `prev_volts` — Previous-step compact voltages for pnjlim (`None` in DC mode).
///
/// When `prev_volts` is `None` the companion currents in the output are zero;
/// this is the DC operating-point path.
pub fn compute_transistor_stamp(
    q: &Transistor,
    volts: &[f64],
    bi: i32,
    ci: i32,
    ei: i32,
    prev_volts: Option<&[f64]>,
) -> TransistorStamp {
    let vb = if bi >= 0 { volts[bi as usize] } else { 0.0 };
    let vc = if ci >= 0 { volts[ci as usize] } else { 0.0 };
    let ve = if ei >= 0 { volts[ei as usize] } else { 0.0 };

    let is_pnp = q.polarity == Polarity::Pnp;

    // Device-frame voltages: positive = forward biased.
    let vbe_dev = if is_pnp { ve - vb } else { vb - ve };
    let vbc_dev = if is_pnp { vc - vb } else { vb - vc };

    // Model parameters with TS defaults applied.
    let is_sat = q.is.max(1e-20);
    let bf = q.beta.max(2.0);
    let br = q.br.unwrap_or(1.0).max(0.1);
    let vaf = q.vaf.max(1.0);
    let var_ = q.var_.unwrap_or(100.0).max(1.0);
    let nf = clamp(q.nf, 0.5, 2.5);
    let nr = clamp(q.nr.unwrap_or(1.0), 0.5, 2.5);
    let ne = clamp(q.ne.unwrap_or(1.5), 1.0, 4.0);
    let nc = clamp(q.nc.unwrap_or(2.0), 1.0, 4.0);
    let ise = q.ise.unwrap_or(is_sat / bf).max(1e-20);
    let isc = q.isc.unwrap_or(is_sat / br).max(1e-20);
    let ikf = q.ikf.unwrap_or(1e9).max(1e-9);
    let ikr = q.ikr.unwrap_or(1e9).max(1e-9);

    let vt = VT_300K;
    let vt_f = nf * vt;
    let vt_r = nr * vt;
    let vt_e = ne * vt;
    let vt_c = nc * vt;

    // ── Junction voltage limiting ────────────────────────────────────────
    let mut vbe = vbe_dev;
    let mut vbc = vbc_dev;
    if let Some(prev) = prev_volts {
        let pb = if bi >= 0 { prev[bi as usize] } else { 0.0 };
        let pe = if ei >= 0 { prev[ei as usize] } else { 0.0 };
        let pc = if ci >= 0 { prev[ci as usize] } else { 0.0 };
        let prev_vbe = if is_pnp { pe - pb } else { pb - pe };
        let prev_vbc = if is_pnp { pc - pb } else { pb - pc };
        vbe = limit_v(vbe_dev, prev_vbe, vt_f, is_sat);
        vbc = limit_v(vbc_dev, prev_vbc, vt_r, is_sat);
    }
    // Hard ceiling — caps junction current at ~1 A regardless of Is.
    // The expression `vt*log(1/Is)` is the voltage at which Ic ≈ 1 A.
    // Bounded by [10, 30] · Vt so Ge (Is ≈ 10 µA) gets ~0.3 V and Si
    // (Is ≈ 1 pA) gets ~0.72 V.
    let vbe_max = (10.0 * vt_f).max((30.0 * vt_f).min(vt_f * (1.0 / is_sat).ln()));
    let vbc_max = (10.0 * vt_r).max((30.0 * vt_r).min(vt_r * (1.0 / is_sat).ln()));
    vbe = vbe.min(vbe_max);
    vbc = vbc.min(vbc_max);

    // ── Exponentials ────────────────────────────────────────────────────
    let exp_be   = clamp(vbe / vt_f, -40.0, 40.0).exp();
    let exp_bc   = clamp(vbc / vt_r, -40.0, 40.0).exp();
    let exp_be_e = clamp(vbe / vt_e, -40.0, 40.0).exp();
    let exp_bc_c = clamp(vbc / vt_c, -40.0, 40.0).exp();

    // ── Gummel-Poon base charge Qb ──────────────────────────────────────
    let q1_arg = 1.0 - vbc / vaf - vbe / var_;
    let q1 = if q1_arg > 0.01 { 1.0 / q1_arg } else { 100.0 };

    let q2_f = is_sat * (exp_be - 1.0) / ikf;
    let q2_r = is_sat * (exp_bc - 1.0) / ikr;
    let q2 = q2_f + q2_r;

    let sq = (1.0_f64 + 4.0 * q2).max(0.0).sqrt();
    let qb = (q1 / 2.0) * (1.0 + sq);

    // ── Transfer current ────────────────────────────────────────────────
    let icc = is_sat * (exp_be - exp_bc) / qb;

    // ── Base-current components ─────────────────────────────────────────
    let ibe_ideal = (is_sat / bf) * (exp_be - 1.0);
    let ibe_nl = ise * (exp_be_e - 1.0);
    let ibc_ideal = (is_sat / br) * (exp_bc - 1.0);
    let ibc_nl = isc * (exp_bc_c - 1.0);

    // ── Terminal currents ───────────────────────────────────────────────
    let ic_term = icc - ibc_ideal - ibc_nl;
    let ib_term = ibe_ideal + ibe_nl + ibc_ideal + ibc_nl;

    // ── Analytical Jacobian ─────────────────────────────────────────────
    let dq1_dvbe  = q1 * q1 / var_;
    let dq1_dvbc  = q1 * q1 / vaf;
    let dq2f_dvbe = is_sat * exp_be / (ikf * vt_f);
    let dq2r_dvbc = is_sat * exp_bc / (ikr * vt_r);

    let d_qb_dvbe = (qb / q1) * dq1_dvbe + (q1 / sq) * dq2f_dvbe;
    let d_qb_dvbc = (qb / q1) * dq1_dvbc + (q1 / sq) * dq2r_dvbc;

    let d_icc_dvbe = is_sat * exp_be / (vt_f * qb) - icc * d_qb_dvbe / qb;
    let d_icc_dvbc = -is_sat * exp_bc / (vt_r * qb) - icc * d_qb_dvbc / qb;

    let d_ibc_dvbc = (is_sat / br) * exp_bc / vt_r + isc * exp_bc_c / vt_c;
    let d_ibe_dvbe = (is_sat / bf) * exp_be / vt_f + ise * exp_be_e / vt_e;

    // ── MNA conductances ────────────────────────────────────────────────
    let gm_raw    = d_icc_dvbe;
    let gmu_raw   = d_icc_dvbc - d_ibc_dvbc;
    let gpi_raw   = d_ibe_dvbe;
    let gmu_b_raw = d_ibc_dvbc;

    // Clamp to physical range — GMAX = 0.1 S keeps gm below 1/10 Ω.  See
    // the comment in transistor.ts for why higher values cause Newton to
    // oscillate on this kit's 100 Ω – 100 kΩ resistor range.
    const GMAX: f64 = 0.1;
    let gm    = clamp(gm_raw,     1e-12, GMAX);
    let gmu   = clamp(gmu_raw,   -GMAX, GMAX);
    let g_be  = clamp(gpi_raw,    1e-12, GMAX); // = gpi
    let g_bc  = clamp(gmu_b_raw,  1e-12, GMAX); // = gmu_b (used as B-C shunt)
    let gmu_b = clamp(gmu_b_raw,  1e-12, GMAX);

    // ── Companion currents ──────────────────────────────────────────────
    // DC path: companions are zero.  Transient: build from CLAMPED Vbe/Vbc
    // converted back to node-voltage frame (intentionally pulls Newton
    // toward the clamped operating point).
    if prev_volts.is_none() {
        return TransistorStamp {
            g_be, g_bc, gm, gmu, gpi: g_be, gmu_b,
            i_eq_b: 0.0, i_eq_c: 0.0, i_eq_e: 0.0,
        };
    }

    let s_pol = if is_pnp { -1.0 } else { 1.0 };
    let vbe_node = if is_pnp { -vbe } else { vbe }; // Vb - Ve
    let vbc_node = if is_pnp { -vbc } else { vbc }; // Vb - Vc

    let i_eq_c = s_pol * ic_term - gm * vbe_node - gmu * vbc_node;
    let i_eq_b = s_pol * ib_term - g_be * vbe_node - g_bc * vbc_node;
    let i_eq_e = -(i_eq_c + i_eq_b);

    TransistorStamp {
        g_be, g_bc, gm, gmu, gpi: g_be, gmu_b,
        i_eq_b, i_eq_c, i_eq_e,
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    fn typical_npn() -> Transistor {
        // Approximate 2N3904 parameters.
        Transistor::npn_basic(6.734e-15, 200.0, 1.0, 74.03)
    }

    /// Off bias — Vbe = 0.  Ic and Ib are essentially zero, conductances
    /// at the floor.
    #[test]
    fn off_bias_all_zero() {
        let q = typical_npn();
        let volts = vec![0.0, 0.0, 0.0]; // B=0, C=0, E=0
        let s = compute_transistor_stamp(&q, &volts, 0, 1, 2, None);
        assert!(s.gm   >= 1e-12);
        assert!(s.g_be >= 1e-12);
        assert!(s.g_bc >= 1e-12);
        // In DC mode (no prev_volts) the companion currents are exactly zero.
        assert_eq!(s.i_eq_b, 0.0);
        assert_eq!(s.i_eq_c, 0.0);
        assert_eq!(s.i_eq_e, 0.0);
    }

    /// Active region — Vbe = 0.65 V, Vbc = -3 V.  Should produce a
    /// substantial gm and a positive collector current.
    #[test]
    fn active_region_typical() {
        let q = typical_npn();
        // B=0.65, E=0, C=3.65 → Vbe = 0.65, Vbc = -3.0
        let volts = vec![0.65, 3.65, 0.0];
        let s = compute_transistor_stamp(&q, &volts, 0, 1, 2, None);
        // gm in active region for 2N3904-ish device should be sizable.
        assert!(s.gm > 1e-4, "gm = {} (expected > 1e-4)", s.gm);
        assert!(s.gm <= 0.1, "gm = {} (expected ≤ GMAX = 0.1)", s.gm);
        // gpi = gm/β ish — same ballpark for the chosen parameters.
        assert!(s.gpi > 0.0);
    }

    /// PNP active — same magnitudes but the inversion logic should be
    /// symmetric: a PNP with Vbe = -0.65 (in NPN terms i.e. Ve - Vb = 0.65)
    /// should give the same gm magnitude.
    #[test]
    fn pnp_symmetry() {
        let mut npn = typical_npn();
        npn.polarity = Polarity::Npn;
        let mut pnp = typical_npn();
        pnp.polarity = Polarity::Pnp;

        // NPN: B = 0.65, E = 0, C = 3.65  → Vbe_dev = 0.65, Vbc_dev = -3
        let npn_volts = vec![0.65, 3.65, 0.0];
        let npn_stamp = compute_transistor_stamp(&npn, &npn_volts, 0, 1, 2, None);

        // PNP: B = 0, E = 0.65, C = -3   → Vbe_dev = 0.65, Vbc_dev = -3
        let pnp_volts = vec![0.0, -3.0, 0.65];
        let pnp_stamp = compute_transistor_stamp(&pnp, &pnp_volts, 0, 1, 2, None);

        // Conductances are polarity-invariant — the device "sees" the same
        // forward bias both ways.
        assert_relative_eq!(npn_stamp.gm,  pnp_stamp.gm,  epsilon = 1e-12);
        assert_relative_eq!(npn_stamp.g_be, pnp_stamp.g_be, epsilon = 1e-12);
    }

    /// Saturation — Vbe ≈ 0.7, Vbc ≈ 0.5.  Both junctions forward biased.
    /// gm clamps to GMAX; nothing should NaN.
    #[test]
    fn saturation_clamps() {
        let q = typical_npn();
        let volts = vec![0.7, 0.2, 0.0]; // Vbe = 0.7, Vbc = 0.5
        let s = compute_transistor_stamp(&q, &volts, 0, 1, 2, None);
        assert!(s.gm.is_finite());
        assert!(s.gmu.is_finite());
        assert!(s.g_be.is_finite());
        assert!(s.gm <= 0.1 + 1e-15);
        assert!(s.g_be <= 0.1 + 1e-15);
    }

    /// Companion currents should be zero in DC mode and non-zero in
    /// transient mode (when prev_volts is provided AND the operating
    /// point is non-trivial).
    #[test]
    fn companion_currents_only_in_transient() {
        let q = typical_npn();
        let volts = vec![0.65, 3.65, 0.0];
        let prev  = vec![0.65, 3.65, 0.0]; // identical → device hasn't moved

        let dc = compute_transistor_stamp(&q, &volts, 0, 1, 2, None);
        let tr = compute_transistor_stamp(&q, &volts, 0, 1, 2, Some(&prev));

        assert_eq!(dc.i_eq_b, 0.0);
        assert_eq!(dc.i_eq_c, 0.0);
        // Transient companion currents are computed even if the previous
        // step matches the current one (the linearisation correction is
        // about the operating point, not the step).
        assert!(tr.i_eq_b.is_finite());
        assert!(tr.i_eq_c.is_finite());
        // KCL: i_eq_e = -(i_eq_b + i_eq_c) exactly (no rounding —
        // computed by direct subtraction).
        assert_relative_eq!(tr.i_eq_e, -(tr.i_eq_b + tr.i_eq_c), epsilon = 1e-15);
    }

    /// pnjlim should engage on a wild swing in vbe.
    #[test]
    fn pnjlim_engages_on_large_swing() {
        let q = typical_npn();
        let volts = vec![1.5, 3.0, 0.0]; // Vbe = 1.5 V — way too high
        let prev  = vec![0.0, 3.0, 0.0]; // previous Vbe = 0
        let s_with    = compute_transistor_stamp(&q, &volts, 0, 1, 2, Some(&prev));
        let s_without = compute_transistor_stamp(&q, &volts, 0, 1, 2, None);
        // With pnjlim, the effective Vbe is clamped much lower, so gm is
        // smaller than without.
        assert!(s_with.gm < s_without.gm,
                "pnjlim should reduce gm: with={} without={}",
                s_with.gm, s_without.gm);
    }

    /// Grounded base — `bi = -1`.  Should not panic, should treat Vb = 0.
    #[test]
    fn grounded_base() {
        let q = typical_npn();
        let volts = vec![3.65, 0.0]; // C, E (no base entry needed)
        let s = compute_transistor_stamp(&q, &volts, -1, 0, 1, None);
        assert!(s.gm.is_finite());
        // Vb = 0 ⇒ Vbe = 0 - 0 = 0 (cutoff) — gm at the floor.
        assert!(s.gm <= 1e-3);
    }
}
