<script lang="ts">
	interface Props {
		center: { x: number; y: number };
		opacity: number;
	}

	let { center, opacity }: Props = $props();
</script>

<g class="lamp-glow" style={`opacity: ${opacity.toFixed(3)};`} aria-hidden="true">
	<circle class="lamp-glow-outer" cx={center.x} cy={center.y} r="18" />
	<circle class="lamp-glow-inner" cx={center.x} cy={center.y} r="9.5" />
</g>

<style>
	.lamp-glow {
		pointer-events: none;
	}

	.lamp-glow-outer {
		fill: rgba(255, 90, 30, 0.35);
	}

	.lamp-glow-inner {
		fill: rgba(255, 180, 40, 0.9);
	}
</style>

