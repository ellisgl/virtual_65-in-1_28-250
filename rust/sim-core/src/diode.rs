//! Shockley diode with optional Zener breakdown.
//!
//! Port of `src/lib/sim/diode.ts`.  The numerical algorithm — SPICE
//! pnjlim limiter, forward-current ceiling, Zener reverse branch — matches
//! the TS reference line-for-line.  Parity is verified by tests against
//! analytical values where possible and by the cross-port fixture in
//! `tests/parity.rs` otherwise.

use crate::types::Diode;

/// Thermal voltage at T = 300 K (V).
pub const VT_300K: f64 = 0.02585;

/// Output of a diode stamp: linearised conductance and companion current.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DiodeStamp {
    /// Linearised junction conductance (S).  Stamp between anode and cathode.
    pub gd: f64,
    /// Companion current (A).  Positive = conventional flow from anode to
    /// cathode.  Apply as `rhs[anode] -= ieq; rhs[cathode] += ieq`.
    pub ieq: f64,
}

/// SPICE pnjlim — limits the per-iteration junction-voltage swing to prevent
/// Newton divergence at large forward biases.  Identical algorithm to the
/// one in `transistor.rs`.
fn limit_v(vnew: f64, vold: f64, vt: f64, is: f64) -> f64 {
    let sqrt_2 = std::f64::consts::SQRT_2;
    let vcrit = vt * (vt / (sqrt_2 * is)).ln();
    if vnew > vcrit && (vnew - vold).abs() > 2.0 * vt {
        if vold > 0.0 {
            let arg = 1.0 + (vnew - vold) / vt;
            return if arg > 0.0 { vold + vt * arg.ln() } else { vcrit };
        }
        // vold ≤ 0, vnew > vcrit — "reverse-to-forward" jump.
        return vt * (vnew / vt).ln();
    }
    vnew
}

/// Compute the diode stamp for the current Newton iterate.
///
/// # Arguments
/// * `diode`      — Element parameters.
/// * `volts`      — Compact node-voltage estimate buffer.
/// * `ai`         — Compact anode index; `-1` if anode is grounded.
/// * `ki`         — Compact cathode index; `-1` if cathode is grounded.
/// * `prev_volts` — Previous-step compact voltages for SPICE pnjlim
///                  (`None` in DC mode).
pub fn compute_diode_stamp(
    diode: &Diode,
    volts: &[f64],
    ai: i32,
    ki: i32,
    prev_volts: Option<&[f64]>,
) -> DiodeStamp {
    let va = if ai >= 0 { volts[ai as usize] } else { 0.0 };
    let vc = if ki >= 0 { volts[ki as usize] } else { 0.0 };
    let mut vd = va - vc;

    let vt_n = diode.n * VT_300K;
    let is = diode.is.max(1e-20);

    if let Some(prev) = prev_volts {
        // Transient: SPICE pnjlim keeps Newton steps tractable.
        let pva = if ai >= 0 { prev[ai as usize] } else { 0.0 };
        let pvc = if ki >= 0 { prev[ki as usize] } else { 0.0 };
        vd = limit_v(vd, pva - pvc, vt_n, is);
    }

    // Hard forward ceiling: cap at the voltage where Id ≈ 1 A to prevent
    // exp() overflow in DC mode where pnjlim isn't applied.
    let vd_max = (30.0 * vt_n).min(vt_n * (1.0 / is).ln());
    vd = vd.min(vd_max);

    // ── Forward Shockley ────────────────────────────────────────────────
    let exp_f = (vd / vt_n).min(40.0).exp();
    let id_fwd = is * (exp_f - 1.0);
    let gd_fwd = is * exp_f / vt_n;

    // ── Zener reverse breakdown ─────────────────────────────────────────
    let (id_bv, gd_bv) = if let Some(bv) = diode.bv {
        let ibv = diode.ibv.unwrap_or(1e-3);
        // `arg` is positive when Vd < -Bv (device is in breakdown).
        let arg = (-(vd + bv) / vt_n).min(40.0);
        let exp_bv = arg.max(-40.0).exp();
        (-ibv * exp_bv, ibv * exp_bv / vt_n)
    } else {
        (0.0, 0.0)
    };

    let id = id_fwd + id_bv;
    let gd = (gd_fwd + gd_bv).max(1e-12);
    let ieq = id - gd * vd; // companion correction

    DiodeStamp { gd, ieq }
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    /// Off bias (Vd ≪ 0): current ≈ -is, conductance hits the floor.
    #[test]
    fn reverse_bias_off() {
        let d = Diode::shockley(1e-14, 1.0);
        let volts = vec![-5.0, 0.0]; // Vd = -5 V
        let stamp = compute_diode_stamp(&d, &volts, 0, 1, None);
        // For Vd very negative, exp(Vd/Vt) ≈ 0, so id ≈ -is, gd at floor.
        assert!(stamp.gd >= 1e-12);
        // gd at the 1e-12 floor → companion ≈ id - 0 ≈ -is ≈ -1e-14
        assert!(stamp.ieq.abs() < 1e-10);
    }

    /// Forward bias at Vd = 0.6 V — should produce a small forward current
    /// and a positive conductance.  Sanity-check magnitudes.
    #[test]
    fn forward_bias_on() {
        let d = Diode::shockley(1e-14, 1.0);
        let volts = vec![0.6, 0.0];
        let stamp = compute_diode_stamp(&d, &volts, 0, 1, None);
        // gd = is * exp(0.6/0.02585) / 0.02585
        let exp_term = (0.6 / VT_300K).exp();
        let gd_expected = 1e-14 * exp_term / VT_300K;
        assert_relative_eq!(stamp.gd, gd_expected.max(1e-12), epsilon = 1e-12);
        // gd is large in forward bias → far above the floor.
        assert!(stamp.gd > 1e-3);
    }

    /// Grounded anode — should compute correctly with `ai = -1`.
    #[test]
    fn grounded_anode() {
        let d = Diode::shockley(1e-14, 1.0);
        let volts = vec![0.0, -0.6]; // Vd = 0 - (-0.6) = 0.6 V (forward)
        let stamp = compute_diode_stamp(&d, &volts, -1, 1, None);
        assert!(stamp.gd > 1e-3);
    }

    /// Grounded cathode.
    #[test]
    fn grounded_cathode() {
        let d = Diode::shockley(1e-14, 1.0);
        let volts = vec![0.6];
        let stamp = compute_diode_stamp(&d, &volts, 0, -1, None);
        assert!(stamp.gd > 1e-3);
    }

    /// Zener in breakdown: Vd ≈ -6 V on a Bv = 5 V Zener.  Conductance and
    /// companion should both reflect the breakdown current.
    #[test]
    fn zener_breakdown() {
        let z = Diode::zener(1e-14, 1.0, 5.0);
        let volts = vec![-6.0, 0.0];
        let stamp = compute_diode_stamp(&z, &volts, 0, 1, None);
        // Breakdown branch contributes ibv*exp(-(vd+bv)/vt)/vt to gd.
        let arg = -(-6.0 + 5.0) / VT_300K;
        let exp_bv = arg.min(40.0).exp();
        let gd_bv_expected = 1e-3 * exp_bv / VT_300K;
        assert!(stamp.gd >= gd_bv_expected * 0.999);
    }

    /// pnjlim should clip aggressive forward jumps.  Going from -1 V to
    /// +1 V in one Newton step is unphysical; limitV should bring vd back
    /// to something tractable.
    #[test]
    fn pnjlim_clips_large_swing() {
        let d = Diode::shockley(1e-14, 1.0);
        let volts = vec![1.0, 0.0];        // current iterate: vd = +1 V
        let prev  = vec![-1.0, 0.0];       // previous step:   vd = -1 V
        let stamp_with    = compute_diode_stamp(&d, &volts, 0, 1, Some(&prev));
        let stamp_without = compute_diode_stamp(&d, &volts, 0, 1, None);
        // With pnjlim, the effective Vd is smaller, so gd should be smaller
        // than without — proving the limiter engaged.
        assert!(stamp_with.gd < stamp_without.gd,
                "expected pnjlim to reduce gd: with={} without={}",
                stamp_with.gd, stamp_without.gd);
    }
}
