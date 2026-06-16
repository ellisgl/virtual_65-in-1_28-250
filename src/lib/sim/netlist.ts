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

		if (component.kind === 'earphone') {
			const leakageOhms = asNumber(component.model?.params?.leakageResistanceOhms) ?? 1_000_000;
			const capF = asNumber(component.model?.params?.capacitanceFarads) ?? 2.65e-7;
			if (binding.nodeIds.length !== 2 || capF <= 0 || leakageOhms <= 0) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Earphone requires two nodes and positive capacitance/leakage params'
				});
				continue;
			}
			// A piezo/crystal earphone is electrically a small capacitor (its
			// "600 Ω" rating is |Z| at ~1 kHz, not a real resistance) with a
			// high parallel bleed resistance.  Model both across the two
			// terminals; the audio output is the voltage developed across them.
			elements.push({
				type: 'capacitor',
				componentId: `${component.id}:C`,
				nodes: [binding.nodeIds[0], binding.nodeIds[1]],
				capacitanceFarads: capF,
				initialVoltage: 0
			});
			elements.push({
				type: 'resistor',
				componentId: `${component.id}:Rleak`,
				nodes: [binding.nodeIds[0], binding.nodeIds[1]],
				resistanceOhms: leakageOhms
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

			// Emit battery if either terminal is wired into the circuit.
			// The positive check alone can silently drop a battery that is
			// wired with only its negative terminal connected (e.g. straight
			// to ground without routing the positive side yet).
			if (!connectedNodeSet.has(positiveNode) && !connectedNodeSet.has(negativeNode)) {
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

		if (component.kind === 'cds') {
			// CdS photoresistor.  Two-terminal element whose resistance is
			// set by the user-controlled light level (0 = dark → R = value,
			// 1 = bright → R = metadata.lightResistance).  Log-linear
			// interpolation matches the decade-per-log-lux response of a
			// real CdS cell — at position 0.5 you get the geometric mean
			// of dark and light, not the arithmetic mean, which would be
			// dominated by the (much larger) dark value.
			const darkOhms   = asNumber(valueOverrides[component.id] ?? component.value);
			const brightOhms = asNumber(component.metadata?.lightResistance);
			const position   = clamp(
				asNumber(positionOverrides[component.id] ?? component.metadata?.defaultPosition) ?? 0.5,
				0,
				1
			);

			if (
				darkOhms === null   || darkOhms   <= 0 ||
				brightOhms === null || brightOhms <= 0
			) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'CdS requires a positive `value` (dark resistance) and metadata.lightResistance (bright resistance)'
				});
				continue;
			}

			const [terminalA, terminalB] = component.terminals;
			const nodeA = topology.terminalToNode[terminalA];
			const nodeB = topology.terminalToNode[terminalB];
			if (typeof nodeA !== 'number' || typeof nodeB !== 'number') {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'CdS terminals are missing topology node bindings'
				});
				continue;
			}
			// Float check — if either node has no connection elsewhere the
			// resistor would dangle and bloat the MNA without contributing,
			// so we skip it (matches resistor/potentiometer behaviour).
			if (!connectedNodeSet.has(nodeA) || !connectedNodeSet.has(nodeB)) {
				continue;
			}

			// Log-linear: R(pos) = darkR · (lightR/darkR)^pos
			//   pos=0   → R = darkR
			//   pos=0.5 → R = sqrt(darkR · lightR)   (geometric mean)
			//   pos=1   → R = lightR
			const resistanceOhms = darkOhms * Math.pow(brightOhms / darkOhms, position);

			elements.push({
				type: 'resistor',
				componentId: component.id,
				nodes: [nodeA, nodeB],
				resistanceOhms
			});
			continue;
		}
		
		if (component.kind === 'solar-cell') {
			// Solar cell.  Outputs a voltage up to 0.5V depending on light level.
			const maxVoltage = asNumber(valueOverrides[component.id] ?? component.value) ?? 0.5;
			const position = clamp(
				asNumber(positionOverrides[component.id] ?? component.metadata?.defaultPosition) ?? 0.5,
				0,
				1
			);

			const positiveTerminal = asNumber(component.metadata?.positive);
			const negativeTerminal = asNumber(component.metadata?.negative);
			const positiveNode = positiveTerminal === null ? undefined : topology.terminalToNode[positiveTerminal];
			const negativeNode = negativeTerminal === null ? undefined : topology.terminalToNode[negativeTerminal];

			if (typeof positiveNode !== 'number' || typeof negativeNode !== 'number') {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Solar cell terminals are missing topology node bindings'
				});
				continue;
			}

			if (!connectedNodeSet.has(positiveNode) && !connectedNodeSet.has(negativeNode)) {
				continue;
			}

			// Linear output: 0 at dark (0), max at bright (1).
			const voltage = maxVoltage * position;

			elements.push({
				type: 'voltage-source',
				componentId: component.id,
				positiveNode,
				negativeNode,
				voltage
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
					reason: `Transistor terminals (B:${base}, C:${collector}, E:${emitter}) are missing topology node bindings`
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
			const coilInductanceH = asNumber(component.model?.params?.inductance) ?? 0;
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

			// The relay's coil inductance matters: in self-interrupting (buzzer)
			// circuits, the L/R rise time of the coil current is what sets the
			// buzz rate.  The WASM relay element models the coil as pure
			// resistance + hysteresis switch, so without this series inductor
			// the relay chatters at solver-step rate (~70 kHz, ultrasonic and
			// numerically nasty) instead of buzzing at the mechanical ~330 Hz
			// the same model produces with L included.  At DC the inductor is
			// a short, so stable relay circuits are unaffected.
			let relayCoilPositiveNode = coilPositiveNode;
			if (coilInductanceH > 0) {
				const coilMid = allocInternalNode();
				elements.push({
					type: 'inductor',
					componentId: `${component.id}:Lcoil`,
					nodes: [coilPositiveNode, coilMid],
					inductanceHenry: coilInductanceH
				});
				relayCoilPositiveNode = coilMid;
			}

			elements.push({
				type: 'relay',
				componentId: component.id,
				coilPositiveNode: relayCoilPositiveNode,
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
			const k = asNumber(component.metadata?.coupling) ?? 0.999;

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
			const couplingGroup = `${component.id}:core`;
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

		if (component.kind === 'diode' || component.kind === 'zener-diode') {
			const params = component.model?.params ?? {};
			const is  = Math.max(asNumber(params.is)  ?? 1e-14, 1e-20);
			const n   = Math.max(asNumber(params.n)   ?? 1,     0.5);
			const rs  = Math.max(asNumber(params.rs)  ?? 0,     0);
			// bv only meaningful for zener-diode; regular diode has no breakdown model.
			const bv  = component.kind === 'zener-diode' ? (asNumber(params.bv) ?? undefined) : undefined;
			const ibv = asNumber(params.ibv) ?? 1e-3;

			if (binding.nodeIds.length !== 2) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'Diode requires exactly two terminals'
				});
				continue;
			}

			// Convention: first terminal = anode, second = cathode.
			let anodeNode    = binding.nodeIds[0];
			const cathodeNode = binding.nodeIds[1];

			// Series resistance — allocate an internal mid-node so the junction
			// itself is between midNode and cathode, with Rs between anode and midNode.
			if (rs > 0) {
				const midNode = allocInternalNode();
				elements.push({
					type: 'resistor',
					componentId: `${component.id}:Rs`,
					nodes: [anodeNode, midNode],
					resistanceOhms: rs
				});
				anodeNode = midNode;
			}

			elements.push({
				type: 'diode',
				componentId: component.id,
				anodeNode,
				cathodeNode,
				is,
				n,
				bv,
				ibv: bv !== undefined ? ibv : undefined
			});
			continue;
		}

		if (component.kind === 'scr') {
			// Expand the C103Y subcircuit into its two-BJT equivalent:
			//   .SUBCKT C103Y 1(anode) 2(gate) 3(cathode)
			//     QP 4(internal) 1 2 QPNP   ; col=internal, base=anode, emit=gate
			//     QN 2 4 3 QNPN             ; col=gate, base=internal, emit=cathode
			//     RGK 2 3 1k
			//   .ENDS
			const gate    = asNumber(component.metadata?.gate);
			const anode   = asNumber(component.metadata?.anode);
			const cathode = asNumber(component.metadata?.cathode);

			if (gate === null || anode === null || cathode === null) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'SCR requires gate/anode/cathode metadata'
				});
				continue;
			}

			const gateNode    = topology.terminalToNode[gate];
			const anodeNode   = topology.terminalToNode[anode];
			const cathodeNode = topology.terminalToNode[cathode];

			if (
				typeof gateNode    !== 'number' ||
				typeof anodeNode   !== 'number' ||
				typeof cathodeNode !== 'number'
			) {
				unsupported.push({
					componentId: component.id,
					kind: component.kind,
					reason: 'SCR terminals are missing topology node bindings'
				});
				continue;
			}

			const params         = component.model?.params ?? {};
			const gateResistance = asNumber(params.gateResistance) ?? 1000;
			const internalNode   = allocInternalNode();

			// QP (PNP): collector=internal, base=anode, emitter=gate
			elements.push({
				type: 'transistor',
				componentId: `${component.id}:QP`,
				polarity: 'pnp',
				baseNode:      anodeNode,
				collectorNode: internalNode,
				emitterNode:   gateNode,
				beta:       asNumber(params.qpnpBf)  ?? 5,
				is:         asNumber(params.qpnpIs)  ?? 1e-14,
				nf: 1, nr: 1,
				vaf:        asNumber(params.qpnpVaf) ?? 30,
				cjeFarads:  asNumber(params.qpnpCje) ?? 20e-12,
				cjcFarads:  0
			});

			// QN (NPN): collector=gate, base=internal, emitter=cathode
			elements.push({
				type: 'transistor',
				componentId: `${component.id}:QN`,
				polarity: 'npn',
				baseNode:      internalNode,
				collectorNode: gateNode,
				emitterNode:   cathodeNode,
				beta:       asNumber(params.qnpnBf)  ?? 100,
				is:         asNumber(params.qnpnIs)  ?? 1e-14,
				nf: 1, nr: 1,
				vaf:        asNumber(params.qnpnVaf) ?? 30,
				cjeFarads:  asNumber(params.qnpnCje) ?? 20e-12,
				cjcFarads:  0
			});

			// RGK: gate to cathode resistor stabilises the loop
			elements.push({
				type: 'resistor',
				componentId: `${component.id}:RGK`,
				nodes: [gateNode, cathodeNode],
				resistanceOhms: gateResistance
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

