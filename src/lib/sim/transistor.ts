import type { SimulationTransistorElement } from '$lib/types';

const VT_300K = 0.02585;

export interface TransistorStamp {
    gBe: number;   // B-E conductance
    gBc: number;   // B-C conductance (from reverse current)
    gm:  number;   // transconductance ∂Ic/∂Vbe
    gmu: number;   // feedback ∂Ic/∂Vbc (Early + reverse)
    gpi: number;   // ∂Ib/∂Vbe
    gmu_b: number; // ∂Ib/∂Vbc
    iEqB: number;  // base companion current (nonlinear offset)
    iEqC: number;  // collector companion current
    iEqE: number;  // emitter companion current
}

function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * SPICE-style junction voltage limiting (pnjlim).
 * Prevents exponential blowup during Newton iterations.
 *
 * Standard SPICE algorithm — handles two cases:
 *   1. vold > 0 and step jumps forward by more than 2·Vt:
 *      squeeze with vt*log(1 + Δv/vt) so the exponential current grows
 *      sub-linearly with the step instead of explosively.
 *   2. vold ≤ 0 jumping to vnew > vcrit:
 *      replace vnew with vt*log(vnew/vt), pulling huge positive guesses
 *      back into a tractable range (this is the "reverse-to-forward"
 *      case the previous version of this function silently allowed).
 * No limiting in the reverse direction — exp(v/vt) saturates harmlessly
 * for large negative v.
 */
function limitV(vnew: number, vold: number, vt: number, is: number): number {
    const vcrit = vt * Math.log(vt / (Math.SQRT2 * is));
    if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
        if (vold > 0) {
            const arg = 1 + (vnew - vold) / vt;
            return arg > 0 ? vold + vt * Math.log(arg) : vcrit;
        }
        // vold ≤ 0, vnew > vcrit: this is the case the old limiter missed.
        return vt * Math.log(vnew / vt);
    }
    return vnew;
}

/**
 * Full Gummel-Poon transistor model.
 *
 * @param transistor  Element parameters.
 * @param volts       Compact node-voltage estimate buffer (estBuf from Newton loop).
 * @param bi          Compact base index into volts; -1 if base is grounded.
 * @param ci          Compact collector index; -1 if grounded.
 * @param ei          Compact emitter index; -1 if grounded.
 * @param prevVolts   Previous-step compact voltages for SPICE pnjlim; omit in DC mode.
 */
export function computeTransistorStamp(
    transistor: SimulationTransistorElement,
    volts:      Float64Array,
    bi:         number,
    ci:         number,
    ei:         number,
    prevVolts?: Float64Array
): TransistorStamp {
    const vb = bi >= 0 ? volts[bi] : 0;
    const vc = ci >= 0 ? volts[ci] : 0;
    const ve = ei >= 0 ? volts[ei] : 0;

    const isPnp = transistor.polarity === 'pnp';

    // Device-frame voltages: positive = forward biased
    const vbe_dev = isPnp ? (ve - vb) : (vb - ve);
    const vbc_dev = isPnp ? (vc - vb) : (vb - vc);

    // Model parameters
    const Is  = Math.max(transistor.is, 1e-20);
    const bf  = Math.max(transistor.beta, 2);
    const br  = Math.max(transistor.br  ?? 1,   0.1);
    const vaf = Math.max(transistor.vaf ?? 100,  1);
    const var_ = Math.max(transistor.var ?? 100, 1);
    const nf  = clamp(transistor.nf  ?? 1,   0.5, 2.5);
    const nr  = clamp(transistor.nr  ?? 1,   0.5, 2.5);
    const ne  = clamp(transistor.ne  ?? 1.5, 1.0, 4.0);
    const nc  = clamp(transistor.nc  ?? 2,   1.0, 4.0);
    const Ise = Math.max(transistor.ise ?? Is / bf, 1e-20);
    const Isc = Math.max(transistor.isc ?? Is / br, 1e-20);
    const ikf = Math.max(transistor.ikf ?? 1e9, 1e-9);
    const ikr = Math.max(transistor.ikr ?? 1e9, 1e-9);

    const Vt    = VT_300K;          // thermal voltage (T=300K)
    const vt_f  = nf  * Vt;
    const vt_r  = nr  * Vt;
    const vt_e  = ne  * Vt;
    const vt_c  = nc  * Vt;

    // ── Junction voltage limiting ────────────────────────────────────────────
    let vbe = vbe_dev;
    let vbc = vbc_dev;
    if (prevVolts) {
        const pb = bi >= 0 ? prevVolts[bi] : 0;
        const pe = ei >= 0 ? prevVolts[ei] : 0;
        const pc = ci >= 0 ? prevVolts[ci] : 0;
        const prev_vbe = isPnp ? (pe - pb) : (pb - pe);
        const prev_vbc = isPnp ? (pc - pb) : (pb - pc);
        vbe = limitV(vbe_dev, prev_vbe, vt_f, Is);
        vbc = limitV(vbc_dev, prev_vbc, vt_r, Is);
    }
    // Hard ceiling — caps junction current at ~1 A regardless of Is.
    // Vt*log(1/Is) gives the voltage at which Ic = 1 A; clamped to [10,30]*Vt
    // so Ge (Is=10µA) gets ~0.3 V and Si (Is=1pA) gets ~0.72 V.
    const vbe_max = Math.max(10 * vt_f, Math.min(30 * vt_f, vt_f * Math.log(1 / Is)));
    const vbc_max = Math.max(10 * vt_r, Math.min(30 * vt_r, vt_r * Math.log(1 / Is)));
    vbe = Math.min(vbe, vbe_max);
    vbc = Math.min(vbc, vbc_max);

    // ── Exponentials ─────────────────────────────────────────────────────────
    const exp_be   = Math.exp(clamp(vbe  / vt_f, -40, 40));
    const exp_bc   = Math.exp(clamp(vbc  / vt_r, -40, 40));
    const exp_be_e = Math.exp(clamp(vbe  / vt_e, -40, 40));
    const exp_bc_c = Math.exp(clamp(vbc  / vt_c, -40, 40));

    // ── Gummel-Poon base charge Qb ────────────────────────────────────────────
    // q1: Early-effect factor (reciprocal of 1 - Vbc/Vaf - Vbe/Var)
    const q1_arg = 1 - vbc / vaf - vbe / var_;
    const q1 = q1_arg > 0.01 ? 1 / q1_arg : 100;  // clamp to avoid singularity

    // q2: high-injection normalised charge
    const q2_f = Is * (exp_be - 1) / ikf;
    const q2_r = Is * (exp_bc - 1) / ikr;
    const q2   = q2_f + q2_r;

    // Qb = (q1/2) * (1 + sqrt(1 + 4*q2))
    const sq = Math.sqrt(Math.max(0, 1 + 4 * q2));
    const Qb = (q1 / 2) * (1 + sq);

    // ── Transfer current  Icc = Is*(exp_be - exp_bc) / Qb ───────────────────
    const Icc = Is * (exp_be - exp_bc) / Qb;

    // ── Base current components ───────────────────────────────────────────────
    const Ibe_ideal = (Is / bf)  * (exp_be   - 1);   // forward non-recombination
    const Ibe_nl    = Ise         * (exp_be_e - 1);   // recombination/leakage at BE
    const Ibc_ideal = (Is / br)  * (exp_bc   - 1);   // reverse non-recombination
    const Ibc_nl    = Isc         * (exp_bc_c - 1);   // recombination/leakage at BC

    // ── Terminal currents ─────────────────────────────────────────────────────
    const Ic = Icc - Ibc_ideal - Ibc_nl;
    const Ib = Ibe_ideal + Ibe_nl + Ibc_ideal + Ibc_nl;
    // Ie = -(Ic + Ib) by KCL

    // ── Analytical Jacobian ──────────────────────────────────────────────────
    // Derivatives of Qb w.r.t. vbe and vbc
    //   dQb/dvbe = dQb/dq1 * dq1/dvbe + dQb/dq2 * dq2/dvbe
    //   dq1/dvbe = q1^2 / var_
    //   dq2/dvbe = Is * exp_be / (ikf * vt_f)
    //   dQb/dq1  = Qb/q1  (since Qb = (q1/2)*(1+sq))
    //   dQb/dq2  = q1 / sq
    const dq1_dvbe  = q1 * q1 / var_;
    const dq1_dvbc  = q1 * q1 / vaf;
    const dq2f_dvbe = Is * exp_be / (ikf * vt_f);
    const dq2r_dvbc = Is * exp_bc / (ikr * vt_r);

    const dQb_dvbe  = (Qb / q1) * dq1_dvbe + (q1 / sq) * dq2f_dvbe;
    const dQb_dvbc  = (Qb / q1) * dq1_dvbc + (q1 / sq) * dq2r_dvbc;

    // dIcc/dvbe = Is * exp_be / (vt_f * Qb) - Icc * dQb/dvbe / Qb
    const dIcc_dvbe = Is * exp_be / (vt_f * Qb) - Icc * dQb_dvbe / Qb;
    // dIcc/dvbc = -Is * exp_bc / (vt_r * Qb) - Icc * dQb/dvbc / Qb
    const dIcc_dvbc = -Is * exp_bc / (vt_r * Qb) - Icc * dQb_dvbc / Qb;

    // dIbc_total/dvbc
    const dIbc_dvbc = (Is / br)  * exp_bc   / vt_r
                    + Isc         * exp_bc_c / vt_c;

    // dIbe_total/dvbe
    const dIbe_dvbe = (Is / bf)  * exp_be   / vt_f
                    + Ise         * exp_be_e / vt_e;

    // ── MNA conductances ──────────────────────────────────────────────────────
    // gm  = ∂Ic/∂Vbe  (transconductance, large, drives collector from base)
    // gmu = ∂Ic/∂Vbc  (collector-base feedback, typically negative)
    // gpi = ∂Ib/∂Vbe  (base-emitter small-signal conductance)
    // gmu_b = ∂Ib/∂Vbc (base-collector conductance, from reverse currents)
    const gm_raw    = dIcc_dvbe;
    const gmu_raw   = dIcc_dvbc - dIbc_dvbc;  // ∂Ic/∂Vbc = ∂(Icc-Ibc)/∂Vbc
    const gpi_raw   = dIbe_dvbe;
    const gmu_b_raw = dIbc_dvbc;              // ∂Ib/∂Vbc = ∂Ibc_total/∂Vbc

    // Clamp to physical range. GMAX = 0.1 S keeps gm below 1/10Ω, which is
    // still ~4 mA/mV — far above any typical operating point in this kit's
    // 100Ω–100kΩ resistor range. Higher values (e.g. 5 S) overwhelm node
    // equations by 238,000:1 vs the 47kΩ (21µS) resistors and cause Newton
    // to oscillate rather than converge.
    const GMAX = 0.1;
    const gm    = clamp(gm_raw,    1e-12, GMAX);
    const gmu   = clamp(gmu_raw,  -GMAX, GMAX);
    const gBe   = clamp(gpi_raw,   1e-12, GMAX);    // = gpi
    const gBc   = clamp(gmu_b_raw, 1e-12, GMAX);    // = gmu_b (used as B-C shunt)
    const gmu_b = clamp(gmu_b_raw, 1e-12, GMAX);

    // No separate gCe (output conductance) — it's embedded in gmu via Early effect

    // ── Newton-Raphson companion current sources ──────────────────────────────
    // Companions are only computed when prevVoltages is provided (i.e., transient mode
    // with warm-start). DC solve uses pure conductance (companions = 0) because the
    // limitV clamp requires many steps to traverse large Vbe ranges from cold start.
    //
    // After the gm stamp correction, gm*(Vb-Ve) represents "current leaving C / entering E"
    // for both NPN and PNP (sign encoded by Vb-Ve direction). The companion corrects for
    // the nonlinear residual: iEq = s_pol*I_device - conductance_linearization.
    // s_pol = +1 NPN (Ic leaves C), -1 PNP (Ic enters C from transistor).
    if (!prevVolts) {
        return { gBe, gBc, gm, gmu, gpi: gBe, gmu_b, iEqB: 0, iEqC: 0, iEqE: 0 };
    }

    const s_pol = isPnp ? -1 : 1;
    // Companion uses the CLAMPED junction voltage (vbe/vbc) converted to
    // node-voltage frame.  This intentionally creates a "pull" toward the
    // clamped operating point, helping Newton converge from a wrong estimate.
    const vbe_node = isPnp ? -vbe : vbe;   // Vb - Ve (node-voltage form)
    const vbc_node = isPnp ? -vbc : vbc;   // Vb - Vc

    const iEqC = s_pol * Ic - gm * vbe_node - gmu * vbc_node;
    const iEqB = s_pol * Ib - gBe * vbe_node - gBc * vbc_node;
    const iEqE = -(iEqC + iEqB);

    return { gBe, gBc, gm, gmu, gpi: gBe, gmu_b, iEqB, iEqC, iEqE };
}
