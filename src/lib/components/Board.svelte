<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { KIT_COMPONENTS, KIT_TERMINAL_IDS, TERMINAL_POSITIONS, isTerminalPositionMapped } from '$lib/data';
	import Terminal from '$lib/components/Terminal.svelte';
	import WiringLayer from '$lib/components/WiringLayer.svelte';
	import BoardDebugPanels from '$lib/components/board/BoardDebugPanels.svelte';
	import BoardControlKnobs from '$lib/components/board/BoardControlKnobs.svelte';
	import { formatCapacitance, formatPotPosition, voltageToColor } from '$lib/components/board/helpers';
	import KeySwitchOverlay from '$lib/components/board/KeySwitchOverlay.svelte';
	import LampGlowOverlay from '$lib/components/board/LampGlowOverlay.svelte';
	import VoltmeterOverlay from '$lib/components/board/VoltmeterOverlay.svelte';
	import {
		buildSimulationNetlist,
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
	const SPEAKER_COMPONENT = KIT_COMPONENTS.find((component) => component.id === 'SPK1');
	const LAMP_GLOW_CENTER = { x: 353.5, y: 25.4 };
	const VARIABLE_RESISTOR_COMPONENT = KIT_COMPONENTS.find((component) => component.id === 'VR1');
	const VARIABLE_CAPACITOR_COMPONENT = KIT_COMPONENTS.find((component) => component.id === 'VC1');
	const KEY_COMPONENT = KIT_COMPONENTS.find((component) => component.id === 'KEY1');
	const VOLTMETER_COMPONENT = KIT_COMPONENTS.find((component) => component.id === 'VM1');
	const BOARD_VIEWBOX_WIDTH = 437;
	const BOARD_VIEWBOX_HEIGHT = 267;
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
	const VARIABLE_CAP_START_ANGLE = 90;
	const VARIABLE_CAP_END_ANGLE = 270;
	const LAMP_GLOW_THRESHOLD = 0;
	const LAMP_GLOW_GAMMA = 0.55;
	const LAMP_GLOW_MIN = 0;
	const LAMP_GLOW_MAX = 1;
	const TRANSIENT_RUN_INTERVAL_MS = 5;
	const SPEAKER_AUDIO_SCALE_VOLTS = 3;

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
	let speakerAudioEnabled = $state(false);
	let audioContext: AudioContext | null = null;
	let audioWorkletNode: AudioWorkletNode | null = null;
	let audioMasterGain: GainNode | null = null;
	let audioHighpass: BiquadFilterNode | null = null;
	let latestSpeakerSample = 0;

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

	$effect(() => {
		updateSpeakerSampleFromNodeVoltages(activeNodeVoltages);
	});

	onDestroy(() => {
		stopTransientRun();
		stopSpeakerAudio();
	});

	function getSpeakerVoltageFromNodeVoltages(nodeVoltages: Record<number, number>): number {
		if (!SPEAKER_COMPONENT || SPEAKER_COMPONENT.terminals.length < 2) return 0;
		const nodeA = topology.terminalToNode[SPEAKER_COMPONENT.terminals[0]];
		const nodeB = topology.terminalToNode[SPEAKER_COMPONENT.terminals[1]];
		if (typeof nodeA !== 'number' || typeof nodeB !== 'number') return 0;
		const va = nodeVoltages[nodeA];
		const vb = nodeVoltages[nodeB];
		if (typeof va !== 'number' || typeof vb !== 'number') return 0;
		return va - vb;
	}

	function updateSpeakerSampleFromNodeVoltages(nodeVoltages: Record<number, number>) {
		const speakerVoltage = getSpeakerVoltageFromNodeVoltages(nodeVoltages);
		const normalized = Math.max(-1, Math.min(1, speakerVoltage / SPEAKER_AUDIO_SCALE_VOLTS));
		latestSpeakerSample = normalized;
		if (audioWorkletNode) {
			audioWorkletNode.port.postMessage({ type: 'sample', value: normalized });
		}
	}

	async function startSpeakerAudio() {
		if (typeof window === 'undefined') return;
		if (audioContext) return;

		audioContext = new AudioContext();
		audioMasterGain = audioContext.createGain();
		audioMasterGain.gain.value = 0.25;
		audioHighpass = audioContext.createBiquadFilter();
		audioHighpass.type = 'highpass';
		audioHighpass.frequency.value = 25;

		try {
			await audioContext.audioWorklet.addModule('/audio/speaker-worklet.js');
			audioWorkletNode = new AudioWorkletNode(audioContext, 'speaker-sample-processor');
			audioWorkletNode.port.postMessage({ type: 'sample', value: latestSpeakerSample });
			audioWorkletNode.connect(audioHighpass);
		} catch {
			speakerAudioEnabled = false;
			stopSpeakerAudio();
			return;
		}

		audioHighpass.connect(audioMasterGain);
		audioMasterGain.connect(audioContext.destination);
		void audioContext.resume();
	}

	function stopSpeakerAudio() {
		if (audioWorkletNode) {
			audioWorkletNode.disconnect();
			audioWorkletNode = null;
		}
		audioHighpass?.disconnect();
		audioHighpass = null;
		audioMasterGain?.disconnect();
		audioMasterGain = null;
		if (audioContext) {
			void audioContext.close();
			audioContext = null;
		}
	}

	function toggleSpeakerAudio() {
		speakerAudioEnabled = !speakerAudioEnabled;
		if (speakerAudioEnabled) {
			void startSpeakerAudio();
		} else {
			stopSpeakerAudio();
		}
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
		updateSpeakerSampleFromNodeVoltages(result.nodeVoltages);
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
		const stepsPerTick = Math.max(1, Math.round((TRANSIENT_RUN_INTERVAL_MS / 1000) / transientDt));
		runTimer = setInterval(() => {
			for (let i = 0; i < stepsPerTick; i += 1) {
				stepTransient();
				if (!transientRunning) break;
			}
		}, TRANSIENT_RUN_INTERVAL_MS);
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
			<button class="control-btn" class:active={speakerAudioEnabled} onclick={toggleSpeakerAudio}>
				Audio {speakerAudioEnabled ? 'On' : 'Off'}
			</button>
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

			<BoardControlKnobs
				capacitor={
					VARIABLE_CAPACITOR_COMPONENT
						? {
								x: VARIABLE_CAP_KNOB_X,
								y: VARIABLE_CAP_KNOB_Y,
								radius: VARIABLE_CAP_KNOB_RADIUS,
								value: variableCapacitance,
								min: variableCapMin,
								max: variableCapMax,
								startAngle: VARIABLE_CAP_START_ANGLE,
								endAngle: VARIABLE_CAP_END_ANGLE,
								label: `VC1 ${formatCapacitance(variableCapacitance)}`,
								onChange: (value: number) => (variableCapacitance = value)
							}
						: undefined
				}
				resistor={
					VARIABLE_RESISTOR_COMPONENT
						? {
								x: VARIABLE_RES_KNOB_X,
								y: VARIABLE_RES_KNOB_Y,
								radius: VARIABLE_RES_KNOB_RADIUS,
								value: variableResistancePosition,
								min: 0,
								max: 1,
								startAngle: 0,
								endAngle: 364,
								tickCount: 13,
								variant: 'chickenhead',
								label: `VR1 ${formatPotPosition(variableResistancePosition)}`,
								onChange: (value: number) => (variableResistancePosition = value)
							}
						: undefined
				}
			/>

			{#if lampCenter && lampGlowOpacity > 0}
				<LampGlowOverlay center={lampCenter} opacity={lampGlowOpacity} />
			{/if}

			{#if KEY_COMPONENT}
				<KeySwitchOverlay
					pressed={switchStates['KEY1'] ?? false}
					hitbox={KEY_HITBOX}
					center={KEY_CENTER}
					onPressedChange={(pressed) => (switchStates = { ...switchStates, KEY1: pressed })}
				/>
			{/if}

			{#if VOLTMETER_COMPONENT}
				<VoltmeterOverlay needleAngle={meterNeedleAngle} />
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

	<BoardDebugPanels
		{topology}
		{netlist}
		{dc}
		{transientState}
		{variableCapacitance}
		{variableResistancePosition}
		hasVariableCapacitor={Boolean(VARIABLE_CAPACITOR_COMPONENT)}
		hasVariableResistor={Boolean(VARIABLE_RESISTOR_COMPONENT)}
		{lampPowerWatts}
		{lampPowerRatio}
		{lampGlowOpacity}
		{lampPowerWattsActive}
		{lampPowerWattsDc}
	/>
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

	.control-btn.active {
		border-color: #7bd389;
		color: #7bd389;
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


</style>
