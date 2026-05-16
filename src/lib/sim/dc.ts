import { solveLinearSystem } from '$lib/sim/linear';
import { computeTransistorStamp } from '$lib/sim/transistor';
import { computeDiodeStamp } from '$lib/sim/diode';
import { analyzePattern, numericFactor, sparseSolveInPlace } from '$lib/sim/sparse';
import type {
	DcSolution,
	SimulationDiodeElement,
	SimulationNetlist,
	SimulationTransformerElement,
	SimulationVoltageSourceElement
} from '$lib/types';

export function solveDcNetlist(netlist: SimulationNetlist): DcSolution {
	const warnings = [] as DcSolution['warnings'];

	if (netlist.unsupported.length > 0) {
		warnings.push({
			code: 'unsupported-elements',
			message: `${netlist.unsupported.length} component(s) are unsupported and excluded from DC solve`
		});
	}

	const capacitorCount = netlist.elements.filter((element) => element.type === 'capacitor').length;
	if (capacitorCount > 0) {
		warnings.push({
			code: 'capacitor-open-circuit',
			message: `${capacitorCount} capacitor element(s) are open-circuit in steady-state DC; use transient mode for capacitor dynamics`
		});
	}

	if (netlist.groundNodeId === null) {
		return {
			ok: false,
			nodeVoltages: {},
			sourceCurrents: {},
			issue: {
				code: 'no-ground',
				message: 'Ground node is required for DC solve'
			},
			warnings
		};
	}

	// Inductors are short circuits at DC; capacitors are open circuits.
	// Coupling elements have no DC behaviour (only mutual inductance term).
	const dcElements = netlist.elements.filter(
		(element) => element.type !== 'capacitor' && element.type !== 'coupling'
	);
	if (dcElements.length === 0) {
		return {
			ok: false,
			nodeVoltages: {},
			sourceCurrents: {},
			issue: {
				code: 'empty-netlist',
				message: 'No DC-compatible elements to solve'
			},
			warnings
		};
	}

	const usedNodes = new Set<number>();
	for (const element of dcElements) {
		if (element.type === 'resistor') {
			usedNodes.add(element.nodes[0]);
			usedNodes.add(element.nodes[1]);
		} else if (element.type === 'voltage-source') {
			usedNodes.add(element.positiveNode);
			usedNodes.add(element.negativeNode);
		} else if (element.type === 'transistor') {
			usedNodes.add(element.baseNode);
			usedNodes.add(element.collectorNode);
			usedNodes.add(element.emitterNode);
		} else if (element.type === 'transformer') {
			usedNodes.add(element.primaryNodeA);
			usedNodes.add(element.primaryNodeB);
			usedNodes.add(element.secondaryNodeA);
			usedNodes.add(element.secondaryNodeB);
		} else if (element.type === 'inductor') {
			usedNodes.add(element.nodes[0]);
			usedNodes.add(element.nodes[1]);
		} else if (element.type === 'relay') {
			usedNodes.add(element.coilPositiveNode);
			usedNodes.add(element.coilNegativeNode);
			usedNodes.add(element.commonNode);
			usedNodes.add(element.normallyClosedNode);
			usedNodes.add(element.normallyOpenNode);
		} else if (element.type === 'diode') {
			usedNodes.add(element.anodeNode);
			usedNodes.add(element.cathodeNode);
		}
	}
	usedNodes.add(netlist.groundNodeId);

	const adjacency = new Map<number, Set<number>>();
	const link = (a: number, b: number) => {
		const from = adjacency.get(a) ?? new Set<number>();
		from.add(b);
		adjacency.set(a, from);
	};

	for (const element of dcElements) {
		if (element.type === 'resistor') {
			link(element.nodes[0], element.nodes[1]);
			link(element.nodes[1], element.nodes[0]);
		} else if (element.type === 'voltage-source') {
			link(element.positiveNode, element.negativeNode);
			link(element.negativeNode, element.positiveNode);
		} else if (element.type === 'transistor') {
			link(element.baseNode, element.emitterNode);
			link(element.emitterNode, element.baseNode);
			link(element.collectorNode, element.emitterNode);
			link(element.emitterNode, element.collectorNode);
		} else if (element.type === 'inductor') {
			link(element.nodes[0], element.nodes[1]);
			link(element.nodes[1], element.nodes[0]);
		} else if (element.type === 'transformer') {
			link(element.primaryNodeA, element.primaryNodeB);
			link(element.primaryNodeB, element.primaryNodeA);
			link(element.secondaryNodeA, element.secondaryNodeB);
			link(element.secondaryNodeB, element.secondaryNodeA);
			link(element.primaryNodeA, element.secondaryNodeA);
			link(element.secondaryNodeA, element.primaryNodeA);
			link(element.primaryNodeB, element.secondaryNodeB);
			link(element.secondaryNodeB, element.primaryNodeB);
		} else if (element.type === 'diode') {
			link(element.anodeNode, element.cathodeNode);
			link(element.cathodeNode, element.anodeNode);
		} else {
			link(element.coilPositiveNode, element.coilNegativeNode);
			link(element.coilNegativeNode, element.coilPositiveNode);
			link(element.commonNode, element.normallyClosedNode);
			link(element.normallyClosedNode, element.commonNode);
			link(element.commonNode, element.normallyOpenNode);
			link(element.normallyOpenNode, element.commonNode);
		}
	}

	const groundedNodes = new Set<number>();
	const queue = [netlist.groundNodeId];
	while (queue.length > 0) {
		const node = queue.shift();
		if (node === undefined || groundedNodes.has(node)) continue;
		groundedNodes.add(node);
		for (const neighbor of adjacency.get(node) ?? []) {
			if (!groundedNodes.has(neighbor)) queue.push(neighbor);
		}
	}

	const groundedElements = dcElements.filter((element) => {
		if (element.type === 'resistor' || element.type === 'inductor') {
			return groundedNodes.has(element.nodes[0]) && groundedNodes.has(element.nodes[1]);
		}
		if (element.type === 'voltage-source') {
			return groundedNodes.has(element.positiveNode) && groundedNodes.has(element.negativeNode);
		}
		if (element.type === 'transistor') {
			return (
				groundedNodes.has(element.baseNode) &&
				groundedNodes.has(element.collectorNode) &&
				groundedNodes.has(element.emitterNode)
			);
		}
		if (element.type === 'transformer') {
			return (
				groundedNodes.has(element.primaryNodeA) &&
				groundedNodes.has(element.primaryNodeB) &&
				groundedNodes.has(element.secondaryNodeA) &&
				groundedNodes.has(element.secondaryNodeB) &&
				element.turnsRatio > 0
			);
		}
		if (element.type === 'diode') {
			return groundedNodes.has(element.anodeNode) && groundedNodes.has(element.cathodeNode);
		}
		return (
			groundedNodes.has(element.coilPositiveNode) &&
			groundedNodes.has(element.coilNegativeNode) &&
			groundedNodes.has(element.commonNode) &&
			groundedNodes.has(element.normallyClosedNode) &&
			groundedNodes.has(element.normallyOpenNode) &&
			element.coilResistanceOhms > 0 &&
			element.ronOhms > 0 &&
			element.roffOhms > 0
		);
	});

	const relayElements = groundedElements.filter((element) => element.type === 'relay');
	const relayIterations = relayElements.length > 0 ? 5 : 1;
	let relayStates: Record<string, boolean> = {};
	for (const relay of relayElements) relayStates[relay.componentId] = false;

	const updateRelayStates = (estBuf: Float64Array) => {
		for (const relay of relayElements) {
			const cpIdx = nodeIndex.get(relay.coilPositiveNode);
			const cnIdx = nodeIndex.get(relay.coilNegativeNode);
			const vp = cpIdx !== undefined ? estBuf[cpIdx] : 0;
			const vn = cnIdx !== undefined ? estBuf[cnIdx] : 0;
			const coilCurrent = Math.abs((vp - vn) / relay.coilResistanceOhms);
			const currentlyOn = relayStates[relay.componentId] ?? false;
			if (currentlyOn) {
				relayStates[relay.componentId] = coilCurrent >= relay.offCurrent;
			} else {
				relayStates[relay.componentId] = coilCurrent >= relay.onCurrent;
			}
		}
	};

	if (groundedElements.length < dcElements.length) {
		warnings.push({
			code: 'floating-subcircuit',
			message: `${dcElements.length - groundedElements.length} element(s) are floating and excluded from DC solve`
		});
	}

	if (groundedElements.length === 0) {
		return {
			ok: false,
			nodeVoltages: {},
			sourceCurrents: {},
			issue: {
				code: 'empty-netlist',
				message: 'No grounded DC-compatible elements to solve'
			},
			warnings
		};
	}

	const nonGroundNodes = Array.from(usedNodes)
		.filter((nodeId) => nodeId !== netlist.groundNodeId && groundedNodes.has(nodeId))
		.sort((a, b) => a - b);

	const voltageSources: SimulationVoltageSourceElement[] = groundedElements.filter(
		(element): element is SimulationVoltageSourceElement => element.type === 'voltage-source'
	);
	const transformerElements: SimulationTransformerElement[] = groundedElements.filter(
		(element): element is SimulationTransformerElement => element.type === 'transformer'
	);

	const nodeIndex = new Map<number, number>();
	nonGroundNodes.forEach((nodeId, idx) => nodeIndex.set(nodeId, idx));

	const n = nonGroundNodes.length;
	const m = voltageSources.length;
	const t = transformerElements.length;
	const size = n + m + 2 * t;
	const gmin = 1e-9;

	const matrix  = new Float64Array(size * size);
	const rhs     = new Float64Array(size);
	const scratch = new Float64Array(size * size + size);

	const stampConductance = (a: number, b: number, g: number) => {
		const ia = nodeIndex.get(a);
		const ib = nodeIndex.get(b);
		if (ia !== undefined) matrix[ia * size + ia] += g;
		if (ib !== undefined) matrix[ib * size + ib] += g;
		if (ia !== undefined && ib !== undefined) {
			matrix[ia * size + ib] -= g;
			matrix[ib * size + ia] -= g;
		}
	};

	const stampTransformer = (
		primaryA: number,
		primaryB: number,
		secondaryA: number,
		secondaryB: number,
		turnsRatio: number,
		index: number
	) => {
		const ipIdx = n + m + 2 * index;
		const isIdx = ipIdx + 1;
		const pA = nodeIndex.get(primaryA);
		const pB = nodeIndex.get(primaryB);
		const sA = nodeIndex.get(secondaryA);
		const sB = nodeIndex.get(secondaryB);
		if (pA !== undefined) matrix[pA * size + ipIdx] += 1;
		if (pB !== undefined) matrix[pB * size + ipIdx] -= 1;
		if (sA !== undefined) matrix[sA * size + isIdx] += 1;
		if (sB !== undefined) matrix[sB * size + isIdx] -= 1;
		if (pA !== undefined) matrix[ipIdx * size + pA] += 1;
		if (pB !== undefined) matrix[ipIdx * size + pB] -= 1;
		if (sA !== undefined) matrix[ipIdx * size + sA] -= turnsRatio;
		if (sB !== undefined) matrix[ipIdx * size + sB] += turnsRatio;
		matrix[isIdx * size + ipIdx] += 1;
		matrix[isIdx * size + isIdx] += 1 / turnsRatio;
	};

	// Declared after stampConductance so its dependency on it is resolved at
	// definition time, not runtime — avoids TDZ-style fragility if the call
	// site ever moves earlier.
	const stampRelays = () => {
		for (const relay of relayElements) {
			stampConductance(relay.coilPositiveNode, relay.coilNegativeNode, 1 / relay.coilResistanceOhms);

			const isOn = relayStates[relay.componentId] ?? false;
			const gComNc = 1 / (isOn ? relay.roffOhms : relay.ronOhms);
			const gComNo = 1 / (isOn ? relay.ronOhms : relay.roffOhms);
			stampConductance(relay.commonNode, relay.normallyClosedNode, gComNc);
			stampConductance(relay.commonNode, relay.normallyOpenNode, gComNo);
		}
	};

	// Build the static base matrix once: gmin, resistors, voltage-source stamps,
	// and transformer stamps are all constant across Newton iterations.
	for (const nodeId of nonGroundNodes) {
		const idx = nodeIndex.get(nodeId)!;
		matrix[idx * size + idx] += gmin;
	}
	for (const element of groundedElements) {
		if (element.type === 'inductor') {
			// Inductor = short circuit at DC (V = L*dI/dt = 0 in steady state).
			// Stamp as near-zero resistance so it provides a wire between its nodes.
			stampConductance(element.nodes[0], element.nodes[1], 1e6);
			continue;
		}
		if (element.type !== 'resistor') continue;
		stampConductance(element.nodes[0], element.nodes[1], 1 / element.resistanceOhms);
	}
	for (let vIdx = 0; vIdx < voltageSources.length; vIdx++) {
		const source = voltageSources[vIdx];
		const row  = n + vIdx;
		const ip   = nodeIndex.get(source.positiveNode);
		const ineg = nodeIndex.get(source.negativeNode);
		if (ip   !== undefined) { matrix[ip   * size + row] += 1; matrix[row * size + ip  ] += 1; }
		if (ineg !== undefined) { matrix[ineg * size + row] -= 1; matrix[row * size + ineg] -= 1; }
		rhs[row] = source.voltage;
	}
	for (let tIdx = 0; tIdx < transformerElements.length; tIdx++) {
		const tf = transformerElements[tIdx];
		stampTransformer(tf.primaryNodeA, tf.primaryNodeB, tf.secondaryNodeA, tf.secondaryNodeB, tf.turnsRatio, tIdx);
	}
	const baseMatrix = matrix.slice();
	const baseRhs    = rhs.slice();

	const transistorElements = groundedElements.filter((element) => element.type === 'transistor');
	const diodeElements = groundedElements.filter(
		(element): element is SimulationDiodeElement => element.type === 'diode'
	);
	const transistorIterations = transistorElements.length > 0 ? 15 : 1;
	const diodeIterations      = diodeElements.length      > 0 ? 10 : 1;
	const totalIterations = Math.max(transistorIterations, relayIterations, diodeIterations);

	// ── Symbolic LU — built once per solveDcNetlist call ────────────────────
	// Scan the already-stamped baseMatrix for all non-zero positions, then
	// overlay the transistor and diode stamp positions (which are zero at the
	// cold start but can be non-zero at any operating point).
	const dcPatMark = new Uint8Array(size * size);
	for (let idx = 0; idx < baseMatrix.length; idx++) {
		if (baseMatrix[idx] !== 0) dcPatMark[idx] = 1;
	}
	for (const t of transistorElements) {
		for (const na of [t.baseNode, t.collectorNode, t.emitterNode]) {
			const ri = nodeIndex.get(na);
			if (ri === undefined) continue;
			for (const nb of [t.baseNode, t.collectorNode, t.emitterNode]) {
				const rj = nodeIndex.get(nb);
				if (rj === undefined) continue;
				dcPatMark[ri * size + rj] = 1;
			}
		}
	}
	for (const d of diodeElements) {
		const ia = nodeIndex.get(d.anodeNode);
		const ic = nodeIndex.get(d.cathodeNode);
		if (ia !== undefined) dcPatMark[ia * size + ia] = 1;
		if (ic !== undefined) dcPatMark[ic * size + ic] = 1;
		if (ia !== undefined && ic !== undefined) {
			dcPatMark[ia * size + ic] = 1;
			dcPatMark[ic * size + ia] = 1;
		}
	}
	const dcSparsePattern = analyzePattern(dcPatMark, size);
	// ─────────────────────────────────────────────────────────────────────────

	// ── Per-element compact indices for stamp functions ──────────────────────
	// These mirror the transistorNodeIndices/diodeNodeIndices in CompiledNetlist
	// but are computed locally since DC doesn't have a CompiledNetlist cache.
	const dcTni = new Int32Array(transistorElements.length * 3);
	transistorElements.forEach((t, i) => {
		dcTni[i * 3]     = nodeIndex.get(t.baseNode)      ?? -1;
		dcTni[i * 3 + 1] = nodeIndex.get(t.collectorNode) ?? -1;
		dcTni[i * 3 + 2] = nodeIndex.get(t.emitterNode)   ?? -1;
	});
	const dcDni = new Int32Array(diodeElements.length * 2);
	diodeElements.forEach((d, i) => {
		dcDni[i * 2]     = nodeIndex.get(d.anodeNode)   ?? -1;
		dcDni[i * 2 + 1] = nodeIndex.get(d.cathodeNode) ?? -1;
	});

	// Compact estimate buffer (indexed by nodeIndex, same space as matrix rows).
	const estBuf = new Float64Array(size);

	// Heuristic warm-start: set transistor nodes near their expected active-region
	// voltages so the first Newton iteration doesn't get exp() blowup from a cold
	// all-zeros start.  VCC is the largest voltage-source magnitude in the netlist.
	const maxVcc = voltageSources.length > 0
		? Math.max(...voltageSources.map((s) => Math.abs(s.voltage)))
		: 5;
	for (let i = 0; i < transistorElements.length; i++) {
		const t = transistorElements[i];
		const bi = dcTni[i * 3], ci = dcTni[i * 3 + 1], ei = dcTni[i * 3 + 2];
		const isPnp = t.polarity === 'pnp';
		if (isPnp) {
			if (ei >= 0) estBuf[ei] = maxVcc;
			if (bi >= 0) estBuf[bi] = maxVcc * 0.9;
			if (ci >= 0) estBuf[ci] = maxVcc * 0.5;
		} else {
			if (ei >= 0) estBuf[ei] = 0;
			if (bi >= 0) estBuf[bi] = 0.6;
			if (ci >= 0) estBuf[ci] = maxVcc * 0.5;
		}
	}

	let solutionVector: ArrayLike<number> | null = null;

	for (let iteration = 0; iteration < totalIterations; iteration++) {
		matrix.set(baseMatrix);
		rhs.set(baseRhs);

		for (let i = 0; i < transistorElements.length; i++) {
			const transistor = transistorElements[i];
			const bi = dcTni[i * 3], ci = dcTni[i * 3 + 1], ei = dcTni[i * 3 + 2];
			// DC solve: no prevVolts — hard ceiling prevents overflow from cold start.
			const stamp = computeTransistorStamp(transistor, estBuf, bi, ci, ei);

			stampConductance(transistor.baseNode, transistor.emitterNode, stamp.gBe);
			stampConductance(transistor.baseNode, transistor.collectorNode, stamp.gBc);

			const rowC = ci >= 0 ? ci : undefined;
			const rowE = ei >= 0 ? ei : undefined;
			const rowB = bi >= 0 ? bi : undefined;

			if (rowC !== undefined && bi >= 0) matrix[rowC * size + bi] += stamp.gm;
			if (rowC !== undefined && ei >= 0) matrix[rowC * size + ei] -= stamp.gm;
			if (rowE !== undefined && bi >= 0) matrix[rowE * size + bi] -= stamp.gm;
			if (rowE !== undefined && ei >= 0) matrix[rowE * size + ei] += stamp.gm;

			if (rowC !== undefined && bi >= 0) matrix[rowC * size + bi] += stamp.gmu;
			if (rowC !== undefined && ci >= 0) matrix[rowC * size + ci] -= stamp.gmu;
			if (rowE !== undefined && bi >= 0) matrix[rowE * size + bi] -= stamp.gmu;
			if (rowE !== undefined && ci >= 0) matrix[rowE * size + ci] += stamp.gmu;

			if (rowB !== undefined) rhs[rowB] -= stamp.iEqB;
			if (rowC !== undefined) rhs[rowC] -= stamp.iEqC;
			if (rowE !== undefined) rhs[rowE] -= stamp.iEqE;
		}

		stampRelays();

		for (let di = 0; di < diodeElements.length; di++) {
			const diode = diodeElements[di];
			const ai = dcDni[di * 2], ki = dcDni[di * 2 + 1];
			const stamp = computeDiodeStamp(diode, estBuf, ai, ki);
			stampConductance(diode.anodeNode, diode.cathodeNode, stamp.gd);
			if (ai >= 0) rhs[ai] -= stamp.ieq;
			if (ki >= 0) rhs[ki] += stamp.ieq;
		}

		// Sparse LU — numericFactor works in-place on matrix; matrix is reset
		// from baseMatrix at the top of each iteration so mutation is safe.
		if (numericFactor(matrix, size, dcSparsePattern)) {
			sparseSolveInPlace(matrix, rhs, size, dcSparsePattern);
			solutionVector = rhs;
		} else {
			solutionVector = solveLinearSystem(matrix, rhs, size, scratch);
		}
		if (!solutionVector) break;

		for (let i = 0; i < n; i++) estBuf[i] = solutionVector[i];
		updateRelayStates(estBuf);
	}
	if (!solutionVector) {
		return {
			ok: false,
			nodeVoltages: {},
			sourceCurrents: {},
			issue: {
				code: 'singular-matrix',
				message: 'DC solve failed: matrix is singular or ill-conditioned'
			},
			warnings
		};
	}

	const nodeVoltages: Record<number, number> = { [netlist.groundNodeId]: 0 };
	for (let i = 0; i < nonGroundNodes.length; i++) {
		nodeVoltages[nonGroundNodes[i]] = solutionVector[i];
	}

	const sourceCurrents: Record<string, number> = {};
	for (let i = 0; i < voltageSources.length; i++) {
		sourceCurrents[voltageSources[i].componentId] = solutionVector[n + i];
	}

	return {
		ok: true,
		nodeVoltages,
		sourceCurrents,
		warnings
	};
}

