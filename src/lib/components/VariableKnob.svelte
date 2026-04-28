<script lang="ts">
	import { onDestroy } from 'svelte';

	type KnobVariant = 'round' | 'chickenhead';

	interface Props {
		x: number;
		y: number;
		radius: number;
		value: number;
		min: number;
		max: number;
		label?: string;
		startAngle?: number;
		endAngle?: number;
		tickCount?: number;
		showTicks?: boolean;
		variant?: KnobVariant;
		onChange?: (value: number) => void;
	}

	let {
		x,
		y,
		radius,
		value,
		min,
		max,
		label = 'Knob',
		startAngle = 90,
		endAngle = -90,
		tickCount = 11,
		showTicks = true,
		variant = 'round',
		onChange
	}: Props = $props();

	let knobElement: SVGGElement;
	let dragging = $state(false);

	function clamp(valueToClamp: number, minValue: number, maxValue: number): number {
		return Math.max(minValue, Math.min(maxValue, valueToClamp));
	}

	function normalizeAngle(angle: number): number {
		let normalized = angle;
		while (normalized < 0) normalized += 360;
		while (normalized >= 360) normalized -= 360;
		return normalized;
	}

	function denormalizeAngle(angle: number): number {
		return angle > 180 ? angle - 360 : angle;
	}

	function getRawStart(): number {
		return normalizeAngle(startAngle);
	}

	function getRawSweep(): number {
		if (endAngle >= startAngle) return endAngle - startAngle;
		return 360 - normalizeAngle(startAngle) + normalizeAngle(endAngle);
	}

	function getCurrentRawAngle(currentValue: number): number {
		const sweep = getRawSweep();
		const t = max === min ? 0 : (currentValue - min) / (max - min);
		return getRawStart() + clamp(t, 0, 1) * sweep;
	}

	function valueToAngle(currentValue: number): number {
		const normalizedAngle = normalizeAngle(getCurrentRawAngle(currentValue));
		return denormalizeAngle(normalizedAngle);
	}

	function angleToValue(angleDeg: number): number {
		const rawStart = getRawStart();
		const sweep = getRawSweep();
		const rawEnd = rawStart + sweep;
		const normalizedAngle = normalizeAngle(angleDeg);
		const referenceRawAngle = getCurrentRawAngle(value);
		const candidates = [normalizedAngle - 360, normalizedAngle, normalizedAngle + 360];
		const nearestRawAngle = candidates.reduce((closest, candidate) => {
			return Math.abs(candidate - referenceRawAngle) < Math.abs(closest - referenceRawAngle)
				? candidate
				: closest;
		}, candidates[0]);
		const clampedRawAngle = clamp(nearestRawAngle, rawStart, rawEnd);
		const t = sweep === 0 ? 0 : (clampedRawAngle - rawStart) / sweep;
		return min + t * (max - min);
	}

	function polarPoint(angleDeg: number, distance: number): { x: number; y: number } {
		const radians = (angleDeg * Math.PI) / 180;
		return {
			x: x + Math.cos(radians) * distance,
			y: y + Math.sin(radians) * distance
		};
	}

	function getSvgCoordinates(event: PointerEvent): { x: number; y: number } | null {
		const svg = knobElement.ownerSVGElement;
		if (!svg) return null;
		const pt = svg.createSVGPoint();
		pt.x = event.clientX;
		pt.y = event.clientY;
		const transformed = pt.matrixTransform(svg.getScreenCTM()?.inverse());
		return { x: transformed.x, y: transformed.y };
	}

	function updateFromPointer(event: PointerEvent) {
		const coords = getSvgCoordinates(event);
		if (!coords) return;
		const angle = (Math.atan2(coords.y - y, coords.x - x) * 180) / Math.PI;
		onChange?.(clamp(angleToValue(angle), min, max));
	}

	function handlePointerDown(event: PointerEvent) {
		event.preventDefault();
		event.stopPropagation();
		dragging = true;
		updateFromPointer(event);
		window.addEventListener('pointermove', handlePointerMove);
		window.addEventListener('pointerup', handlePointerUp);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!dragging) return;
		updateFromPointer(event);
	}

	function handlePointerUp() {
		dragging = false;
		removePointerListeners();
	}

	function removePointerListeners() {
		if (typeof window === 'undefined') return;
		window.removeEventListener('pointermove', handlePointerMove);
		window.removeEventListener('pointerup', handlePointerUp);
	}

	function handleKeyDown(event: KeyboardEvent) {
		const step = (max - min) / 100;
		if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
			event.preventDefault();
			onChange?.(clamp(value - step, min, max));
		}
		if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
			event.preventDefault();
			onChange?.(clamp(value + step, min, max));
		}
	}

	onDestroy(() => {
		removePointerListeners();
	});

	const indicatorAngle = $derived(valueToAngle(value));
	const indicatorRadians = $derived((indicatorAngle * Math.PI) / 180);
	const pointerX = $derived(x + Math.cos(indicatorRadians) * (radius * 0.68));
	const pointerY = $derived(y + Math.sin(indicatorRadians) * (radius * 0.68));
	const tickMarks = $derived(
		showTicks
			? Array.from({ length: tickCount }, (_, index) => {
					const denominator = Math.max(1, tickCount - 1);
					const t = index / denominator;
					const sweep = getRawSweep();
					const angle = denormalizeAngle(normalizeAngle(getRawStart() + t * sweep));
					const isMajor =
						index === 0 || index === tickCount - 1 || index === Math.floor((tickCount - 1) / 2);
					const outer = polarPoint(angle, radius * 1.28);
					const inner = polarPoint(angle, radius * (isMajor ? 1.03 : 1.12));
					return { outer, inner, isMajor };
				})
			: []
	);
	const chickenheadTransform = $derived(`rotate(${indicatorAngle} ${x} ${y})`);
	const chickenheadPath = $derived(
		[
			`M ${x} ${y - radius * 0.98}`,
			`C ${x + radius * 0.26} ${y - radius * 0.8}, ${x + radius * 0.24} ${y - radius * 0.2}, ${x + radius * 0.13} ${y + radius * 0.42}`,
			`L ${x - radius * 0.13} ${y + radius * 0.42}`,
			`C ${x - radius * 0.24} ${y - radius * 0.2}, ${x - radius * 0.26} ${y - radius * 0.8}, ${x} ${y - radius * 0.98}`,
			'Z'
		].join(' ')
	);
</script>

<g
	bind:this={knobElement}
	class="variable-knob"
	class:dragging
	class:chickenhead={variant === 'chickenhead'}
	role="slider"
	tabindex="0"
	aria-label={label}
	aria-valuemin={min}
	aria-valuemax={max}
	aria-valuenow={value}
	onpointerdown={handlePointerDown}
	onkeydown={handleKeyDown}
>
	{#each tickMarks as tick}
		<line
			class="knob-tick"
			class:major={tick.isMajor}
			x1={tick.inner.x}
			y1={tick.inner.y}
			x2={tick.outer.x}
			y2={tick.outer.y}
		/>
	{/each}
	<circle class="knob-shadow" cx={x} cy={y + 0.8} r={radius} />
	<circle class="knob-body" cx={x} cy={y} r={radius} />
	{#if variant === 'chickenhead'}
		<g transform={chickenheadTransform}>
			<path class="chickenhead-shape" d={chickenheadPath} />
			<circle class="knob-cap" cx={x} cy={y + radius * 0.18} r={radius * 0.15} />
		</g>
	{:else}
		<circle class="knob-inner" cx={x} cy={y} r={radius * 0.72} />
		<line class="knob-indicator" x1={x} y1={y} x2={pointerX} y2={pointerY} />
		<circle class="knob-cap" cx={x} cy={y} r={radius * 0.13} />
	{/if}
	<title>{label}</title>
</g>

<style>
	.variable-knob {
		cursor: grab;
	}

	.variable-knob.dragging {
		cursor: grabbing;
	}

	.variable-knob:focus-visible .knob-body {
		stroke: #9dd6ff;
		stroke-width: 0.8;
	}

	.knob-shadow {
		fill: rgba(0, 0, 0, 0.28);
		pointer-events: none;
	}

	.knob-tick {
		stroke: rgba(30, 24, 16, 0.75);
		stroke-width: 0.45;
		stroke-linecap: round;
		pointer-events: none;
	}

	.knob-tick.major {
		stroke-width: 0.7;
	}

	.knob-body {
		fill: #ddd6c7;
		stroke: #544a39;
		stroke-width: 0.6;
	}

	.knob-inner {
		fill: #a89f90;
		stroke: rgba(255, 255, 255, 0.28);
		stroke-width: 0.25;
		pointer-events: none;
	}

	.chickenhead-shape {
		fill: #ece1c6;
		stroke: #2f291f;
		stroke-width: 0.5;
		pointer-events: none;
	}

	.variable-knob.chickenhead .knob-body {
		fill: #cbbf9f;
	}

	.knob-indicator {
		stroke: #181818;
		stroke-width: 1.2;
		stroke-linecap: round;
		pointer-events: none;
	}

	.knob-cap {
		fill: #222;
		pointer-events: none;
	}
</style>

