import type {
	CircuitTopology,
	KitComponent,
	SimulationElement,
	SimulationBuildOptions,
	SimulationNetlist,
	UnsupportedElement
} from '$lib/types';

function usesConnectedNode(nodeIds: number[], connected: Set<number>): boolean {
	return nodeIds.some((id) => connected.has(id));
}

function asNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function buildSimulationNetlist(
	topology: CircuitTopology,
	components: KitComponent[],
	options: SimulationBuildOptions = {}
): SimulationNetlist {
	const componentById = new Map(components.map((component) => [component.id, component]));
	const connectedNodeSet = new Set(topology.connectedNodeIds);
	const valueOverrides = options.valueOverrides ?? {};
	const positionOverrides = options.positionOverrides ?? {};
	const switchStates = options.switchStates ?? {};

	const elements: SimulationElement[] = [];
	const unsupported: UnsupportedElement[] = [];

	for (const binding of topology.componentBindings) {
		const component = componentById.get(binding.componentId);
		if (!component) {
			unsupported.push({
				componentId: binding.componentId,
				kind: binding.componentKind,
				reason: 'Component data not found in catalog'
			});
			continue;
		}

		if (!usesConnectedNode(binding.nodeIds, connectedNodeSet)) {
			continue;
		}

		if (component.kind === 'resistor') {
			const resistanceOhms = asNumber(valueOverrides[component.id] ?? component.value);
			if (binding.nodeIds.length !== 2 || resistanceOhms === null || resistanceOhms <= 0) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Resistor requires two nodes and a positive resistance value'
				});
				continue;
			}
			elements.push({
				type: 'resistor',
				componentId: component.id,
				nodes: [binding.nodeIds[0], binding.nodeIds[1]],
				resistanceOhms
			});
			continue;
		}

		if (component.kind === 'speaker') {
			const resistanceOhms = asNumber(valueOverrides[component.id] ?? component.value);
			if (binding.nodeIds.length !== 2 || resistanceOhms === null || resistanceOhms <= 0) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Speaker requires two nodes and a positive impedance value'
				});
				continue;
			}
			elements.push({
				type: 'resistor',
				componentId: component.id,
				nodes: [binding.nodeIds[0], binding.nodeIds[1]],
				resistanceOhms
			});
			continue;
		}

		if (component.kind === 'battery') {
			const voltage = asNumber(valueOverrides[component.id] ?? component.value);
			const positiveTerminal = asNumber(component.metadata?.positive);
			const negativeTerminal = asNumber(component.metadata?.negative);
			const positiveNode = positiveTerminal === null ? undefined : topology.terminalToNode[positiveTerminal];
			const negativeNode = negativeTerminal === null ? undefined : topology.terminalToNode[negativeTerminal];

			if (voltage === null || typeof positiveNode !== 'number' || typeof negativeNode !== 'number') {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Battery requires positive/negative metadata and a numeric voltage'
				});
				continue;
			}

			elements.push({
				type: 'voltage-source',
				componentId: component.id,
				positiveNode,
				negativeNode,
				voltage
			});
			continue;
		}

		if (component.kind === 'capacitor' || component.kind === 'variable-capacitor') {
			const capacitanceFarads = asNumber(valueOverrides[component.id] ?? component.value);
			const initialVoltage = asNumber(component.metadata?.initialVoltage) ?? 0;

			if (binding.nodeIds.length !== 2 || capacitanceFarads === null || capacitanceFarads <= 0) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Capacitor requires two nodes and a positive capacitance value'
				});
				continue;
			}

			elements.push({
				type: 'capacitor',
				componentId: component.id,
				nodes: [binding.nodeIds[0], binding.nodeIds[1]],
				capacitanceFarads,
				initialVoltage
			});
			continue;
		}

		if (component.kind === 'potentiometer') {
			const totalResistanceOhms = asNumber(valueOverrides[component.id] ?? component.value);
			const endA = asNumber(component.metadata?.endA);
			const wiper = asNumber(component.metadata?.wiper);
			const endB = asNumber(component.metadata?.endB);
			const rheostatExponent = asNumber(component.metadata?.rheostatExponent) ?? 3;
			const position = clamp(
				asNumber(positionOverrides[component.id] ?? component.metadata?.defaultPosition) ?? 0.5,
				0,
				1
			);

			if (
				totalResistanceOhms === null ||
				totalResistanceOhms <= 0 ||
				endA === null ||
				wiper === null ||
				endB === null
			) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Potentiometer requires endA/wiper/endB metadata and a positive resistance value'
				});
				continue;
			}

			const nodeA = topology.terminalToNode[endA];
			const nodeWiper = topology.terminalToNode[wiper];
			const nodeB = topology.terminalToNode[endB];

			if (
				typeof nodeA !== 'number' ||
				typeof nodeWiper !== 'number' ||
				typeof nodeB !== 'number'
			) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Potentiometer terminals are missing topology node bindings'
				});
				continue;
			}

			const minSegmentResistance = 1e-6;
			const nodeAConnected = connectedNodeSet.has(nodeA);
			const nodeBConnected = connectedNodeSet.has(nodeB);

			let positionA = position;
			let positionB = 1 - position;

			// If one end is floating, behave like a rheostat with a tapered low-end response.
			if (nodeAConnected && !nodeBConnected) {
				positionA = Math.pow(position, rheostatExponent);
			}
			if (nodeBConnected && !nodeAConnected) {
				positionB = Math.pow(1 - position, rheostatExponent);
			}

			const resistanceA = Math.max(totalResistanceOhms * positionA, minSegmentResistance);
			const resistanceB = Math.max(totalResistanceOhms * positionB, minSegmentResistance);

			elements.push({
				type: 'resistor',
				componentId: `${component.id}:A`,
				nodes: [nodeA, nodeWiper],
				resistanceOhms: resistanceA
			});
			elements.push({
				type: 'resistor',
				componentId: `${component.id}:B`,
				nodes: [nodeWiper, nodeB],
				resistanceOhms: resistanceB
			});
			continue;
		}

		if (component.kind === 'lamp') {
			const nominalVoltage = asNumber(component.model?.params?.nominalVoltage);
			const nominalPower = asNumber(component.model?.params?.nominalPower);

			if (binding.nodeIds.length !== 2 || nominalVoltage === null || nominalPower === null || nominalPower <= 0) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Lamp requires two nodes and model params nominalVoltage/nominalPower'
				});
				continue;
			}

			const resistanceOhms = (nominalVoltage * nominalVoltage) / nominalPower;
			elements.push({
				type: 'resistor',
				componentId: component.id,
				nodes: [binding.nodeIds[0], binding.nodeIds[1]],
				resistanceOhms
			});
			continue;
		}

		if (component.kind === 'transistor') {
			const polarity = component.model?.params?.polarity;
			const base = asNumber(component.metadata?.base);
			const collector = asNumber(component.metadata?.collector);
			const emitter = asNumber(component.metadata?.emitter);
			const beta = asNumber(component.model?.params?.bf) ?? 100;
			const is = asNumber(component.model?.params?.is) ?? 1e-15;
			const nf = asNumber(component.model?.params?.nf) ?? 1;
			const vafModel = asNumber(component.model?.params?.vaf) ?? 100;
			const cjeFarads = asNumber(component.model?.params?.cje) ?? 0;
			const cjcFarads = asNumber(component.model?.params?.cjc) ?? 0;

			if (
				(polarity !== 'npn' && polarity !== 'pnp') ||
				base === null ||
				collector === null ||
				emitter === null
			) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Transistor requires model polarity and base/collector/emitter metadata'
				});
				continue;
			}

			const baseNode = topology.terminalToNode[base];
			const collectorNode = topology.terminalToNode[collector];
			const emitterNode = topology.terminalToNode[emitter];
			if (
				typeof baseNode !== 'number' ||
				typeof collectorNode !== 'number' ||
				typeof emitterNode !== 'number'
			) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Transistor terminals are missing topology node bindings'
				});
				continue;
			}

			elements.push({
				type: 'transistor',
				componentId: component.id,
				polarity,
				baseNode,
				collectorNode,
				emitterNode,
				beta,
				is,
				nf,
				vaf: Math.max(Math.abs(vafModel), 1),
				cjeFarads: Math.max(cjeFarads, 0),
				cjcFarads: Math.max(cjcFarads, 0)
			});
			continue;
		}

		if (component.kind === 'relay') {
			const coilPositive = asNumber(component.metadata?.coilPositive) ?? component.terminals[0] ?? null;
			const coilNegative = asNumber(component.metadata?.coilNegative) ?? component.terminals[1] ?? null;
			const common = asNumber(component.metadata?.common) ?? component.terminals[2] ?? null;
			const normallyClosed =
				asNumber(component.metadata?.normallyClosed) ?? component.terminals[3] ?? null;
			const normallyOpen = asNumber(component.metadata?.normallyOpen) ?? component.terminals[4] ?? null;

			const coilResistanceOhms = asNumber(component.model?.params?.coilResistanceOhms) ?? 150;
			const ronOhms = asNumber(component.model?.params?.ron) ?? 0.05;
			const roffOhms = asNumber(component.model?.params?.roff) ?? 1_000_000;
			const onCurrent = asNumber(component.model?.params?.onCurrent) ?? 0.02;
			const offCurrent = asNumber(component.model?.params?.offCurrent) ?? 0.015;

			if (
				coilPositive === null ||
				coilNegative === null ||
				common === null ||
				normallyClosed === null ||
				normallyOpen === null ||
				coilResistanceOhms <= 0 ||
				ronOhms <= 0 ||
				offCurrent <= 0 ||
				onCurrent <= 0
			) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Relay requires coil/contact terminal metadata and valid model params'
				});
				continue;
			}

			const coilPositiveNode = topology.terminalToNode[coilPositive];
			const coilNegativeNode = topology.terminalToNode[coilNegative];
			const commonNode = topology.terminalToNode[common];
			const normallyClosedNode = topology.terminalToNode[normallyClosed];
			const normallyOpenNode = topology.terminalToNode[normallyOpen];

			if (
				typeof coilPositiveNode !== 'number' ||
				typeof coilNegativeNode !== 'number' ||
				typeof commonNode !== 'number' ||
				typeof normallyClosedNode !== 'number' ||
				typeof normallyOpenNode !== 'number'
			) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Relay terminals are missing topology node bindings'
				});
				continue;
			}

			elements.push({
				type: 'relay',
				componentId: component.id,
				coilPositiveNode,
				coilNegativeNode,
				commonNode,
				normallyClosedNode,
				normallyOpenNode,
				coilResistanceOhms,
				ronOhms,
				roffOhms,
				onCurrent,
				offCurrent
			});
			continue;
		}

		if (component.kind === 'transformer') {
			const primaryStart = asNumber(component.metadata?.primaryStart);
			const primaryCenterTap = asNumber(component.metadata?.primaryCenterTap);
			const primaryEnd = asNumber(component.metadata?.primaryEnd);
			const secondaryStart = asNumber(component.metadata?.secondaryStart);
			const secondaryEnd = asNumber(component.metadata?.secondaryEnd);
			const rp1Ohm = asNumber(component.metadata?.rp1Ohm);
			const rp2Ohm = asNumber(component.metadata?.rp2Ohm);
			const rsOhm = asNumber(component.metadata?.rsOhm);
			const turnsRatioApprox = asNumber(component.metadata?.turnsRatioApprox);
			const ratioParameter = asNumber(component.metadata?.ratioParameter);
			const turnsRatio =
				turnsRatioApprox ??
				(ratioParameter !== null && ratioParameter > 0 ? 1 / ratioParameter : null);

			if (
				primaryStart === null ||
				primaryCenterTap === null ||
				primaryEnd === null ||
				secondaryStart === null ||
				secondaryEnd === null ||
				rp1Ohm === null ||
				rp2Ohm === null ||
				rsOhm === null ||
				turnsRatio === null ||
				turnsRatio <= 0 ||
				rp1Ohm <= 0 ||
				rp2Ohm <= 0 ||
				rsOhm <= 0
			) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason:
						'Transformer requires winding terminal metadata, positive winding resistances, and a positive turns ratio'
				});
				continue;
			}

			const nodePrimaryStart = topology.terminalToNode[primaryStart];
			const nodePrimaryCenter = topology.terminalToNode[primaryCenterTap];
			const nodePrimaryEnd = topology.terminalToNode[primaryEnd];
			const nodeSecondaryStart = topology.terminalToNode[secondaryStart];
			const nodeSecondaryEnd = topology.terminalToNode[secondaryEnd];

			if (
				typeof nodePrimaryStart !== 'number' ||
				typeof nodePrimaryCenter !== 'number' ||
				typeof nodePrimaryEnd !== 'number' ||
				typeof nodeSecondaryStart !== 'number' ||
				typeof nodeSecondaryEnd !== 'number'
			) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Transformer terminals are missing topology node bindings'
				});
				continue;
			}

			elements.push({
				type: 'resistor',
				componentId: `${component.id}:P1`,
				nodes: [nodePrimaryStart, nodePrimaryCenter],
				resistanceOhms: rp1Ohm
			});
			elements.push({
				type: 'resistor',
				componentId: `${component.id}:P2`,
				nodes: [nodePrimaryCenter, nodePrimaryEnd],
				resistanceOhms: rp2Ohm
			});
			elements.push({
				type: 'resistor',
				componentId: `${component.id}:S`,
				nodes: [nodeSecondaryStart, nodeSecondaryEnd],
				resistanceOhms: rsOhm
			});
			elements.push({
				type: 'transformer',
				componentId: component.id,
				primaryNodeA: nodePrimaryStart,
				primaryNodeB: nodePrimaryEnd,
				secondaryNodeA: nodeSecondaryStart,
				secondaryNodeB: nodeSecondaryEnd,
				turnsRatio
			});
			continue;
		}

		if (component.kind === 'switch') {
			// Open (normallyOpen default) — only compile when closed.
			const closed = switchStates[component.id] ?? false;
			if (!closed) continue; // open circuit — no element emitted

			if (binding.nodeIds.length !== 2) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Switch requires exactly two nodes'
				});
				continue;
			}
			elements.push({
				type: 'resistor',
				componentId: component.id,
				nodes: [binding.nodeIds[0], binding.nodeIds[1]],
				resistanceOhms: 0.001 // closed contact
			});
			continue;
		}

		if (component.kind === 'voltmeter') {
			// Ideal voltmeter: infinite impedance, so it does not load the circuit.
			continue;
		}

		if (component.kind === 'antenna') {
			// External input placeholder for now; intentionally a runtime no-op.
			continue;
		}

		// Fallthrough — not implemented
		unsupported.push({
			componentId: component.id,
			kind: component.kind,
			reason: 'Not implemented in runtime netlist compiler yet'
		});
	}

	return {
		elements,
		unsupported,
		groundNodeId: topology.groundNodeId,
		connectedNodeIds: topology.connectedNodeIds
	};
}

