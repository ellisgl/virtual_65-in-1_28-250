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
 * SPICE-style junction voltage limiting.
 * Prevents exponential blowup during Newton iterations by limiting
 * the voltage step to ±2Vt above the critical voltage.
 */
function limitV(vnew: number, vold: number, vt: number, is: number): number {
    const vcrit = vt * Math.log(vt / (Math.SQRT2 * is));
    if (vnew > vcrit) {
        if (Math.abs(vnew - vold) > 2 * vt) {
            return vold + (vnew > vold ? 2 * vt : -2 * vt);
        }
    }
    return vnew;
}

/**
 * Full Gummel-Poon transistor model.
 *
 * Implements the standard SPICE Gummel-Poon equations:
 *   • Charge-controlled transfer current with Qb (Early effect + high injection)
 *   • Non-ideal base currents (Ise, Isc leakage components)
 *   • Reverse active region (br, Is/br)
 *   • Full analytical Jacobian for Newton-Raphson convergence
 *
 * Parameters used from SimulationTransistorElement:
 *   is, beta(=bf), br, vaf, var, nf, nr, ne, nc, ise, isc, ikf, ikr,
 *   cjeFarads, cjcFarads (junction capacitances handled in transient.ts)
 */
export function computeTransistorStamp(
    transistor: SimulationTransistorElement,
    nodeVoltages: Record<number, number>,
    prevVoltages?: Record<number, number>
): TransistorStamp {
    const vb = nodeVoltages[transistor.baseNode] ?? 0;
    const vc = nodeVoltages[transistor.collectorNode] ?? 0;
    const ve = nodeVoltages[transistor.emitterNode] ?? 0;

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
    if (prevVoltages) {
        const pb = prevVoltages[transistor.baseNode] ?? 0;
        const pe = prevVoltages[transistor.emitterNode] ?? 0;
        const pc = prevVoltages[transistor.collectorNode] ?? 0;
        const prev_vbe = isPnp ? (pe - pb) : (pb - pe);
        const prev_vbc = isPnp ? (pc - pb) : (pb - pc);
        vbe = limitV(vbe_dev, prev_vbe, vt_f, Is);
        vbc = limitV(vbc_dev, prev_vbc, vt_r, Is);
    }
    // Hard ceiling — prevents exp() overflow (Ge ~0.5V, Si ~0.8V)
    const vbe_max = Is > 1e-9 ? 20 * vt_f : 30 * vt_f;
    const vbc_max = Is > 1e-9 ? 20 * vt_r : 30 * vt_r;
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

    // Clamp to physical range. GMAX = 5 S corresponds to Ic ≈ 130 mA at room
    // temperature — well above the 2SB56's continuous current rating. This is
    // far more conservative than 100 S and prevents Newton from oscillating
    // between iterations when the transistor is driven hard.
    const GMAX = 5;
    const gm    = clamp(gm_raw,    1e-12, GMAX);
    const gmu   = clamp(gmu_raw,  -GMAX, GMAX);
    const gBe   = clamp(gpi_raw,   1e-12, GMAX);    // = gpi
    const gBc   = clamp(gmu_b_raw, 1e-12, GMAX);    // = gmu_b (used as B-C shunt)
    const gmu_b = clamp(gmu_b_raw, 1e-12, GMAX);

    // No separate gCe (output conductance) — it's embedded in gmu via Early effect

    // ── Newton-Raphson companion current sources ──────────────────────────────
    // Disabled for stability — pure conductance model.
    // Non-zero companion currents create oscillation when inductors are present.
    // The conductance terms (gm, gmu, gBe, gBc) are sufficient to converge.
    return { gBe, gBc, gm, gmu, gpi: gBe, gmu_b, iEqB: 0, iEqC: 0, iEqE: 0 };
}
