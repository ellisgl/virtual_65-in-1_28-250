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
	import { buildSimulationNetlist, solveDcNetlist } from '$lib/sim';
	import { wiresStore } from '$lib/stores/wires.svelte';
	import type { ControlState, WireSpec, WorkerToMain } from '$lib/sim/worker-protocol';

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
	let solverEngine = $state<'ts' | 'rust'>(
			(typeof localStorage !== 'undefined' && localStorage.getItem('solverEngine') === 'rust')
					? 'rust'
					: 'ts',
	);
	// ── Controls helper ────────────────────────────────────────────────────────
	function currentControls(): ControlState {
		return {
			valueOverrides:    VARIABLE_CAPACITOR_COMPONENT ? { VC1: variableCapacitance } : {},
			positionOverrides: VARIABLE_RESISTOR_COMPONENT  ? { VR1: variableResistancePosition } : {},
			switchStates:      { ...switchStates }
		};
	}

	// ── Netlist (main thread, for button enable + lamp resistance display) ─────
	let netlist = $derived(
		buildSimulationNetlist(topology, KIT_COMPONENTS, {
			valueOverrides: VARIABLE_CAPACITOR_COMPONENT ? { VC1: variableCapacitance } : {},
			positionOverrides: VARIABLE_RESISTOR_COMPONENT ? { VR1: variableResistancePosition } : {},
			switchStates
		})
	);
	let dc = $derived(solveDcNetlist(netlist));

	let transientResetKey = $derived(
		JSON.stringify({
			nodeBindings:     topology.componentBindings,
			terminalToNode:   topology.terminalToNode,
			connectedNodeIds: topology.connectedNodeIds,
			groundNodeId:     topology.groundNodeId
		})
	);

	// ── Worker state ───────────────────────────────────────────────────────────
	let simWorker: Worker | null = $state(null);
	let workerVoltages = $state<Record<number, number>>({});
	let transientRunning = $state(false);

	// ── Audio ─────────────────────────────────────────────────────────────────
	let speakerAudioEnabled = $state(false);
	let audioContext: AudioContext | null = null;
	let audioWorkletNode: AudioWorkletNode | null = null;
	let audioMasterGain: GainNode | null = null;
	let audioHighpass: BiquadFilterNode | null = null;
	let audioSampleRate = $state<number | null>(null);
	let workletBufferFill = $state(0);

	// ── Display ────────────────────────────────────────────────────────────────
	let activeNodeVoltages = $derived(
		Object.keys(workerVoltages).length > 0 ? workerVoltages : dc.nodeVoltages
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

	// ── Worker lifecycle ───────────────────────────────────────────────────────

	$effect(() => {
		const w = new Worker(new URL('../sim/sim-worker.ts', import.meta.url), { type: 'module' });

		w.onerror = (e) => {
			console.error('[sim-worker] Worker error:', e.message ?? e);
		};

		w.onmessage = (e: MessageEvent<WorkerToMain>) => {
			const msg = e.data;
			if (e.data.type === 'engineReady') {
				console.log(`solver engine: ${e.data.engine}`);
				if (solverEngine === 'rust' && e.data.engine === 'ts') {
					console.warn('Rust requested but fell back to TS — build with `cd rust && ./build.sh`');
				}
			}

			if (msg.type === 'snapshot') {
				workerVoltages = msg.nodeVoltages;
			} else if (msg.type === 'audioSamples') {
				if (audioWorkletNode) {
					// Zero-copy transfer of the Float32Array buffer from main thread to
					// worklet.  The worklet accepts both Array and Float32Array (see the
					// typeof guard in speaker-worklet.js).  Avoiding Array.from() removes
					// a full-batch allocation+copy on every flush — important now that
					// flushes happen ~250/sec instead of ~23/sec.
					audioWorkletNode.port.postMessage(
						{ type: 'samples', values: msg.samples },
						[msg.samples.buffer]
					);
				}
			}
		};

		simWorker = w;

		return () => {
			w.postMessage({ type: 'stop' });
			w.terminate();
			simWorker = null;
		};
	});

	// Topology changed → full worker reset.
	$effect(() => {
		transientResetKey;
		const worker = simWorker;
		if (!worker) return;

		untrack(() => {
			const wasRunning = transientRunning;
			worker.postMessage({ type: 'stop' });
			transientRunning = false;
			workerVoltages = {};

			const wires: WireSpec[] = wiresStore.wires.map((w) => ({
				fromTerminal: w.fromTerminal,
				toTerminal:   w.toTerminal
			}));
			console.log('configure with engine:', solverEngine);
			worker.postMessage({ type: 'configure', wires, controls: currentControls(), engine: solverEngine });

			if (wasRunning && netlist.elements.length > 0 && netlist.groundNodeId !== null) {
				worker.postMessage({ type: 'start' });
				transientRunning = true;
			}
		});
	});

	// Controls changed → soft recompile (preserve transient state).
	$effect(() => {
		variableResistancePosition;
		variableCapacitance;
		switchStates;
		const worker = simWorker;
		if (!worker) return;
		untrack(() => {
			worker.postMessage({ type: 'updateControls', controls: currentControls() });
		});
	});

	// Audio sample rate → tell the worker.
	$effect(() => {
		const rate = audioSampleRate;
		untrack(() => simWorker?.postMessage({ type: 'audioRate', sampleRate: rate }));
	});

	onDestroy(() => {
		simWorker?.postMessage({ type: 'stop' });
		simWorker?.terminate();
		stopSpeakerAudio();
	});

	// ── Audio context ─────────────────────────────────────────────────────────

	async function startSpeakerAudio() {
		if (typeof window === 'undefined') return;
		if (audioContext) return;

		audioContext   = new AudioContext();
		audioMasterGain = audioContext.createGain();
		audioMasterGain.gain.value = 0.25;
		audioHighpass  = audioContext.createBiquadFilter();
		audioHighpass.type = 'highpass';
		audioHighpass.frequency.value = 25;

		try {
			await audioContext.audioWorklet.addModule('/audio/speaker-worklet.js');
			audioWorkletNode = new AudioWorkletNode(audioContext, 'speaker-sample-processor');
			audioSampleRate  = audioContext.sampleRate;

			audioWorkletNode.port.onmessage = (e) => {
				if (e.data?.type === 'bufferFill') {
					workletBufferFill = e.data.available ?? 0;
					simWorker?.postMessage({ type: 'backpressure', bufferFill: workletBufferFill });
				}
			};
			audioWorkletNode.connect(audioHighpass);
		} catch (err) {
			console.error('[audio] Failed to load speaker worklet:', err);
			speakerAudioEnabled = false;
			stopSpeakerAudio();
			return;
		}

		audioHighpass.connect(audioMasterGain);
		audioMasterGain.connect(audioContext.destination);

		// Tell the worker the sample rate directly — don't rely on Svelte reactivity
		// to pick up the change inside an async function.
		simWorker?.postMessage({ type: 'audioRate', sampleRate: audioSampleRate });

		// Await resume so we know if it actually started.
		try {
			await audioContext.resume();
		} catch (err) {
			console.error('[audio] AudioContext.resume() failed:', err);
		}
	}

	function stopSpeakerAudio() {
		if (audioWorkletNode) {
			audioWorkletNode.port.postMessage({ type: 'reset' });
			audioWorkletNode.disconnect();
			audioWorkletNode = null;
		}
		workletBufferFill = 0;
		audioSampleRate   = null;
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

	function toggleTransientRun() {
		if (!simWorker) return;
		if (transientRunning) {
			simWorker.postMessage({ type: 'stop' });
			transientRunning = false;
		} else {
			simWorker.postMessage({ type: 'start' });
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
