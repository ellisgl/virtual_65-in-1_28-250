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

	// Internal nodes for subcircuit expansion (speaker RL, etc.) sit above all
	// topology node IDs. Find the max used node id first.
	const maxTopologyNodeId = topology.connectedNodeIds.reduce((m, id) => Math.max(m, id), 0);
	let nextInternalNodeId = maxTopologyNodeId + 10_000; // leave headroom
	const allocInternalNode = () => nextInternalNodeId++;

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
			// Model speaker as a voice-coil series RL:
			//   nodeA --[Rvc]-- midNode --[Lvc]-- nodeB
			// Rvc = DC resistance of voice coil (~same as rated impedance for 8Ω speaker)
			// Lvc = voice-coil inductance (typical 8Ω wideband: ~0.3 mH)
			const midNode = allocInternalNode();
			elements.push({
				type: 'resistor',
				componentId: `${component.id}:Rvc`,
				nodes: [binding.nodeIds[0], midNode],
				resistanceOhms
			});
			elements.push({
				type: 'inductor',
				componentId: `${component.id}:Lvc`,
				nodes: [midNode, binding.nodeIds[1]],
				inductanceHenry: 0.3e-3 // 0.3 mH typical 8 Ω voice coil
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

			// Only include battery if its positive terminal is wired into the circuit.
			// The negative terminal is often ground and always "connected", so checking
			// only the positive side tells us whether this battery is actually in use.
			if (!connectedNodeSet.has(positiveNode)) {
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

			// If one end is floating, behave like a rheostat.
			// Apply the taper to the *active* segment so the knob sweeps the full
			// resistance range with a musically useful curve.
			if (nodeAConnected && !nodeBConnected) {
				// endB floating — wiper→endA is the active segment. position=0 → min R.
				positionA = Math.pow(position, rheostatExponent);
			}
			if (nodeBConnected && !nodeAConnected) {
				// endA floating — wiper→endB is the active segment. position=1 → min R.
				positionB = Math.pow(position, rheostatExponent);
			}

			const resistanceA = Math.max(totalResistanceOhms * positionA, minSegmentResistance);
			const resistanceB = Math.max(totalResistanceOhms * positionB, minSegmentResistance);

			// Only emit a segment if both its nodes are connected.
			// Emitting a segment with a floating end creates a phantom conductance
			// to an unconnected node which corrupts circuit behaviour.
			if (nodeAConnected) {
				elements.push({
					type: 'resistor',
					componentId: `${component.id}:A`,
					nodes: [nodeA, nodeWiper],
					resistanceOhms: resistanceA
				});
			}
			if (nodeBConnected) {
				elements.push({
					type: 'resistor',
					componentId: `${component.id}:B`,
					nodes: [nodeWiper, nodeB],
					resistanceOhms: resistanceB
				});
			}
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
			const params = component.model?.params ?? {};
			const polarity = params.polarity;
			const base = asNumber(component.metadata?.base);
			const collector = asNumber(component.metadata?.collector);
			const emitter = asNumber(component.metadata?.emitter);

			// Core Gummel-Poon parameters (with sensible defaults).
			const beta = asNumber(params.bf) ?? 100;
			const br   = asNumber(params.br) ?? 1;
			const is   = asNumber(params.is) ?? 1e-15;
			const nf   = asNumber(params.nf) ?? 1;
			const nr   = asNumber(params.nr) ?? 1;
			const vafModel = asNumber(params.vaf) ?? 100;
			const varModel = asNumber(params.var) ?? 100;
			const ikf  = asNumber(params.ikf) ?? undefined;
			const ikr  = asNumber(params.ikr) ?? undefined;
			const ise  = asNumber(params.ise) ?? undefined;
			const ne   = asNumber(params.ne)  ?? undefined;
			const isc  = asNumber(params.isc) ?? undefined;
			const nc   = asNumber(params.nc)  ?? undefined;
			// Junction caps + transit times
			const cjeFarads = asNumber(params.cje) ?? 0;
			const cjcFarads = asNumber(params.cjc) ?? 0;
			const tfSeconds = asNumber(params.tf) ?? undefined;
			const trSeconds = asNumber(params.tr) ?? undefined;

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
				br,
				is,
				nf,
				nr,
				vaf: Math.max(Math.abs(vafModel), 1),
				var: Math.max(Math.abs(varModel), 1),
				ikf,
				ikr,
				ise,
				ne,
				isc,
				nc,
				cjeFarads: Math.max(cjeFarads, 0),
				cjcFarads: Math.max(cjcFarads, 0),
				tfSeconds,
				trSeconds
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
			const lp1H = asNumber(component.metadata?.lp1H) ?? 0.4;
			const lsH = asNumber(component.metadata?.lsH) ?? 0.004;

			if (primaryStart===null || primaryCenterTap===null || primaryEnd===null ||
				secondaryStart===null || secondaryEnd===null ||
				rp1Ohm===null || rp2Ohm===null || rsOhm===null) {
				unsupported.push({ componentId: component.id, kind: component.kind, reason: 'Transformer requires winding terminal metadata' });
				continue;
			}

			const allTxTerminals = [primaryStart, primaryCenterTap, primaryEnd, secondaryStart, secondaryEnd];
			if (!allTxTerminals.map(t => topology.terminalToNode[t]).some(n => typeof n==='number' && connectedNodeSet.has(n))) continue;

			const nPs = topology.terminalToNode[primaryStart];
			const nPc = topology.terminalToNode[primaryCenterTap];
			const nPe = topology.terminalToNode[primaryEnd];
			const nSs = topology.terminalToNode[secondaryStart];
			const nSe = topology.terminalToNode[secondaryEnd];

			if (typeof nPs!=='number' || typeof nPc!=='number' || typeof nPe!=='number' ||
				typeof nSs!=='number' || typeof nSe!=='number') {
				unsupported.push({ componentId: component.id, kind: component.kind, reason: 'Transformer terminals missing node bindings' });
				continue;
			}

			// Transformer model: three coupled inductors sharing one magnetic core.
			//   • Lp1 (half-primary 1) — Q2 collector side
			//   • Lp2 (half-primary 2) — feedback winding to Q2 base
			//   • Ls  (secondary)      — drives speaker
			//
			// All three share a coupling group. The two primary halves are wound
			// in the SAME direction toward the center tap (+1 polarity), so flux
			// adds when current flows from outer terminals toward the centre.
			// Because Lp2 connects to the BASE side via C2, when collector
			// current rises through Lp1, the induced EMF in Lp2 drives the
			// base further negative (PNP), latching Q2 ON harder. This is the
			// regenerative feedback that makes the blocking oscillator slow.
			//
			// Coupling coefficient. Reads from metadata (datasheet says k=0.995),
			// but in practice the simulator's branch-current MNA needs a lower value
			// to avoid violent overshoot. k=0.1 is the empirically-tuned value
			// that gives stable simulation; the reflected secondary load and
			// the BJT junction caps provide additional damping.
			const couplingGroup = `${component.id}:core`;
			const kFromMeta = asNumber(component.metadata?.coupling);
			const k = kFromMeta !== null && kFromMeta > 0 && kFromMeta < 1 ? Math.min(kFromMeta, 0.1) : 0.1;
			const lsHeff = lsH; // secondary inductance from metadata (~4mH)

			const midP1 = allocInternalNode();
			const midP2 = allocInternalNode();
			const midS  = allocInternalNode();

			// Half-primary 1: nPs --[Rp1]-- midP1 --[Lp1]-- nPc with parallel damping
			elements.push({ type: 'resistor', componentId: `${component.id}:Rp1`, nodes: [nPs, midP1], resistanceOhms: rp1Ohm });
			const iSatPrimary = 9 / rp1Ohm; // ~200mA, set by transistor saturation
			elements.push({
				type: 'inductor', componentId: `${component.id}:Lp1`,
				nodes: [midP1, nPc], inductanceHenry: lp1H,
				saturationCurrentA: iSatPrimary,
				couplingGroup, couplingPolarity: 1,
			});
			// Core-loss / eddy-current damping. Without this, residual flux after
			// the main snap takes too long to dissipate, causing spurious sub-pulses
			// before the C7 recharge phase. Real LT700-class transformers have
			// effective parallel R of a few kΩ from core hysteresis.
			const rCoreLoss = 1500; // 1.5 kΩ — empirically tuned
			elements.push({
				type: 'resistor', componentId: `${component.id}:Rcore1`,
				nodes: [midP1, nPc], resistanceOhms: rCoreLoss,
			});

			// Half-primary 2 (with parallel damping)
			elements.push({ type: 'resistor', componentId: `${component.id}:Rp2`, nodes: [nPe, midP2], resistanceOhms: rp2Ohm });
			elements.push({
				type: 'inductor', componentId: `${component.id}:Lp2`,
				nodes: [midP2, nPc], inductanceHenry: lp1H,
				saturationCurrentA: iSatPrimary,
				couplingGroup, couplingPolarity: -1,
			});
			elements.push({
				type: 'resistor', componentId: `${component.id}:Rcore2`,
				nodes: [midP2, nPc], resistanceOhms: rCoreLoss,
			});

			// Secondary
			elements.push({ type: 'resistor', componentId: `${component.id}:Rs`, nodes: [nSs, midS], resistanceOhms: rsOhm });
			elements.push({
				type: 'inductor', componentId: `${component.id}:Ls`,
				nodes: [midS, nSe], inductanceHenry: lsHeff,
				couplingGroup, couplingPolarity: 1,
			});

			// Coupling element binding all three windings together.
			elements.push({
				type: 'coupling', componentId: `${component.id}:K`,
				couplingGroup, k,
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

