import type { SimulationDiodeElement } from '$lib/types';

const VT_300K = 0.02585; // thermal voltage at 300 K

/**
 * SPICE pnjlim — identical algorithm to transistor.ts.
 * Prevents Newton divergence by limiting the junction voltage step.
 */
function limitV(vnew: number, vold: number, vt: number, is: number): number {
    const vcrit = vt * Math.log(vt / (Math.SQRT2 * is));
    if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
        if (vold > 0) {
            const arg = 1 + (vnew - vold) / vt;
            return arg > 0 ? vold + vt * Math.log(arg) : vcrit;
        }
        // vold ≤ 0, vnew > vcrit — "reverse-to-forward" jump.
        return vt * Math.log(vnew / vt);
    }
    return vnew;
}

export interface DiodeStamp {
    /** Linearized junction conductance (S). Stamp between anode and cathode. */
    gd: number;
    /**
     * Companion current (A). Positive = conventional flow from anode to cathode.
     * Apply as:  rhs[anode] -= ieq;  rhs[cathode] += ieq
     */
    ieq: number;
}

/**
 * Shockley diode model with optional Zener reverse-breakdown.
 *
 * @param diode     Element parameters.
 * @param volts     Compact node-voltage estimate buffer.
 * @param ai        Compact anode index; -1 if anode is grounded.
 * @param ki        Compact cathode index; -1 if cathode is grounded.
 * @param prevVolts Previous-step compact voltages for SPICE pnjlim; omit in DC mode.
 */
export function computeDiodeStamp(
    diode:      SimulationDiodeElement,
    volts:      Float64Array,
    ai:         number,
    ki:         number,
    prevVolts?: Float64Array,
): DiodeStamp {
    const va = ai >= 0 ? volts[ai] : 0;
    const vc = ki >= 0 ? volts[ki] : 0;
    let vd = va - vc;

    const vt_n = diode.n * VT_300K;
    const is   = Math.max(diode.is, 1e-20);

    if (prevVolts) {
        // Transient: SPICE pnjlim keeps Newton steps tractable.
        const pva = ai >= 0 ? prevVolts[ai] : 0;
        const pvc = ki >= 0 ? prevVolts[ki] : 0;
        vd = limitV(vd, pva - pvc, vt_n, is);
    }

    // Hard forward ceiling: cap at the voltage where Id ≈ 1 A, to prevent
    // exp() overflow in DC mode where pnjlim isn't applied.
    const vd_max = Math.min(30 * vt_n, vt_n * Math.log(1 / is));
    vd = Math.min(vd, vd_max);

    // ── Forward Shockley ──────────────────────────────────────────────────
    const expF    = Math.exp(Math.min(vd / vt_n, 40));
    const id_fwd  = is * (expF - 1);
    const gd_fwd  = is * expF / vt_n;

    // ── Zener reverse breakdown ───────────────────────────────────────────
    let id_bv = 0;
    let gd_bv = 0;
    if (diode.bv !== undefined) {
        const ibv = diode.ibv ?? 1e-3;
        // arg is positive when Vd < −Bv (device is in breakdown).
        const arg   = Math.min(-(vd + diode.bv) / vt_n, 40);
        const expBV = Math.exp(Math.max(arg, -40));
        id_bv = -ibv * expBV;        // negative = reverse current from anode POV
        gd_bv =  ibv * expBV / vt_n; // positive conductance
    }

    const id  = id_fwd + id_bv;
    const gd  = Math.max(gd_fwd + gd_bv, 1e-12);
    const ieq = id - gd * vd;       // companion correction; rhs[anode] -= ieq

    return { gd, ieq };
}
