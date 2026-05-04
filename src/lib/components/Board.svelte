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
		compileNetlist,
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
	const SPEAKER_DC_BLOCK_ALPHA = 0.9985;
	const STARTUP_KICK_AMPLITUDE_VOLTS = 0.005;
	const SPEAKER_FLUSH_BATCH = 2048;

	// Adaptive timestep bounds (seconds). GEAR-2 adjusts dt within these limits based on LTE.
	const DT_MIN = 1e-6;    // 1µs  — captures fast transformer pulses
	const DT_MAX = 0.5e-3;  // 0.5ms — must capture audio-frequency oscillations (~250 Hz+)
	const DT_INIT = 10e-6;  // 10µs — conservative start

	// How much simulated time to advance per real 5ms tick.
	const SIM_TIME_PER_TICK = TRANSIENT_RUN_INTERVAL_MS / 1000;
	const MAX_SUBSTEPS_PER_TICK = 2000; // safety cap

	// Current adaptive timestep, updated by solver each step.
	let adaptiveDt = $state(DT_INIT);

	// Backpressure: stop queuing new samples when worklet buffer is this full.
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
	// Pre-compiled static netlist data — recomputed only when the netlist changes,
	// not on every simulation step. Eliminates per-step allocation overhead.
	let compiledNetlist = $derived(compileNetlist(netlist));
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
		transientResetKey; // only topology changes trigger a full reset + restart
		const wasRunning = untrack(() => transientRunning);
		stopTransientRun();
		const netlistSnapshot = untrack(() => netlist);
		const dcSnapshot = untrack(() => dc);
		transientState = initializeTransientState(
			netlistSnapshot,
			dcSnapshot.ok ? dcSnapshot.nodeVoltages : undefined
		);
		transientResult = null;
		if (wasRunning && netlistSnapshot.elements.length > 0 && netlistSnapshot.groundNodeId !== null) {
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
		// First try reading the speaker terminals directly (when transformer secondary is driven).
		if (SPEAKER_COMPONENT && SPEAKER_COMPONENT.terminals.length >= 2) {
			const nodeA = topology.terminalToNode[SPEAKER_COMPONENT.terminals[0]];
			const nodeB = topology.terminalToNode[SPEAKER_COMPONENT.terminals[1]];
			if (typeof nodeA === 'number' && typeof nodeB === 'number') {
				const va = nodeVoltages[nodeA];
				const vb = nodeVoltages[nodeB];
				if (typeof va === 'number' && typeof vb === 'number') {
					const spkV = va - vb;
					if (Math.abs(spkV) > 0.001) return spkV;
				}
			}
		}
		// Fallback: use T1 primary half-1 node (Q2 collector side) as audio source.
		// This is the node that swings during blocking oscillator firing.
		// Terminal 70 = T1 primary start = Q2 collector connection.
		const T1_primaryStart = 70;
		const T1_centerTap = 71;
		const nPs = topology.terminalToNode[T1_primaryStart];
		const nPc = topology.terminalToNode[T1_centerTap];
		if (typeof nPs === 'number' && typeof nPc === 'number') {
			const va = nodeVoltages[nPs];
			const vb = nodeVoltages[nPc];
			if (typeof va === 'number' && typeof vb === 'number') {
				// Scale by 1/n (n=10) to approximate transformer step-down to speaker level
				return (va - vb) / 10;
			}
		}
		return 0;
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

	function updateSpeakerSampleFromNodeVoltages(nodeVoltages: Record<number, number>, _queueSample = false) {
		const speakerVoltage = getSpeakerVoltageFromNodeVoltages(nodeVoltages);
		speakerDcEstimateVolts =
			speakerDcEstimateVolts * SPEAKER_DC_BLOCK_ALPHA +
			speakerVoltage * (1 - SPEAKER_DC_BLOCK_ALPHA);
		const speakerAcVoltage = speakerVoltage - speakerDcEstimateVolts;
		const normalizedRaw = speakerAcVoltage / SPEAKER_AUDIO_SCALE_VOLTS;
		latestSpeakerSample = Math.tanh(normalizedRaw);
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
			speakerUpsampleFactor = Math.max(1, Math.round((audioContext?.sampleRate ?? 44100) * DT_INIT));
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
			// Reset the resampler timing — the next audio sample should be due
			// one period after audio enables, regardless of where sim-time is.
			audioSimTime = 0;
			audioNextSampleTime = 1 / audioSampleRate;
			audioPrevSpkV = getSpeakerVoltageFromNodeVoltages(transientState.nodeVoltages);
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
		audioSimTime = 0;
		audioNextSampleTime = 0;
		audioPrevSpkV = 0;
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

	function saveWires() {
		const lines = wiresStore.wires.map((w) => `${w.fromTerminal}-${w.toTerminal}`);
		const text = lines.join('\n');
		const blob = new Blob([text], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'circuit.txt';
		a.click();
		URL.revokeObjectURL(url);
	}

	function loadWires(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			const text = reader.result as string;
			const pairs: Array<{ fromTerminal: number; toTerminal: number }> = [];
			for (const rawLine of text.split('\n')) {
				const line = rawLine.trim();
				if (!line || line.startsWith('#')) continue;
				// Each line is one or more terminals joined by '-', e.g. "13-23" or "14-71-87"
				// Multi-terminal lines mean every terminal in the group is connected,
				// which we represent as a chain of wires: 14→71, 71→87.
				const parts = line.split('-').map((p) => parseInt(p.trim(), 10));
				if (parts.some(isNaN)) continue;
				for (let i = 0; i < parts.length - 1; i++) {
					pairs.push({ fromTerminal: parts[i], toTerminal: parts[i + 1] });
				}
			}
			wiresStore.loadWires(pairs);
		};
		reader.readAsText(file);
		// Reset so the same file can be re-loaded if needed.
		input.value = '';
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

	// Audio resampler state — maintains continuous "next audio sample time"
	// across calls to stepTransient. Critical: solver steps happen at irregular
	// dt (1µs during pulse, 50ms during quiet); we must produce samples at
	// the fixed audio rate to avoid worklet over/underruns.
	let audioSimTime = 0;        // total sim-time elapsed when audio started
	let audioNextSampleTime = 0; // sim-time at which the next audio sample is due
	let audioPrevSpkV = 0;       // speaker voltage at the previous solver step

	// Wall-clock pacing state. The simulator must keep sim-time aligned with
	// wall-time so the audio sample stream stays at 44.1kHz wall-clock rate.
	// If a tick is delayed (because a pulse phase took longer than 5ms wall),
	// the next call advances proportionally MORE sim-time to catch up.
	let lastTickWallTime = 0;        // wall-time of the previous successful tick
	const MAX_CATCHUP_SIMTIME = 0.05;  // hard cap on catch-up per tick (50ms)

	function stepTransient(simTimeBudget: number) {
		// Advance the simulator by AT MOST `simTimeBudget` seconds of sim-time.
		// Adaptive sub-stepping: GEAR-2 varies dt between DT_MIN and DT_MAX
		// based on LTE feedback. Audio samples are emitted on the fixed
		// audioPeriod grid via linear interpolation.
		let currentState = transientState;
		let lastResult: TransientResult | null = null;
		let simTimeAdvanced = 0;
		let substeps = 0;
		let dt = Math.max(DT_MIN, Math.min(DT_MAX, adaptiveDt));

		const audioPeriod = audioSampleRate ? 1 / audioSampleRate : 0;
		const maxSubsteps = MAX_SUBSTEPS_PER_TICK * Math.max(1, Math.ceil(simTimeBudget / SIM_TIME_PER_TICK));

		while (simTimeAdvanced < simTimeBudget && substeps < maxSubsteps) {
			const stepDt = Math.min(dt, simTimeBudget - simTimeAdvanced);

			const result = stepTransientNetlist(
				netlist, currentState, { dt: stepDt, gear: 2 }, compiledNetlist ?? undefined
			);
			if (!result.ok) {
				transientResult = result;
				stopTransientRun();
				return;
			}

			currentState = result.state;
			lastResult = result;

			// Audio resampling: emit fixed-rate samples by interpolating between
			// the previous step's speaker voltage and this step's voltage.
			if (speakerAudioEnabled && audioSampleRate && audioPeriod > 0) {
				const stepStartTime = audioSimTime + simTimeAdvanced;
				const stepEndTime = stepStartTime + stepDt;
				const spkVNew = getSpeakerVoltageFromNodeVoltages(result.nodeVoltages);

				while (audioNextSampleTime <= stepEndTime) {
					if (audioNextSampleTime < stepStartTime) {
						audioNextSampleTime = stepStartTime;
					}
					const alpha = stepDt > 0 ? (audioNextSampleTime - stepStartTime) / stepDt : 0;
					const spkV = audioPrevSpkV + (spkVNew - audioPrevSpkV) * alpha;
					speakerDcEstimateVolts =
						speakerDcEstimateVolts * SPEAKER_DC_BLOCK_ALPHA +
						spkV * (1 - SPEAKER_DC_BLOCK_ALPHA);
					const acV = spkV - speakerDcEstimateVolts;
					pendingSpeakerSamples.push(Math.tanh(acV / SPEAKER_AUDIO_SCALE_VOLTS));
					audioNextSampleTime += audioPeriod;
				}
				audioPrevSpkV = spkVNew;
			}

			simTimeAdvanced += stepDt;
			substeps++;

			if (result.recommendedDt !== undefined) {
				dt = Math.max(DT_MIN, Math.min(DT_MAX, result.recommendedDt));
			}
		}

		if (speakerAudioEnabled && audioSampleRate) {
			audioSimTime += simTimeAdvanced;
		}

		if (!lastResult) return;
		transientResult = lastResult;
		transientState = lastResult.state;
		adaptiveDt = dt;
		updateSpeakerSampleFromNodeVoltages(lastResult.nodeVoltages, false);
	}

	function toggleTransientRun() {
		if (transientRunning) {
			stopTransientRun();
			return;
		}
		transientState = initializeTransientState(netlist, dc.ok ? dc.nodeVoltages : undefined);
		transientResult = null;
		speakerDcEstimateVolts = 0;
		adaptiveDt = DT_INIT;
		applyStartupKickToState();
		updateSpeakerUpsampleFactor();
		transientRunning = true;
		lastTickWallTime = performance.now();

		runTimer = setInterval(() => {
			if (!transientRunning) return;
			if (speakerAudioEnabled && audioSampleRate) {
				if (workletBufferFill >= SPEAKER_BUFFER_FULL_THRESHOLD) {
					// Buffer full — skip this tick, but DON'T let wall-time
					// accumulate during the skip (would cause a runaway burst
					// of catch-up sim-time once buffer drains).
					lastTickWallTime = performance.now();
					return;
				}
			}

			// Sim-time budget = wall-time elapsed since last tick, capped to
			// MAX_CATCHUP_SIMTIME so we never spend forever catching up after
			// a long stall (e.g., backgrounded tab).
			const now = performance.now();
			const wallElapsed = (now - lastTickWallTime) / 1000;
			const budget = Math.min(Math.max(wallElapsed, SIM_TIME_PER_TICK), MAX_CATCHUP_SIMTIME);
			lastTickWallTime = now;

			stepTransient(budget);
			if (pendingSpeakerSamples.length >= SPEAKER_FLUSH_BATCH) flushSpeakerSamples();
		}, TRANSIENT_RUN_INTERVAL_MS);
	}

	function resetTransient() {
		stopTransientRun();
		transientState = initializeTransientState(netlist, dc.ok ? dc.nodeVoltages : undefined);
		transientResult = null;
		speakerDcEstimateVolts = 0;
		adaptiveDt = DT_INIT;
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
			nextCapacitorVoltages[id] = value + (Math.random() * 2 - 1) * STARTUP_KICK_AMPLITUDE_VOLTS;
		}
		transientState = {
			...transientState,
			capacitorVoltages: nextCapacitorVoltages
		};
	}

</script>

<section class="board-shell">
	<div class="toolbar">
		<button
			class="run-btn"
			class:running={transientRunning}
			onclick={() => {
				if (!speakerAudioEnabled && !transientRunning) {
					speakerAudioEnabled = true;
					void startSpeakerAudio();
				}
				toggleTransientRun();
			}}
			disabled={netlist.elements.length === 0 || netlist.groundNodeId === null}
		>
			{transientRunning ? 'Stop' : 'Run'}
		</button>
		<button class="clear-btn" onclick={saveWires} disabled={wiresStore.wires.length === 0}>
			Save wires
		</button>
		<label class="load-btn">
			Load wires
			<input type="file" accept=".txt,text/plain" onchange={loadWires} hidden />
		</label>
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

	.run-btn {
		padding: 0.3rem 1rem;
		font-size: 0.85rem;
		font-weight: 600;
		border: 1px solid #43a047;
		border-radius: 4px;
		background: #1a3a1a;
		color: #81c784;
		cursor: pointer;
		min-width: 4rem;
	}

	.run-btn:hover:not(:disabled) {
		background: #2e5c2e;
		color: #fff;
	}

	.run-btn.running {
		border-color: #c62828;
		background: #3a1a1a;
		color: #ef9a9a;
	}

	.run-btn.running:hover:not(:disabled) {
		background: #5c2e2e;
		color: #fff;
	}

	.run-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.clear-btn,
	.load-btn {
		padding: 0.3rem 0.75rem;
		font-size: 0.85rem;
		border: 1px solid #555;
		border-radius: 4px;
		background: #2a2a2a;
		color: #eee;
		cursor: pointer;
	}

	.clear-btn:hover:not(:disabled),
	.load-btn:hover {
		background: #1a3a1a;
		border-color: #43a047;
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
