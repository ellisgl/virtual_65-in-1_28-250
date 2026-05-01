<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { KIT_COMPONENTS, KIT_TERMINAL_IDS, TERMINAL_POSITIONS, isTerminalPositionMapped } from '$lib/data';
	import Terminal from '$lib/components/Terminal.svelte';
	import WiringLayer from '$lib/components/WiringLayer.svelte';
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
	// α = exp(-2π·fc/fs). At 44100 Hz, 0.9985 ≈ 10 Hz highpass — tight enough to kill DC
	// without eating bass, and computed once so it auto-adjusts if sampleRate changes.
	const SPEAKER_DC_BLOCK_ALPHA = 0.9985;
	const STARTUP_KICK_AMPLITUDE_VOLTS = 0.005;
	// How many samples to batch before posting to the worklet (one message per flush).
	const SPEAKER_FLUSH_BATCH = 2048;
	const TRANSIENT_DT = 5e-5; // fixed timestep — not user-adjustable
	// Backpressure: stop queuing new samples when worklet buffer is this full (samples).
	const SPEAKER_BUFFER_FULL_THRESHOLD = 8192;

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
			groundNodeId: topology.groundNodeId
		})
	);
	let dc = $derived(solveDcNetlist(netlist));

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
	let audioSampleRate = $state<number | null>(null);
	let latestSpeakerSample = $state(0);
	let speakerDcEstimateVolts = $state(0);
	// Plain (non-reactive) array — only the worklet cares, not the UI.
	let pendingSpeakerSamples: number[] = [];
	let speakerUpsampleFactor = $state(1);
	// Backpressure: how many samples the worklet buffer currently holds.
	let workletBufferFill = $state(0);

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
		// Auto-start whenever a valid circuit is wired up.
		if (netlistSnapshot.elements.length > 0 && netlistSnapshot.groundNodeId !== null) {
			untrack(() => toggleTransientRun());
		}
	});

	$effect(() => {
		const nodeVoltages = activeNodeVoltages;
		// Avoid tracking internal audio sample state reads/writes inside this effect.
		untrack(() => updateSpeakerSampleFromNodeVoltages(nodeVoltages));
	});

	// Re-derive upsample factor whenever sampleRate changes.
	$effect(() => {
		audioSampleRate;
		updateSpeakerUpsampleFactor();
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

	// Rolling history for cubic Hermite interpolation on the main-thread upsampling path.
	// Stores the last 4 sim-rate samples: [oldest … newest].
	const _cubicHistory: [number, number, number, number] = [0, 0, 0, 0];

	function cubicHermiteMain(p0: number, p1: number, p2: number, p3: number, t: number): number {
		const t2 = t * t;
		const t3 = t2 * t;
		return (
			0.5 *
			(2 * p1 +
				(-p0 + p2) * t +
				(2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
				(-p0 + 3 * p1 - 3 * p2 + p3) * t3)
		);
	}

	function updateSpeakerSampleFromNodeVoltages(nodeVoltages: Record<number, number>, queueSample = false) {
		const speakerVoltage = getSpeakerVoltageFromNodeVoltages(nodeVoltages);
		// IIR DC-blocking highpass (one-pole).
		speakerDcEstimateVolts =
			speakerDcEstimateVolts * SPEAKER_DC_BLOCK_ALPHA +
			speakerVoltage * (1 - SPEAKER_DC_BLOCK_ALPHA);
		const speakerAcVoltage = speakerVoltage - speakerDcEstimateVolts;
		const normalizedRaw = speakerAcVoltage / SPEAKER_AUDIO_SCALE_VOLTS;
		// Soft-clip with tanh to avoid hard clipping artifacts.
		const normalized = Math.tanh(normalizedRaw);

		// Shift history buffer and record new sample.
		_cubicHistory[0] = _cubicHistory[1];
		_cubicHistory[1] = _cubicHistory[2];
		_cubicHistory[2] = _cubicHistory[3];
		_cubicHistory[3] = normalized;

		latestSpeakerSample = normalized;

		if (queueSample) {

			// Backpressure: skip queuing if worklet buffer is already very full.
			if (workletBufferFill >= SPEAKER_BUFFER_FULL_THRESHOLD) return;

			if (speakerUpsampleFactor <= 1) {
				pendingSpeakerSamples.push(normalized);
			} else {
				// Cubic Hermite upsampling between history[1] and history[2].
				const [p0, p1, p2, p3] = _cubicHistory;
				for (let i = 1; i <= speakerUpsampleFactor; i++) {
					const t = i / speakerUpsampleFactor;
					const sample = cubicHermiteMain(p0, p1, p2, p3, t);
					pendingSpeakerSamples.push(Math.tanh(sample)); // keep in [-1,1]
				}
			}
		}
	}

	function flushSpeakerSamples() {
		if (!audioWorkletNode || pendingSpeakerSamples.length === 0) return;
		// Post the array directly — structured clone is zero-copy for transferables,
		// and for plain arrays it's cheaper than Array.from + a separate message.
		audioWorkletNode.port.postMessage({ type: 'samples', values: pendingSpeakerSamples });
		pendingSpeakerSamples = [];
	}

	function updateSpeakerUpsampleFactor() {
		if (!audioContext) {
			speakerUpsampleFactor = 1;
			return;
		}
		if (true) {
			// Sub-stepping puts each solver step at audio rate — no interpolation needed.
			speakerUpsampleFactor = 1;
		} else {
			speakerUpsampleFactor = Math.max(1, Math.round((audioContext?.sampleRate ?? 44100) * TRANSIENT_DT));
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
			audioSampleRate = audioContext.sampleRate;
			updateSpeakerUpsampleFactor();
			audioWorkletNode.port.postMessage({ type: 'sample', value: latestSpeakerSample });
			// Receive backpressure reports from the worklet.
			audioWorkletNode.port.onmessage = (e) => {
				if (e.data?.type === 'bufferFill') {
					workletBufferFill = e.data.available ?? 0;
				}
			};
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
			audioWorkletNode.port.postMessage({ type: 'reset' });
			audioWorkletNode.disconnect();
			audioWorkletNode = null;
		}
		pendingSpeakerSamples = [];
		workletBufferFill = 0;
		speakerUpsampleFactor = 1;
		speakerDcEstimateVolts = 0;
		audioSampleRate = null;
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
		// Start audio on first user gesture (browsers require this).
		if (!speakerAudioEnabled) {
			speakerAudioEnabled = true;
			void startSpeakerAudio();
		}
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
		if (audioSampleRate && speakerAudioEnabled) {
			// Sub-step at audio rate; visual state updates only after the final sub-step.
			const audioStepDt = 1 / audioSampleRate;
			const numSubSteps = Math.max(1, Math.round(TRANSIENT_DT / audioStepDt));
			let currentState = transientState;
			let lastResult: TransientResult | null = null;
			for (let i = 0; i < numSubSteps; i += 1) {
				const result = stepTransientNetlist(netlist, currentState, { dt: audioStepDt });
				if (!result.ok) {
					transientResult = result;
					stopTransientRun();
					return;
				}
				// One sample per sub-step — already at audio rate, no interpolation.
				updateSpeakerSampleFromNodeVoltages(result.nodeVoltages, true);
				currentState = result.state;
				lastResult = result;
			}
			if (lastResult) {
				transientResult = lastResult;
				transientState = lastResult.state;
			}
		} else {
			const result = stepTransientNetlist(netlist, transientState, { dt: TRANSIENT_DT });
			transientResult = result;
			if (!result.ok) {
				stopTransientRun();
				return;
			}
			updateSpeakerSampleFromNodeVoltages(result.nodeVoltages, true);
			if (pendingSpeakerSamples.length >= SPEAKER_FLUSH_BATCH) {
				flushSpeakerSamples();
			}
			transientState = result.state;
		}
	}

	function resetTransient() {
		stopTransientRun();
		transientState = initializeTransientState(netlist);
		transientResult = null;
		speakerDcEstimateVolts = 0;
	}

	function stopTransientRun() {
		if (runTimer) {
			clearInterval(runTimer);
			runTimer = null;
		}
		transientRunning = false;
	}

	function applyStartupKickToState() {
		const nextCapacitorVoltages: Record<string, number> = {};
		for (const [id, value] of Object.entries(transientState.capacitorVoltages)) {
			const jitter = (Math.random() * 2 - 1) * STARTUP_KICK_AMPLITUDE_VOLTS;
			nextCapacitorVoltages[id] = value + jitter;
		}
		transientState = {
			...transientState,
			capacitorVoltages: nextCapacitorVoltages
		};
	}

	function toggleTransientRun() {
		if (transientRunning) {
			stopTransientRun();
			return;
		}
		// Always apply startup kick so oscillator circuits self-start.
		applyStartupKickToState();
		updateSpeakerUpsampleFactor();
		transientRunning = true;

		const MAX_STEPS_PER_TICK = 512;

		runTimer = setInterval(() => {
			if (!transientRunning) return;

			if (audioSampleRate && speakerAudioEnabled) {
				if (workletBufferFill >= SPEAKER_BUFFER_FULL_THRESHOLD) return;
			}

			const stepsPerTick = Math.min(
				MAX_STEPS_PER_TICK,
				Math.max(1, Math.round((TRANSIENT_RUN_INTERVAL_MS / 1000) / TRANSIENT_DT))
			);

			for (let i = 0; i < stepsPerTick; i += 1) {
				stepTransient();
				if (!transientRunning) break;
			}
			flushSpeakerSamples();
		}, TRANSIENT_RUN_INTERVAL_MS);
	}
</script>

<section class="board-shell">
	<div class="toolbar">
		<button class="clear-btn" onclick={() => wiresStore.clearAll()} disabled={wiresStore.wires.length === 0}>
			Clear all wires
		</button>
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

	.clear-btn {
		padding: 0.3rem 0.75rem;
		font-size: 0.85rem;
		border: 1px solid #555;
		border-radius: 4px;
		background: #2a2a2a;
		color: #eee;
		cursor: pointer;
	}

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


</style>
