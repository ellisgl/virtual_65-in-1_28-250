import type { SimulationTransistorElement } from '$lib/types';

const VT_300K = 0.02585;

export interface TransistorStamp {
	gBe: number;
	gCe: number;
	gmSigned: number;
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

	return {
		gBe,
		gCe,
		gmSigned: gm * polaritySign
	};
}

