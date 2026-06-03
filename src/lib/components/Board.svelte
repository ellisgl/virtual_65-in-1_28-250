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
	import { buildSimulationNetlist } from '$lib/sim';
	import { initRustDc, isRustDcReady, solveDcRust } from '$lib/sim/dc-rust';
	import { SimRustWorkletHost } from '$lib/sim/sim-rust-worklet-host';
	import type { ControlState, WireSpec, DiagnosticCapture } from '$lib/sim/sim-rust-worklet-host';
	import { wiresStore } from '$lib/stores/wires.svelte';
	import type { DcSolution } from '$lib/types';

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
	const SPEAKER_BUFFER_FULL_THRESHOLD = 8192;

	let overlaySvg: SVGSVGElement;
	let topology = $derived(wiresStore.topology);
	let variableResistancePosition = $state(variableResDefaultPosition);
	let variableCapacitance = $state(variableCapDefault);
	let switchStates = $state<Record<string, boolean>>({});

	// ── Controls helper ────────────────────────────────────────────────────────
	function currentControls(): ControlState {
		// Use snapshotted values of $state to ensure the $derived
		// and $effects see a consistent view.
		return {
			valueOverrides:    VARIABLE_CAPACITOR_COMPONENT ? { VC1: variableCapacitance } : {},
			positionOverrides: VARIABLE_RESISTOR_COMPONENT  ? { VR1: variableResistancePosition } : {},
			switchStates:      { ...switchStates }
		};
	}

	// ── Netlist (main thread, for button enable + lamp resistance display) ─────
	let netlist = $derived(
		buildSimulationNetlist(topology, KIT_COMPONENTS, currentControls())
	);

	// ── DC snapshot via Rust WASM ──────────────────────────────────────────────
	// The Rust DC path handles relays + floating-throw contacts correctly,
	// where the legacy TS solver silently dropped relay contact stamps.
	// Until WASM finishes loading on first paint, we show an empty solution
	// (ok=false, no voltages); _wasmReady flips reactively, after which
	// `dc` re-derives through the Rust solver.
	let _wasmReady = $state(isRustDcReady());
	$effect(() => {
		if (_wasmReady) return;
		initRustDc().then(() => {
			_wasmReady = true;
		});
	});

	const EMPTY_DC: DcSolution = {
		ok: false, nodeVoltages: {}, sourceCurrents: {}, warnings: []
	};
	let dc = $derived(_wasmReady ? solveDcRust(netlist) : EMPTY_DC);

	let transientResetKey = $derived(
		JSON.stringify({
			nodeBindings:     topology.componentBindings,
			terminalToNode:   topology.terminalToNode,
			connectedNodeIds: topology.connectedNodeIds,
			groundNodeId:     topology.groundNodeId
		})
	);

	// ── Audio worklet host (runs sim in the audio thread) ─────────────────────
	// Replaces the Phase 3 Web Worker + speaker-worklet ring buffer pipeline.
	// The worklet host instantiates an AudioWorkletNode that hosts the Rust
	// simulator directly: process() steps the sim and emits audio samples in
	// one shot.  Snapshots come back over the port for UI updates.
	let workletHost = $state<SimRustWorkletHost | null>(null);
	let lastHandledResetKey = $state<string | null>(null);
	let workletVoltages = $state<Record<number, number>>({});
	let transientRunning = $state(false);

	// ── Audio ─────────────────────────────────────────────────────────────────
	let speakerAudioEnabled = $state(false);
	// Speaker mechanical-resonance bandpass — off by default so it doesn't
	// colour circuits whose tone isn't near the resonance (e.g. the
	// metronome's ~400 Hz tick).  Toggle on for siren / tone circuits (P18,
	// P45) where it converts the simulator's spike-train output into a clean
	// tone near the speaker's resonant frequency.
	let speakerFilterOn = $state(false);
	let audioContext: AudioContext | null = null;
	let audioMasterGain: GainNode | null = null;
	let audioHighpass: BiquadFilterNode | null = null;
	let audioKeepAliveRunning = false;
	let audioKeepAliveRafId: number | null = null;

	// ── Display ────────────────────────────────────────────────────────────────
	// activeNodeVoltages reflects the "current" voltage at each node.  When
	// the transient simulation is actively running, the worklet's most recent
	// snapshot is the freshest source.  When transient is stopped, snapshots
	// may be stale — falling back to `dc.nodeVoltages` keeps the UI showing
	// the correct DC operating point in response to switch / pot changes.
	let activeNodeVoltages = $derived(
		transientRunning && Object.keys(workletVoltages).length > 0
			? workletVoltages
			: dc.nodeVoltages
	);
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

	// ── Worklet host lifecycle ─────────────────────────────────────────────────
	// The worklet runs sim in the audio thread, so its lifetime is tied to the
	// AudioContext.  It's brought up when the user enables audio (startSpeakerAudio)
	// and torn down when audio stops or the component unmounts.

	// Wire topology change → full worklet reset (rebuild from new wires).
	$effect(() => {
		const host = workletHost;
		const currentResetKey = transientResetKey;
		if (!host || !host.isReady()) return;

		untrack(() => {
			if (currentResetKey === lastHandledResetKey) return;
			console.log(`[${new Date().toISOString()}] [Board] transientResetKey changed, resetting worklet`, {
				from: lastHandledResetKey,
				to: currentResetKey
			});
			lastHandledResetKey = currentResetKey;

			const wasRunning = transientRunning;
			host.stop();
			transientRunning = false;
			workletVoltages = {};

			const wires: WireSpec[] = wiresStore.wires.map((w) => ({
				fromTerminal: w.fromTerminal,
				toTerminal:   w.toTerminal
			}));

			void host.configure(wires, currentControls(), 'current').then(() => {
				if (wasRunning && netlist.elements.length > 0 && netlist.groundNodeId !== null) {
					host.start();
					transientRunning = true;
				}
			});
		});
	});

	// Controls changed → soft recompile (state-preserving in the worklet).
	$effect(() => {
		const controls = currentControls();
		const host = workletHost;
		// Same boot-race guard as the wire-change effect above.
		if (!host || !host.isReady()) return;
		untrack(() => host.updateControls(controls));
	});

	onDestroy(() => {
		workletHost?.stop();
		workletHost?.dispose();
		workletHost = null;
		stopSpeakerAudio();
	});

	// ── Audio context ─────────────────────────────────────────────────────────

	async function startSpeakerAudio() {
		if (typeof window === 'undefined') return;
		if (audioContext) return;

		audioContext = new AudioContext();
		audioMasterGain = audioContext.createGain();
		// 1.0 not 0.25: the worklet's chain (tanh + bandpass + bpGain)
		// already attenuates significantly (~-20 dB at the siren's typical
		// 1 kHz against the 250 Hz-centred cone bandpass).  Stacking
		// another -12 dB makes the siren barely audible.  tanh saturation
		// prevents clipping so we don't need master-side headroom.
		audioMasterGain.gain.value = 4.0;
		audioHighpass  = audioContext.createBiquadFilter();
		audioHighpass.type = 'highpass';
		audioHighpass.frequency.value = 25;

		audioHighpass.connect(audioMasterGain);
		audioMasterGain.connect(audioContext.destination);

		try {
			const host = new SimRustWorkletHost(audioContext);
			host.onSnapshot = (volts) => { workletVoltages = volts; };
			host.onError    = (msg)   => {
				console.error('[worklet] sim failure:', msg);
				if (msg.includes('topology node bindings')) {
					// Surface component binding errors to the UI if possible.
					// For now just log more visibly.
					console.warn('[worklet] Check component connections!');
				}
			};
			host.onDiagnosticCapture = (capture) => {
				downloadDiagnosticCapture(capture);
			};
			await host.connect(audioHighpass);

			// Initial configure with current wires + controls.  The worklet
			// stays idle (running=false) until start() is called.
			const wires: WireSpec[] = wiresStore.wires.map((w) => ({
				fromTerminal: w.fromTerminal,
				toTerminal:   w.toTerminal
			}));
			await host.configure(wires, currentControls(), 'current');
			lastHandledResetKey = transientResetKey;
			workletHost = host;
		} catch (err) {
			console.error('[audio] Failed to start worklet host:', err);
			speakerAudioEnabled = false;
			stopSpeakerAudio();
			return;
		}

		try {
			await audioContext.resume();
		} catch (err) {
			console.error('[audio] AudioContext.resume() failed:', err);
		}


		// Chrome throttles AudioWorklet processing when the page is
		// considered "idle" (no main-thread activity, tab backgrounded,
		// or no rAF callbacks queued).  The symptom is audio cutting
		// out after ~500 ms even though the worklet is producing
		// samples — only re-enabling when DevTools performance
		// recording forces the tab to stay active.  Two-pronged fix:
		//   1. Keep the main thread "busy" with a perpetual rAF.
		//   2. If the AudioContext slips into 'suspended' for any
		//      reason (autoplay policy, OS audio device change, etc.),
		//      resume it automatically.
		audioKeepAliveRunning = true;
		const tick = () => {
			if (!audioKeepAliveRunning) return;
			if (audioContext && audioContext.state === 'suspended') {
				void audioContext.resume().catch(() => {});
			}
			// Periodic ping to keep the worklet's event loop and the
			// main thread's rAF active even when Chrome throttles.
			workletHost?.ping();
			audioKeepAliveRafId = requestAnimationFrame(tick);
		};
		audioKeepAliveRafId = requestAnimationFrame(tick);

		// Also re-resume on visibility change — Chrome aggressively
		// suspends audio when the tab loses focus.
		document.addEventListener('visibilitychange', onVisibilityChange);
	}

	function onVisibilityChange() {
		if (document.visibilityState === 'visible' && audioContext && audioContext.state === 'suspended') {
			void audioContext.resume().catch(() => {});
		}
	}

	function stopSpeakerAudio() {
		audioKeepAliveRunning = false;
		if (audioKeepAliveRafId !== null) {
			cancelAnimationFrame(audioKeepAliveRafId);
			audioKeepAliveRafId = null;
		}
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibilityChange);
		}
		if (workletHost) {
			workletHost.stop();
			workletHost.dispose();
			workletHost = null;
		}
		transientRunning = false;
		workletVoltages = {};
		audioHighpass?.disconnect();
		audioHighpass = null;
		audioMasterGain?.disconnect();
		audioMasterGain = null;
		if (audioContext) {
			void audioContext.close();
			audioContext = null;
		}
	}

	// ── Simulation run control ─────────────────────────────────────────────────
	// Transient runs inside the audio worklet, so enabling/disabling it is
	// just toggling the worklet's running flag.  No-op if audio isn't on yet.

	function toggleTransientRun() {
		if (!workletHost) return;
		console.log(`[${new Date().toISOString()}] [Board] toggleTransientRun`, { from: transientRunning });
		if (transientRunning) {
			workletHost.stop();
			transientRunning = false;
		} else {
			workletHost.start();
			transientRunning = true;
		}
	}

	// ── Wire save / load ───────────────────────────────────────────────────────

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

	// ── Diagnostic-capture WAV writer ─────────────────────────────────────────
	//
	// Builds a 16-bit PCM mono WAV from a Float32Array of samples.  The
	// sample values are clipped to [-1, +1] before quantizing.  If the
	// caller has scaled their data into that range already (which we do
	// below for the raw and dcBlocked channels), the WAV faithfully
	// preserves the waveform shape.
	function floatArrayToWavBlob(samples: Float32Array, sampleRate: number): Blob {
		const dataBytes = samples.length * 2;
		const buffer = new ArrayBuffer(44 + dataBytes);
		const view = new DataView(buffer);
		// RIFF header
		view.setUint32(0, 0x52494646, false); // 'RIFF'
		view.setUint32(4, 36 + dataBytes, true);
		view.setUint32(8, 0x57415645, false); // 'WAVE'
		// fmt subchunk
		view.setUint32(12, 0x666d7420, false); // 'fmt '
		view.setUint32(16, 16, true);          // PCM subchunk size
		view.setUint16(20, 1, true);           // PCM format
		view.setUint16(22, 1, true);           // 1 channel (mono)
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * 2, true); // byte rate
		view.setUint16(32, 2, true);           // block align
		view.setUint16(34, 16, true);          // bits per sample
		// data subchunk
		view.setUint32(36, 0x64617461, false); // 'data'
		view.setUint32(40, dataBytes, true);
		// PCM samples
		for (let i = 0; i < samples.length; i++) {
			const s = Math.max(-1, Math.min(1, samples[i]));
			view.setInt16(44 + i * 2, Math.round(s * 32767), true);
		}
		return new Blob([buffer], { type: 'audio/wav' });
	}

	function triggerDownload(blob: Blob, filename: string): void {
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}

	// Receives a {@link DiagnosticCapture} from the worklet and ships four
	// WAV files to the user's downloads folder.  The raw, dcBlocked, and
	// postFilter channels are normalized by the same global scale factor
	// so peaks are directly comparable; the scale used is logged to the
	// console so absolute voltages can be recovered.  The postTanh
	// channel is already in [-1, +1] (that's what tanh outputs) so it's
	// written as-is.
	function downloadDiagnosticCapture(capture: DiagnosticCapture): void {
		const { raw, dcBlocked, postFilter, postTanh, sampleRate, samplesPerChannel } = capture;
		const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

		// Find peak across raw + dcBlocked + postFilter for shared scale.
		// postTanh is naturally bounded already.
		let peak = 1e-9;
		for (let i = 0; i < samplesPerChannel; i++) {
			const a = Math.abs(raw[i]);        if (a > peak) peak = a;
			const b = Math.abs(dcBlocked[i]);  if (b > peak) peak = b;
			const c = Math.abs(postFilter[i]); if (c > peak) peak = c;
		}
		const scale = 1 / peak;

		const rawNorm = new Float32Array(samplesPerChannel);
		const dcNorm  = new Float32Array(samplesPerChannel);
		const flNorm  = new Float32Array(samplesPerChannel);
		for (let i = 0; i < samplesPerChannel; i++) {
			rawNorm[i] = raw[i] * scale;
			dcNorm[i]  = dcBlocked[i] * scale;
			flNorm[i]  = postFilter[i] * scale;
		}

		triggerDownload(floatArrayToWavBlob(rawNorm,   sampleRate),
			`diagnostic-raw-${ts}.wav`);
		triggerDownload(floatArrayToWavBlob(dcNorm,    sampleRate),
			`diagnostic-dc-blocked-${ts}.wav`);
		triggerDownload(floatArrayToWavBlob(flNorm,    sampleRate),
			`diagnostic-post-filter-${ts}.wav`);
		triggerDownload(floatArrayToWavBlob(postTanh,  sampleRate),
			`diagnostic-post-tanh-${ts}.wav`);

		console.log(
			`[diagnostic] capture delivered: ${samplesPerChannel} samples @ ${sampleRate} Hz, ` +
			`raw/dcBlocked/postFilter peak = ${peak.toFixed(4)} (scaled to [-1,1] by ${scale.toFixed(4)}). ` +
			`To convert WAV sample back to native units, multiply by ${peak.toFixed(4)}. ` +
			`postTanh is in native [-1, +1] AudioContext range.`,
		);
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
				const parts = line.split('-').map((p) => parseInt(p.trim(), 10));
				if (parts.some(isNaN)) continue;
				for (let i = 0; i < parts.length - 1; i++) {
					pairs.push({ fromTerminal: parts[i], toTerminal: parts[i + 1] });
				}
			}
			wiresStore.loadWires(pairs);
		};
		reader.readAsText(file);
		input.value = '';
	}

	// ── SVG pointer handling ───────────────────────────────────────────────────

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
	let processingRunClick = false;
</script>

<section class="board-shell">
	<div class="toolbar">
		<button
			class="run-btn"
			class:running={transientRunning}
			onclick={async (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (processingRunClick) return;
				processingRunClick = true;
				try {
					console.log(`[${new Date().toISOString()}] [Board] Run button clicked`, { speakerAudioEnabled, transientRunning });
					if (!speakerAudioEnabled) {
						speakerAudioEnabled = true;
						try {
							await startSpeakerAudio();
							if (workletHost) {
								workletHost.start();
								transientRunning = true;
							}
						} catch (err) {
							console.error('[run] startSpeakerAudio threw:', err);
							speakerAudioEnabled = false;
						}
					} else {
						toggleTransientRun();
					}
				} finally {
					// Small debounce to prevent double-clicks from rapid firing
					setTimeout(() => { processingRunClick = false; }, 100);
				}
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
		<button
			class="clear-btn"
			onclick={() => workletHost?.startDiagnosticCapture(5.0)}
			disabled={!workletHost || !transientRunning}
			title="Records 5 seconds of the worklet's internal audio chain (raw simulator output, post-DC-block, post-tanh) and downloads three WAV files for offline analysis."
		>
			Capture 5s diagnostic
		</button>
		<button
			class="clear-btn"
			class:running={speakerFilterOn}
			onclick={() => {
				speakerFilterOn = !speakerFilterOn;
				workletHost?.setSpeakerFilter({ enabled: speakerFilterOn });
			}}
			disabled={!workletHost}
			title="Speaker mechanical-resonance bandpass (~2.8 kHz). Converts the spike-train output of oscillator circuits (P18 siren, P45 tone) into a clean tone. Leave OFF for the metronome and other low-frequency circuits. Fine-tune from the console via workletHost.setSpeakerFilter with f0, Q, and gain options."
		>
			Speaker resonance: {speakerFilterOn ? 'on' : 'off'}
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
