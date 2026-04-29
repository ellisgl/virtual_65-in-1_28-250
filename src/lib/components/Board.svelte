<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { KIT_COMPONENTS, KIT_TERMINAL_IDS, TERMINAL_POSITIONS, isTerminalPositionMapped } from '$lib/data';
	import Terminal from '$lib/components/Terminal.svelte';
	import VariableKnob from '$lib/components/VariableKnob.svelte';
	import WiringLayer from '$lib/components/WiringLayer.svelte';
	import {
		buildSimulationNetlist,
		GROUND_TERMINAL_IDS,
		initializeTransientState,
		solveDcNetlist,
		stepTransientNetlist
	} from '$lib/sim';
	import { wiresStore } from '$lib/stores/wires.svelte';
	import type { TransientResult, TransientState } from '$lib/types';

	const mappedTerminalIds = KIT_TERMINAL_IDS.filter((id) => isTerminalPositionMapped(id));
	const unmappedCount = KIT_TERMINAL_IDS.length - mappedTerminalIds.length;
	const TERMINAL_SNAP_RADIUS = 4;
	const LAMP_COMPONENT = KIT_COMPONENTS.find((component) => component.id === 'LAMP1');
	const LAMP_GLOW_CENTER = { x: 353.5, y: 25.4 };
	const VARIABLE_RESISTOR_COMPONENT = KIT_COMPONENTS.find((component) => component.id === 'VR1');
	const VARIABLE_CAPACITOR_COMPONENT = KIT_COMPONENTS.find((component) => component.id === 'VC1');
	const KEY_COMPONENT = KIT_COMPONENTS.find((component) => component.id === 'KEY1');
	const VOLTMETER_COMPONENT = KIT_COMPONENTS.find((component) => component.id === 'VM1');
	const BOARD_VIEWBOX_WIDTH = 437;
	const BOARD_VIEWBOX_HEIGHT = 267;
	const METER_DIAL_CENTER = { x: 250.5, y: 162 };
	const METER_NEEDLE_MIN_ANGLE = -78;
	const METER_NEEDLE_MAX_ANGLE = 78;
	const KEY_HITBOX = { x1: 413.5, y1: 242.0, x2: 428.5, y2: 257.0 };
	const KEY_CENTER = {
		x: (KEY_HITBOX.x1 + KEY_HITBOX.x2) / 2,
		y: (KEY_HITBOX.y1 + KEY_HITBOX.y2) / 2
	};
	const variableResDefaultPosition = Number(VARIABLE_RESISTOR_COMPONENT?.metadata?.defaultPosition ?? 0.5);
	const variableCapMin = Number(VARIABLE_CAPACITOR_COMPONENT?.metadata?.min ?? VARIABLE_CAPACITOR_COMPONENT?.value ?? 1e-12);
	const variableCapMax = Number(VARIABLE_CAPACITOR_COMPONENT?.metadata?.max ?? VARIABLE_CAPACITOR_COMPONENT?.value ?? 265e-12);
	const variableCapDefault = Number(
		VARIABLE_CAPACITOR_COMPONENT?.metadata?.default ?? VARIABLE_CAPACITOR_COMPONENT?.value ?? variableCapMax
	);
	const VARIABLE_RES_KNOB_X = 37;
	const VARIABLE_RES_KNOB_Y = 190;
	const VARIABLE_RES_KNOB_RADIUS = 9.5;
	const VARIABLE_CAP_KNOB_X = 90;
	const VARIABLE_CAP_KNOB_Y = 190;
	const VARIABLE_CAP_KNOB_RADIUS = 9.5;
	const LAMP_GLOW_THRESHOLD = 0;
	const LAMP_GLOW_GAMMA = 0.55;
	const LAMP_GLOW_MIN = 0;
	const LAMP_GLOW_MAX = 1;

	let overlaySvg: SVGSVGElement;
	let topology = $derived(wiresStore.topology);
	let variableResistancePosition = $state(variableResDefaultPosition);
	let variableCapacitance = $state(variableCapDefault);
	let switchStates = $state<Record<string, boolean>>({});
	let netlist = $derived(
		buildSimulationNetlist(topology, KIT_COMPONENTS, {
			valueOverrides: VARIABLE_CAPACITOR_COMPONENT ? { VC1: variableCapacitance } : {},
			positionOverrides: VARIABLE_RESISTOR_COMPONENT ? { VR1: variableResistancePosition } : {},
			switchStates
		})
	);
	// Only reset transient state when topology/continuous controls change, not momentary key state.
	let transientResetKey = $derived(
		JSON.stringify({
			nodeBindings: topology.componentBindings,
			terminalToNode: topology.terminalToNode,
			connectedNodeIds: topology.connectedNodeIds,
			groundNodeId: topology.groundNodeId,
			vc1: variableCapacitance,
			vr1: variableResistancePosition
		})
	);
	let dc = $derived(solveDcNetlist(netlist));

	let transientDt = $state(5e-4);
	let transientRunning = $state(false);
	let transientState = $state<TransientState>({
		time: 0,
		capacitorVoltages: {},
		nodeVoltages: {},
		relayStates: {}
	});
	let transientResult = $state<TransientResult | null>(null);
	let runTimer: ReturnType<typeof setInterval> | null = null;

	let activeNodeVoltages = $derived(transientResult?.ok ? transientResult.nodeVoltages : dc.nodeVoltages);
	let lampResistanceOhms = $derived(
		(() => {
			const element = netlist.elements.find((entry) => entry.componentId === 'LAMP1');
			return element?.type === 'resistor' ? element.resistanceOhms : null;
		})()
	);
	let lampNominalPower = $derived(
		typeof LAMP_COMPONENT?.model?.params?.nominalPower === 'number'
			? LAMP_COMPONENT.model.params.nominalPower
			: null
	);
	let lampCenter = $derived(LAMP_GLOW_CENTER);
	let lampPowerWattsActive = $derived(
		LAMP_COMPONENT &&
		LAMP_COMPONENT.terminals.length >= 2 &&
		typeof lampResistanceOhms === 'number' &&
		lampResistanceOhms > 0 &&
		typeof topology.terminalToNode[LAMP_COMPONENT.terminals[0]] === 'number' &&
		typeof topology.terminalToNode[LAMP_COMPONENT.terminals[1]] === 'number'
			? (() => {
				const nodeA = topology.terminalToNode[LAMP_COMPONENT.terminals[0]];
				const nodeB = topology.terminalToNode[LAMP_COMPONENT.terminals[1]];
				const va = activeNodeVoltages[nodeA];
				const vb = activeNodeVoltages[nodeB];
				if (typeof va !== 'number' || typeof vb !== 'number') return 0;
				const v = va - vb;
				return (v * v) / lampResistanceOhms;
			})()
			: 0
	);
	let lampPowerWattsDc = $derived(
		LAMP_COMPONENT &&
		LAMP_COMPONENT.terminals.length >= 2 &&
		typeof lampResistanceOhms === 'number' &&
		lampResistanceOhms > 0 &&
		typeof topology.terminalToNode[LAMP_COMPONENT.terminals[0]] === 'number' &&
		typeof topology.terminalToNode[LAMP_COMPONENT.terminals[1]] === 'number'
			? (() => {
				const nodeA = topology.terminalToNode[LAMP_COMPONENT.terminals[0]];
				const nodeB = topology.terminalToNode[LAMP_COMPONENT.terminals[1]];
				const va = dc.nodeVoltages[nodeA];
				const vb = dc.nodeVoltages[nodeB];
				if (typeof va !== 'number' || typeof vb !== 'number') return 0;
				const v = va - vb;
				return (v * v) / lampResistanceOhms;
			})()
			: 0
	);
	let lampPowerWatts = $derived(Math.max(lampPowerWattsActive, lampPowerWattsDc));
	let lampPowerRatio = $derived(
		typeof lampNominalPower === 'number' && lampNominalPower > 0 ? lampPowerWatts / lampNominalPower : 0
	);
	let meterPositiveTerminal = $derived(
		typeof VOLTMETER_COMPONENT?.metadata?.positive === 'number'
			? VOLTMETER_COMPONENT.metadata.positive
			: VOLTMETER_COMPONENT?.terminals[0]
	);
	let meterNegativeTerminal = $derived(
		typeof VOLTMETER_COMPONENT?.metadata?.negative === 'number'
			? VOLTMETER_COMPONENT.metadata.negative
			: VOLTMETER_COMPONENT?.terminals[1]
	);
	let meterVoltage = $derived(
		typeof meterPositiveTerminal === 'number' &&
		typeof meterNegativeTerminal === 'number' &&
		typeof topology.terminalToNode[meterPositiveTerminal] === 'number' &&
		typeof topology.terminalToNode[meterNegativeTerminal] === 'number'
			? (() => {
				const posNode = topology.terminalToNode[meterPositiveTerminal];
				const negNode = topology.terminalToNode[meterNegativeTerminal];
				const vp = activeNodeVoltages[posNode];
				const vn = activeNodeVoltages[negNode];
				if (typeof vp !== 'number' || typeof vn !== 'number') return null;
				return vp - vn;
			})()
			: null
	);
	let meterClampedVolts = $derived(Math.max(0, Math.min(10, meterVoltage ?? 0)));
	let meterNeedleAngle = $derived(
		METER_NEEDLE_MIN_ANGLE +
			(meterClampedVolts / 10) * (METER_NEEDLE_MAX_ANGLE - METER_NEEDLE_MIN_ANGLE)
	);
	let lampGlowOpacity = $derived(
		(() => {
			const normalized = Math.max(0, Math.min(1, lampPowerRatio));
			if (normalized <= LAMP_GLOW_THRESHOLD) return LAMP_GLOW_MIN;

			const postThreshold =
				LAMP_GLOW_THRESHOLD >= 1
					? 0
					: (normalized - LAMP_GLOW_THRESHOLD) / (1 - LAMP_GLOW_THRESHOLD);
			const incandescent = Math.pow(postThreshold, LAMP_GLOW_GAMMA);
			const eased = incandescent * incandescent * (3 - 2 * incandescent);
			return Math.max(LAMP_GLOW_MIN, Math.min(LAMP_GLOW_MAX, eased));
		})()
	);

	$effect(() => {
		transientResetKey;
		stopTransientRun();
		const netlistSnapshot = untrack(() => netlist);
		transientState = initializeTransientState(netlistSnapshot);
		transientResult = null;
	});

	onDestroy(() => {
		stopTransientRun();
	});

	function voltageToColor(voltage: number | undefined): string {
		if (voltage === undefined || !Number.isFinite(voltage)) return '#d4a24f';
		const clamped = Math.max(-9, Math.min(9, voltage));
		const t = (clamped + 9) / 18;
		const hue = 220 - (220 - 10) * t;
		return `hsl(${hue} 80% 60%)`;
	}

	function formatCapacitance(capacitanceFarads: number): string {
		if (capacitanceFarads >= 1e-6) return `${(capacitanceFarads * 1e6).toFixed(2)} µF`;
		if (capacitanceFarads >= 1e-9) return `${(capacitanceFarads * 1e9).toFixed(2)} nF`;
		return `${(capacitanceFarads * 1e12).toFixed(1)} pF`;
	}

	function formatPotPosition(position: number): string {
		return `${(position * 100).toFixed(0)}%`;
	}

	function toSvgCoords(e: PointerEvent): { x: number; y: number } {
		const pt = overlaySvg.createSVGPoint();
		pt.x = e.clientX;
		pt.y = e.clientY;
		const svgPt = pt.matrixTransform(overlaySvg.getScreenCTM()!.inverse());
		return { x: svgPt.x, y: svgPt.y };
	}

	function handleDragStart(terminalId: number, e: PointerEvent) {
		const pos = TERMINAL_POSITIONS[terminalId];
		if (!pos) return;
		wiresStore.startDrag(terminalId, pos.x, pos.y);
		overlaySvg.setPointerCapture(e.pointerId);
	}

	function handleConnect(terminalId: number) {
		if (wiresStore.drag.active) {
			wiresStore.complete(terminalId);
		}
	}

	function handlePointerMove(e: PointerEvent) {
		if (!wiresStore.drag.active) return;
		const { x, y } = toSvgCoords(e);
		wiresStore.updateDrag(x, y);
	}

	function findNearestTerminal(x: number, y: number): number | null {
		let nearestId: number | null = null;
		let nearestDist = Number.POSITIVE_INFINITY;

		for (const id of mappedTerminalIds) {
			const pos = TERMINAL_POSITIONS[id];
			const dist = Math.hypot(pos.x - x, pos.y - y);
			if (dist <= TERMINAL_SNAP_RADIUS && dist < nearestDist) {
				nearestDist = dist;
				nearestId = id;
			}
		}

		return nearestId;
	}

	function handlePointerUp(e: PointerEvent) {
		if (!wiresStore.drag.active) return;
		const { x, y } = toSvgCoords(e);
		const terminalId = findNearestTerminal(x, y);

		if (terminalId !== null) {
			wiresStore.complete(terminalId);
		} else {
			wiresStore.cancel();
		}

		if (overlaySvg.hasPointerCapture(e.pointerId)) {
			overlaySvg.releasePointerCapture(e.pointerId);
		}
	}

	function handleRemoveTerminalWires(terminalId: number) {
		wiresStore.removeByTerminal(terminalId);
	}

	function stepTransient() {
		const result = stepTransientNetlist(netlist, transientState, { dt: transientDt });
		transientResult = result;
		if (!result.ok) {
			stopTransientRun();
			return;
		}
		transientState = result.state;
	}

	function resetTransient() {
		stopTransientRun();
		transientState = initializeTransientState(netlist);
		transientResult = null;
	}

	function stopTransientRun() {
		if (runTimer) {
			clearInterval(runTimer);
			runTimer = null;
		}
		transientRunning = false;
	}

	function toggleTransientRun() {
		if (transientRunning) {
			stopTransientRun();
			return;
		}
		transientRunning = true;
		runTimer = setInterval(() => {
			stepTransient();
		}, 30);
	}
</script>

<section class="board-shell">
	<div class="toolbar">
		<span class="wire-count">{wiresStore.wires.length} wire{wiresStore.wires.length === 1 ? '' : 's'}</span>
		<span class="topology-count"
			>{topology.connectedNodeIds.length} connected node{topology.connectedNodeIds.length === 1 ? '' : 's'}</span
		>
		<span class="netlist-count">{netlist.elements.length} compiled element{netlist.elements.length === 1 ? '' : 's'}</span>
		<span class="dc-status" class:ok={dc.ok} class:bad={!dc.ok}>DC: {dc.ok ? 'solved' : dc.issue?.code ?? 'not-ready'}</span>
		{#if VOLTMETER_COMPONENT}
			<span class="meter-readout">VM1: {meterVoltage === null ? '--' : `${meterVoltage.toFixed(3)} V`}</span>
		{/if}
		{#if topology.groundNodeId !== null}
			<span class="ground">ground node: N{topology.groundNodeId}</span>
		{/if}

		<div class="transient-controls">
			{#if VARIABLE_RESISTOR_COMPONENT}
				<span class="cap-readout">VR1 {formatPotPosition(variableResistancePosition)}</span>
			{/if}
			{#if VARIABLE_CAPACITOR_COMPONENT}
				<span class="cap-readout">VC1 {formatCapacitance(variableCapacitance)}</span>
			{/if}
			<label>
				dt (s)
				<input
					type="number"
					min="0.000001"
					step="0.0001"
					bind:value={transientDt}
					disabled={transientRunning}
				/>
			</label>
			<button class="control-btn" onclick={stepTransient}>Step</button>
			<button class="control-btn" onclick={toggleTransientRun}>{transientRunning ? 'Pause' : 'Run'}</button>
			<button class="control-btn" onclick={resetTransient}>Reset</button>
			<span class="sim-time">t = {transientState.time.toFixed(4)} s</span>
		</div>

		<button class="clear-btn" onclick={() => wiresStore.clearAll()} disabled={wiresStore.wires.length === 0}>
			Clear all wires
		</button>
		{#if unmappedCount > 0}
			<span class="mapping-hint">{mappedTerminalIds.length}/{KIT_TERMINAL_IDS.length} terminals mapped</span>
		{/if}
	</div>

	<div class="board-container">
		<img src="/board.svg" alt="Science Fair 65-in-1 board artwork" class="board-image" />
		<svg
			class="overlay"
			viewBox={`0 0 ${BOARD_VIEWBOX_WIDTH} ${BOARD_VIEWBOX_HEIGHT}`}
			role="application"
			aria-label="Kit board wiring area"
			bind:this={overlaySvg}
			onpointermove={handlePointerMove}
			onpointerup={handlePointerUp}
		>
			<rect width={BOARD_VIEWBOX_WIDTH} height={BOARD_VIEWBOX_HEIGHT} fill="transparent" />

			<WiringLayer
				wires={wiresStore.wires}
				drag={wiresStore.drag}
				onRemoveWire={(id) => wiresStore.removeWire(id)}
			/>

			{#if VARIABLE_CAPACITOR_COMPONENT}
				<VariableKnob
					x={VARIABLE_CAP_KNOB_X}
					y={VARIABLE_CAP_KNOB_Y}
					radius={VARIABLE_CAP_KNOB_RADIUS}
					value={variableCapacitance}
					min={variableCapMin}
					max={variableCapMax}
					label={`VC1 ${formatCapacitance(variableCapacitance)}`}
					onChange={(value) => (variableCapacitance = value)}
				/>
			{/if}

			{#if VARIABLE_RESISTOR_COMPONENT}
				<VariableKnob
					x={VARIABLE_RES_KNOB_X}
					y={VARIABLE_RES_KNOB_Y}
					radius={VARIABLE_RES_KNOB_RADIUS}
					value={variableResistancePosition}
					min={0}
					max={1}
					startAngle={0}
					endAngle={364}
					tickCount={13}
					variant="chickenhead"
					label={`VR1 ${formatPotPosition(variableResistancePosition)}`}
					onChange={(value) => (variableResistancePosition = value)}
				/>
			{/if}

			{#if lampCenter && lampGlowOpacity > 0}
				<g class="lamp-glow" style={`opacity: ${lampGlowOpacity.toFixed(3)};`} aria-hidden="true">
					<circle class="lamp-glow-outer" cx={lampCenter.x} cy={lampCenter.y} r="18" />
					<circle class="lamp-glow-inner" cx={lampCenter.x} cy={lampCenter.y} r="9.5" />
				</g>
			{/if}

			{#if KEY_COMPONENT}
				{@const pressed = switchStates['KEY1'] ?? false}
				<g
					class="key-widget"
					class:key-pressed={pressed}
					role="button"
					tabindex="0"
					aria-label={`Morse code key (${pressed ? 'pressed' : 'open'})`}
					onpointerdown={(e) => { switchStates = { ...switchStates, KEY1: true }; (e.currentTarget as Element).setPointerCapture(e.pointerId); }}
					onpointerup={(e) => { switchStates = { ...switchStates, KEY1: false }; (e.currentTarget as Element).releasePointerCapture(e.pointerId); }}
					onpointercancel={(e) => { switchStates = { ...switchStates, KEY1: false }; if ((e.currentTarget as Element).hasPointerCapture(e.pointerId)) (e.currentTarget as Element).releasePointerCapture(e.pointerId); }}
					onpointerleave={() => { switchStates = { ...switchStates, KEY1: false }; }}
					onkeydown={(e) => { if (e.key === ' ' || e.key === 'Enter') switchStates = { ...switchStates, KEY1: true }; }}
					onkeyup={(e) => { if (e.key === ' ' || e.key === 'Enter') switchStates = { ...switchStates, KEY1: false }; }}
				>
					<!-- Invisible interaction region over the key graphic in board.svg -->
					<rect
						x={KEY_HITBOX.x1}
						y={KEY_HITBOX.y1}
						width={KEY_HITBOX.x2 - KEY_HITBOX.x1}
						height={KEY_HITBOX.y2 - KEY_HITBOX.y1}
						rx="3"
						class="key-hitbox"
					/>
					{#if pressed}
						<circle cx={KEY_CENTER.x} cy={KEY_CENTER.y} r="7" class="key-active-indicator" />
					{/if}
				</g>
			{/if}

			{#if VOLTMETER_COMPONENT}
				<g class="voltmeter-dial" aria-hidden="true">
					<rect x="236" y="146" width="29" height="25" rx="1.7" class="voltmeter-body" />
					<rect x="238" y="148" width="25" height="15" rx="0.7" class="voltmeter-window" />
					<path d="M 241 160 A 9.5 9.5 0 0 1 260 160" class="voltmeter-scale" />
					<line x1="241" y1="160" x2="242" y2="158" class="voltmeter-tick" />
					<line x1="250.5" y1="150.5" x2="250.5" y2="152.9" class="voltmeter-tick" />
					<line x1="260" y1="160" x2="259" y2="158" class="voltmeter-tick" />
					<text x="240.2" y="154.5" class="voltmeter-label">0</text>
					<text x="249.5" y="150.2" class="voltmeter-label voltmeter-label-mid">5</text>
					<text x="257.6" y="154.5" class="voltmeter-label">10</text>
					<line
						x1={METER_DIAL_CENTER.x}
						y1={METER_DIAL_CENTER.y}
						x2={METER_DIAL_CENTER.x}
						y2={METER_DIAL_CENTER.y - 8.7}
						class="voltmeter-needle"
						transform={`rotate(${meterNeedleAngle} ${METER_DIAL_CENTER.x} ${METER_DIAL_CENTER.y})`}
					/>
					<circle cx={METER_DIAL_CENTER.x} cy={METER_DIAL_CENTER.y} r="1.2" class="voltmeter-hub" />
					<circle cx={METER_DIAL_CENTER.x} cy={METER_DIAL_CENTER.y} r="0.4" class="voltmeter-screw" />
				</g>
			{/if}

			{#each mappedTerminalIds as id (id)}
				{@const nodeId = topology.terminalToNode[id]}
				{@const voltage = activeNodeVoltages[nodeId]}
				<Terminal
					id={id}
					x={TERMINAL_POSITIONS[id].x}
					y={TERMINAL_POSITIONS[id].y}
					voltage={voltage ?? null}
					voltageColor={voltageToColor(voltage)}
					isDragSource={wiresStore.drag.fromTerminal === id}
					onDragStart={handleDragStart}
					onConnect={handleConnect}
					onRemove={handleRemoveTerminalWires}
				/>
			{/each}
		</svg>
	</div>

	<details class="topology-panel">
		<summary>Topology debug ({topology.nodes.length} total nodes)</summary>
		<div class="topology-grid">
			<p class="node-line"><strong>Ground config</strong></p>
			<p class="node-line">terminals: {GROUND_TERMINAL_IDS.join(', ')}</p>
			<p class="node-line">
				active ground node:
				{#if topology.groundNodeId !== null}
					N{topology.groundNodeId}
				{:else}
					(none)
				{/if}
			</p>

			{#each topology.nodes as node (node.nodeId)}
				<p class="node-line">
					<strong>N{node.nodeId}</strong>: {node.terminals.join(', ')}
					{#if topology.connectedNodeIds.includes(node.nodeId)}
						<span class="connected">connected</span>
					{/if}
				</p>
			{/each}
		</div>
	</details>

	<details class="topology-panel">
		<summary>Netlist debug ({netlist.elements.length} compiled / {netlist.unsupported.length} unsupported)</summary>
		<div class="topology-grid">
			{#if netlist.elements.length === 0}
				<p class="node-line">No compiled elements yet.</p>
			{/if}
			{#each netlist.elements as element}
				<p class="node-line">
					{#if element.type === 'resistor'}
						<strong>{element.componentId}</strong>: R N{element.nodes[0]}-N{element.nodes[1]} = {element.resistanceOhms} ohm
					{:else if element.type === 'capacitor'}
						<strong>{element.componentId}</strong>: C N{element.nodes[0]}-N{element.nodes[1]} = {element.capacitanceFarads} F
					{:else if element.type === 'transistor'}
						<strong>{element.componentId}</strong>: Q {element.polarity} B:N{element.baseNode} C:N{element.collectorNode} E:N{element.emitterNode}
					{:else if element.type === 'relay'}
						<strong>{element.componentId}</strong>: RL coil N{element.coilPositiveNode}-N{element.coilNegativeNode}, COM:N{element.commonNode} NC:N{element.normallyClosedNode} NO:N{element.normallyOpenNode}
					{:else}
						<strong>{element.componentId}</strong>: V N{element.positiveNode}-N{element.negativeNode} = {element.voltage} V
					{/if}
				</p>
			{/each}
			{#if netlist.unsupported.length > 0}
				<p class="node-line"><strong>Unsupported:</strong></p>
				{#each netlist.unsupported as item}
					<p class="node-line">- {item.componentId} ({item.kind}): {item.reason}</p>
				{/each}
			{/if}
		</div>
	</details>

	<details class="topology-panel">
		<summary>DC solve debug</summary>
		<div class="topology-grid">
			{#if dc.ok}
				<p class="node-line"><strong>Node voltages</strong></p>
				{#each Object.entries(dc.nodeVoltages).sort(([a], [b]) => Number(a) - Number(b)) as [nodeId, voltage]}
					<p class="node-line">N{nodeId}: {voltage.toFixed(4)} V</p>
				{/each}
				<p class="node-line"><strong>Source currents</strong></p>
				{#if Object.keys(dc.sourceCurrents).length === 0}
					<p class="node-line">(none)</p>
				{:else}
					{#each Object.entries(dc.sourceCurrents) as [id, current]}
						<p class="node-line">{id}: {current.toFixed(6)} A</p>
					{/each}
				{/if}
			{:else}
				<p class="node-line">{dc.issue?.message ?? 'No DC result'}</p>
			{/if}

			{#if dc.warnings.length > 0}
				<p class="node-line"><strong>Warnings</strong></p>
				{#each dc.warnings as warning}
					<p class="node-line">- {warning.code}: {warning.message}</p>
				{/each}
			{/if}
		</div>
	</details>

	<details class="topology-panel">
		<summary>Capacitor state debug</summary>
		<div class="topology-grid">
			{#if Object.keys(transientState.capacitorVoltages).length === 0}
				<p class="node-line">No capacitor state tracked yet.</p>
			{:else}
				{#each Object.entries(transientState.capacitorVoltages).sort(([a], [b]) => a.localeCompare(b)) as [id, voltage]}
					<p class="node-line">{id}: {voltage.toFixed(6)} V</p>
				{/each}
			{/if}
			{#if VARIABLE_CAPACITOR_COMPONENT}
				<p class="node-line">VC1 setting: {formatCapacitance(variableCapacitance)}</p>
			{/if}
			{#if VARIABLE_RESISTOR_COMPONENT}
				<p class="node-line">VR1 setting: {formatPotPosition(variableResistancePosition)}</p>
			{/if}
			<p class="node-line">
				Lamp power: {lampPowerWatts.toFixed(4)} W ({(lampPowerRatio * 100).toFixed(1)}% nominal), opacity {lampGlowOpacity.toFixed(2)}
			</p>
			<p class="node-line">
				Lamp power sources - active: {lampPowerWattsActive.toFixed(4)} W, dc: {lampPowerWattsDc.toFixed(4)} W
			</p>
		</div>
	</details>
</section>

<style>
	.board-shell {
		display: grid;
		gap: 0.5rem;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.wire-count,
	.topology-count,
	.netlist-count,
	.meter-readout,
	.dc-status,
	.mapping-hint,
	.ground,
	.sim-time {
		font-size: 0.85rem;
		color: #b5b5b5;
	}

	.dc-status.ok {
		color: #7bd389;
	}

	.dc-status.bad {
		color: #f08b8b;
	}

	.ground {
		color: #7bd389;
	}

	.transient-controls {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.transient-controls label {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.8rem;
		color: #b5b5b5;
	}

	.cap-readout {
		min-width: 5.5rem;
		font-variant-numeric: tabular-nums;
	}

	.transient-controls input {
		width: 6.5rem;
		padding: 0.2rem 0.35rem;
		border: 1px solid #555;
		border-radius: 4px;
		background: #222;
		color: #eee;
	}

	.control-btn,
	.clear-btn {
		padding: 0.3rem 0.75rem;
		font-size: 0.85rem;
		border: 1px solid #555;
		border-radius: 4px;
		background: #2a2a2a;
		color: #eee;
		cursor: pointer;
	}

	.control-btn:hover,
	.clear-btn:hover:not(:disabled) {
		background: #3c0000;
		border-color: #e53935;
		color: #fff;
	}

	.clear-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.board-container {
		position: relative;
		width: 100%;
		max-width: 1100px;
		border: 1px solid #2c2c2c;
		border-radius: 10px;
		overflow: hidden;
		background: #111;
	}

	.board-image,
	.overlay {
		display: block;
		width: 100%;
		height: auto;
	}

	.overlay {
		position: absolute;
		inset: 0;
		cursor: crosshair;
	}

	.lamp-glow {
		pointer-events: none;
	}

	.lamp-glow-outer {
		fill: rgba(255, 90, 30, 0.35);
	}

	.lamp-glow-inner {
		fill: rgba(255, 180, 40, 0.9);
	}

	.key-widget {
		cursor: pointer;
		user-select: none;
	}

	.key-hitbox {
		fill: transparent;
		stroke: transparent;
	}

	.key-widget:focus-visible .key-hitbox {
		stroke: rgba(255, 255, 255, 0.65);
		stroke-width: 0.6;
	}

	.key-active-indicator {
		fill: rgba(120, 255, 120, 0.2);
		stroke: rgba(120, 255, 120, 0.8);
		stroke-width: 0.5;
		pointer-events: none;
	}

	.voltmeter-dial {
		pointer-events: none;
	}

	.voltmeter-body {
		fill: #d7d7d7;
		stroke: #8f8f8f;
		stroke-width: 0.45;
	}

	.voltmeter-window {
		fill: #f7f7f4;
		stroke: #b8b8b8;
		stroke-width: 0.25;
	}

	.voltmeter-scale {
		fill: none;
		stroke: #222;
		stroke-width: 0.35;
	}

	.voltmeter-tick {
		stroke: #222;
		stroke-width: 0.3;
		stroke-linecap: round;
	}

	.voltmeter-label {
		font-size: 2.2px;
		fill: #111;
		font-weight: 600;
		font-family: sans-serif;
	}

	.voltmeter-label-mid {
		text-anchor: middle;
	}

	.voltmeter-needle {
		stroke: #111;
		stroke-width: 0.55;
		stroke-linecap: round;
	}

	.voltmeter-hub {
		fill: #b5952f;
		stroke: #6a5320;
		stroke-width: 0.2;
	}

	.voltmeter-screw {
		fill: #6a5320;
	}

	.topology-panel {
		max-width: 1100px;
		border: 1px solid #2c2c2c;
		border-radius: 8px;
		padding: 0.5rem 0.75rem;
		background: #171717;
	}

	.topology-panel summary {
		cursor: pointer;
		font-size: 0.9rem;
		color: #ddd;
	}

	.topology-grid {
		display: grid;
		gap: 0.25rem;
		margin-top: 0.5rem;
		max-height: 12rem;
		overflow: auto;
	}

	.node-line {
		margin: 0;
		font-size: 0.82rem;
		color: #cfcfcf;
	}

	.connected {
		margin-left: 0.45rem;
		font-size: 0.75rem;
		color: #7bd389;
	}
</style>
