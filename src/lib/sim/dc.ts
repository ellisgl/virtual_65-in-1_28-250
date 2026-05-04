import { solveLinearSystem } from '$lib/sim/linear';
import { computeTransistorStamp } from '$lib/sim/transistor';
import type {
	DcSolution,
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
		(element) => element.type !== 'capacitor' && element.type !== 'inductor' && element.type !== 'coupling'
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
		} else if (element.type === 'relay') {
			usedNodes.add(element.coilPositiveNode);
			usedNodes.add(element.coilNegativeNode);
			usedNodes.add(element.commonNode);
			usedNodes.add(element.normallyClosedNode);
			usedNodes.add(element.normallyOpenNode);
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
		} else if (element.type === 'transformer') {
			link(element.primaryNodeA, element.primaryNodeB);
			link(element.primaryNodeB, element.primaryNodeA);
			link(element.secondaryNodeA, element.secondaryNodeB);
			link(element.secondaryNodeB, element.secondaryNodeA);
			link(element.primaryNodeA, element.secondaryNodeA);
			link(element.secondaryNodeA, element.primaryNodeA);
			link(element.primaryNodeB, element.secondaryNodeB);
			link(element.secondaryNodeB, element.primaryNodeB);
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
		if (element.type === 'resistor') {
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

	const updateRelayStates = (voltages: Record<number, number>) => {
		for (const relay of relayElements) {
			const vp = voltages[relay.coilPositiveNode] ?? 0;
			const vn = voltages[relay.coilNegativeNode] ?? 0;
			const coilCurrent = Math.abs((vp - vn) / relay.coilResistanceOhms);
			const currentlyOn = relayStates[relay.componentId] ?? false;
			if (currentlyOn) {
				relayStates[relay.componentId] = coilCurrent >= relay.offCurrent;
			} else {
				relayStates[relay.componentId] = coilCurrent >= relay.onCurrent;
			}
		}
	};

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

	// Build the static base matrix once: gmin, resistors, voltage-source stamps,
	// and transformer stamps are all constant across Newton iterations.
	for (const nodeId of nonGroundNodes) {
		const idx = nodeIndex.get(nodeId)!;
		matrix[idx * size + idx] += gmin;
	}
	for (const element of groundedElements) {
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
	const transistorIterations = transistorElements.length > 0 ? 6 : 1;
	const totalIterations = Math.max(transistorIterations, relayIterations);
	let estimateVoltages: Record<number, number> = { [netlist.groundNodeId]: 0 };
	let solutionVector: number[] | null = null;

	for (let iteration = 0; iteration < totalIterations; iteration++) {
		matrix.set(baseMatrix);
		rhs.set(baseRhs);

		for (const transistor of transistorElements) {
			const stamp = computeTransistorStamp(transistor, estimateVoltages);
			const isPnp = transistor.polarity === 'pnp';
			const s = isPnp ? -1 : 1;

			stampConductance(transistor.baseNode, transistor.emitterNode, stamp.gBe);
			stampConductance(transistor.baseNode, transistor.collectorNode, stamp.gBc);

			const rowC = nodeIndex.get(transistor.collectorNode);
			const rowE = nodeIndex.get(transistor.emitterNode);
			const rowB = nodeIndex.get(transistor.baseNode);
			const colB = nodeIndex.get(transistor.baseNode);
			const colC = nodeIndex.get(transistor.collectorNode);
			const colE = nodeIndex.get(transistor.emitterNode);

			// gm VCCS
			if (rowC !== undefined && colB !== undefined) matrix[rowC * size + colB] -= s * stamp.gm;
			if (rowC !== undefined && colE !== undefined) matrix[rowC * size + colE] += s * stamp.gm;
			if (rowE !== undefined && colB !== undefined) matrix[rowE * size + colB] += s * stamp.gm;
			if (rowE !== undefined && colE !== undefined) matrix[rowE * size + colE] -= s * stamp.gm;

			// gmu VCCS (Early + reverse)
			if (rowC !== undefined && colB !== undefined) matrix[rowC * size + colB] -= s * stamp.gmu;
			if (rowC !== undefined && colC !== undefined) matrix[rowC * size + colC] += s * stamp.gmu;
			if (rowE !== undefined && colB !== undefined) matrix[rowE * size + colB] += s * stamp.gmu;
			if (rowE !== undefined && colC !== undefined) matrix[rowE * size + colC] -= s * stamp.gmu;

			// Companion currents
			if (rowB !== undefined) rhs[rowB] -= stamp.iEqB;
			if (rowC !== undefined) rhs[rowC] -= stamp.iEqC;
			if (rowE !== undefined) rhs[rowE] -= stamp.iEqE;
		}

		stampRelays();

		solutionVector = solveLinearSystem(matrix, rhs, size, scratch);
		if (!solutionVector) break;

		estimateVoltages = { [netlist.groundNodeId]: 0 };
		for (let i = 0; i < nonGroundNodes.length; i++) {
			estimateVoltages[nonGroundNodes[i]] = solutionVector[i];
		}
		updateRelayStates(estimateVoltages);
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

