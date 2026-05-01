import type { SimulationTransistorElement } from '$lib/types';

const VT_300K = 0.02585;

export interface TransistorStamp {
	gBe: number;
	gCe: number;
	gmSigned: number;
	// Linearization current offsets for Newton-Raphson companion model.
	// These anchor the conductance stamp to the actual device curve at the
	// current operating point. Subtract from RHS at the respective node.
	iEqB: number;
	iEqC: number;
	iEqE: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function computeTransistorStamp(
	transistor: SimulationTransistorElement,
	nodeVoltages: Record<number, number>
): TransistorStamp {
	const vb = nodeVoltages[transistor.baseNode] ?? 0;
	const vc = nodeVoltages[transistor.collectorNode] ?? 0;
	const ve = nodeVoltages[transistor.emitterNode] ?? 0;

	const polaritySign = transistor.polarity === 'npn' ? 1 : -1;
	const vbe = polaritySign * (vb - ve);
	const vce = polaritySign * (vc - ve);

	const nf = clamp(transistor.nf, 1, 2.5);
	const vt = VT_300K * nf;
	const expArg = clamp(vbe / vt, -40, 40);
	const expVbe = Math.exp(expArg);
	const iss = Math.max(transistor.is, 1e-18);
	const ic0 = iss * (expVbe - 1);
	const beta = Math.max(transistor.beta, 10);

	const gm = Math.max(0, (iss / vt) * expVbe);
	const gBe = Math.max(1e-10, gm / beta);

	const earlyV = Math.max(1, transistor.vaf);
	const earlyFactor = 1 + Math.max(0, vce) / earlyV;
	const collectorCurrent = Math.max(0, ic0 * earlyFactor);
	const gCe = Math.max(1e-10, collectorCurrent / earlyV);

	// Actual device currents at this operating point.
	// Ib = gBe*(vb-ve), Ic = gm*(vb-ve) + gCe*(vc-ve), Ie = -(Ib+Ic)
	const iB = gBe * vbe;
	const iC = gm * vbe + gCe * vce;
	const iE = -(iB + iC);

	// Linearization offsets: I_device - G*V_operating, stamped onto RHS so that
	// the Newton update converges to the correct nonlinear solution.
	// For NPN: positive collector current flows into collector (out of node).
	// Sign convention: iEq is the current the companion source *injects* into the node.
	const sign = polaritySign;
	const iEqB = sign * (iB - gBe * vbe);        // = 0 (simplifies, but kept for clarity)
	const iEqC = sign * (iC - gm * vbe - gCe * vce); // = 0 too, but generalises to VAF terms
	const iEqE = -(iEqB + iEqC);

	return {
		gBe,
		gCe,
		gmSigned: gm * polaritySign,
		iEqB,
		iEqC,
		iEqE
	};
}

