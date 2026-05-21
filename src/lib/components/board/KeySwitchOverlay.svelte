<script lang="ts">
	interface Props {
		pressed: boolean;
		hitbox: { x1: number; y1: number; x2: number; y2: number };
		center: { x: number; y: number };
		onPressedChange?: (pressed: boolean) => void;
	}

	let { pressed, hitbox, center, onPressedChange }: Props = $props();

	function setPressed(next: boolean, source: string) {
		if ((globalThis as any).__simDebug) {
			console.log(`[KEY1] ${next ? 'PRESS' : 'RELEASE'} (source: ${source})`);
		}
		onPressedChange?.(next);
	}
</script>

<g
	class="key-widget"
	class:key-pressed={pressed}
	role="button"
	tabindex="0"
	aria-label={`Morse code key (${pressed ? 'pressed' : 'open'})`}
	onpointerdown={(e) => {
		setPressed(true, 'pointerdown');
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
	}}
	onpointerup={(e) => {
		setPressed(false, 'pointerup');
		(e.currentTarget as Element).releasePointerCapture(e.pointerId);
	}}
	onpointercancel={(e) => {
		setPressed(false, 'pointercancel');
		if ((e.currentTarget as Element).hasPointerCapture(e.pointerId)) {
			(e.currentTarget as Element).releasePointerCapture(e.pointerId);
		}
	}}
	onpointerleave={(e) => {
		if (!(e.currentTarget instanceof Element) || !e.currentTarget.hasPointerCapture(e.pointerId)) {
			setPressed(false, 'pointerleave (no capture)');
		}
	}}
	onkeydown={(e) => {
		if (e.key === ' ' || e.key === 'Enter') setPressed(true, `keydown:${e.key}`);
	}}
	onkeyup={(e) => {
		if (e.key === ' ' || e.key === 'Enter') setPressed(false, `keyup:${e.key}`);
	}}
>
	<rect
		x={hitbox.x1}
		y={hitbox.y1}
		width={hitbox.x2 - hitbox.x1}
		height={hitbox.y2 - hitbox.y1}
		rx="3"
		class="key-hitbox"
	/>
	{#if pressed}
		<circle cx={center.x} cy={center.y} r="7" class="key-active-indicator" />
	{/if}
</g>

<style>
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
</style>

