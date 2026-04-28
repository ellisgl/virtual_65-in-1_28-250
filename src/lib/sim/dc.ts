import { solveLinearSystem } from '$lib/sim/linear';
import type { DcSolution, SimulationNetlist, SimulationVoltageSourceElement } from '$lib/types';

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

	const dcElements = netlist.elements.filter((element) => element.type !== 'capacitor');
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
		} else {
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

	const nodeIndex = new Map<number, number>();
	nonGroundNodes.forEach((nodeId, idx) => nodeIndex.set(nodeId, idx));

	const n = nonGroundNodes.length;
	const m = voltageSources.length;
	const size = n + m;

	const matrix = Array.from({ length: size }, () => new Array(size).fill(0));
	const rhs = new Array(size).fill(0);

	const stampConductance = (a: number, b: number, g: number) => {
		const ia = nodeIndex.get(a);
		const ib = nodeIndex.get(b);
		if (ia !== undefined) matrix[ia][ia] += g;
		if (ib !== undefined) matrix[ib][ib] += g;
		if (ia !== undefined && ib !== undefined) {
			matrix[ia][ib] -= g;
			matrix[ib][ia] -= g;
		}
	};

	for (const element of groundedElements) {
		if (element.type !== 'resistor') continue;
		stampConductance(element.nodes[0], element.nodes[1], 1 / element.resistanceOhms);
	}

	const transistorElements = groundedElements.filter((element) => element.type === 'transistor');
	const transistorIterations = transistorElements.length > 0 ? 6 : 1;
	const totalIterations = Math.max(transistorIterations, relayIterations);
	const transistorOnResistance = 120;
	const transistorOffResistance = 1_000_000_000;
	const transistorVbeOn = 0.58;
	const transistorVbeSpan = 0.12;

	const computeTransistorConductance = (
		polarity: 'npn' | 'pnp',
		baseVoltage: number,
		emitterVoltage: number
	): number => {
		const control = polarity === 'npn' ? baseVoltage - emitterVoltage : emitterVoltage - baseVoltage;
		const alpha = Math.max(0, Math.min(1, (control - transistorVbeOn) / transistorVbeSpan));
		const resistance = transistorOffResistance * (1 - alpha) + transistorOnResistance * alpha;
		return 1 / resistance;
	};

	let estimateVoltages: Record<number, number> = { [netlist.groundNodeId]: 0 };
	let solutionVector: number[] | null = null;

	for (let iteration = 0; iteration < totalIterations; iteration++) {
		for (let row = 0; row < size; row++) {
			matrix[row].fill(0);
			rhs[row] = 0;
		}

		for (const element of groundedElements) {
			if (element.type !== 'resistor') continue;
			stampConductance(element.nodes[0], element.nodes[1], 1 / element.resistanceOhms);
		}

		for (const transistor of transistorElements) {
			const vb = estimateVoltages[transistor.baseNode] ?? 0;
			const ve = estimateVoltages[transistor.emitterNode] ?? 0;
			const gCe = computeTransistorConductance(transistor.polarity, vb, ve);
			stampConductance(transistor.collectorNode, transistor.emitterNode, gCe);
		}

		stampRelays();

		voltageSources.forEach((source, idx) => {
			const row = n + idx;
			const ip = nodeIndex.get(source.positiveNode);
			const ineg = nodeIndex.get(source.negativeNode);

			if (ip !== undefined) {
				matrix[ip][row] += 1;
				matrix[row][ip] += 1;
			}
			if (ineg !== undefined) {
				matrix[ineg][row] -= 1;
				matrix[row][ineg] -= 1;
			}
			rhs[row] = source.voltage;
		});

		solutionVector = solveLinearSystem(matrix, rhs);
		if (!solutionVector) break;

		estimateVoltages = { [netlist.groundNodeId]: 0 };
		nonGroundNodes.forEach((nodeId, idx) => {
			estimateVoltages[nodeId] = solutionVector?.[idx] ?? 0;
		});
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
	nonGroundNodes.forEach((nodeId, idx) => {
		nodeVoltages[nodeId] = solutionVector[idx];
	});

	const sourceCurrents: Record<string, number> = {};
	voltageSources.forEach((source, idx) => {
		sourceCurrents[source.componentId] = solutionVector[n + idx];
	});

	return {
		ok: true,
		nodeVoltages,
		sourceCurrents,
		warnings
	};
}

