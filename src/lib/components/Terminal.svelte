<script lang="ts">
	interface Props {
		id: number;
		x: number;
		y: number;
		radius?: number;
		isDragSource?: boolean;
		onDragStart?: (terminalId: number, e: PointerEvent) => void;
		onConnect?: (terminalId: number, e: PointerEvent) => void;
		onRemove?: (terminalId: number) => void;
	}

	let {
		id,
		x,
		y,
		radius = 1.8,
		isDragSource = false,
		onDragStart,
		onConnect,
		onRemove
	}: Props = $props();

	function handlePointerDown(e: PointerEvent) {
		e.stopPropagation();
		onDragStart?.(id, e);
	}

	function handlePointerUp(e: PointerEvent) {
		e.stopPropagation();
		onConnect?.(id, e);
	}

	function handleContextMenu(e: MouseEvent) {
		e.preventDefault();
		onRemove?.(id);
	}
</script>

<g
	class="terminal"
	class:source={isDragSource}
	transform={`translate(${x} ${y})`}
	role="button"
	tabindex="0"
	aria-label={`Terminal ${id}`}
	onpointerdown={handlePointerDown}
	onpointerup={handlePointerUp}
	oncontextmenu={handleContextMenu}
>
	<circle class="terminal-hit" r={radius * 1.8} />
	<circle class="terminal-dot" r={radius} />
	<title>Terminal {id}</title>
</g>

<style>
	.terminal {
		cursor: crosshair;
	}

	.terminal-hit {
		fill: transparent;
	}

	.terminal-dot {
		fill: #d4a24f;
		stroke: #3f2f12;
		stroke-width: 0.35;
		transition:
			fill 0.1s,
			r 0.1s;
	}

	.terminal:hover .terminal-dot {
		fill: #f7d97c;
		r: 2.4;
	}

	.source .terminal-dot {
		fill: #ffffff;
		stroke: #1e88e5;
		stroke-width: 0.7;
	}
</style>
