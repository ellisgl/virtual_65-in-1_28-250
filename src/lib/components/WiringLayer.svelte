<script lang="ts">
import { TERMINAL_POSITIONS } from '$lib/data';
import type { Wire, DragState } from '$lib/types';
interface Props {
wires: Wire[];
drag: DragState;
onRemoveWire: (wireId: string) => void;
}
let { wires, drag, onRemoveWire }: Props = $props();
// Quadratic bezier with a natural downward sag — mimics a real wire drooping under gravity
function wirePath(fx: number, fy: number, tx: number, ty: number): string {
const dx = tx - fx;
const dy = ty - fy;
const dist = Math.sqrt(dx * dx + dy * dy);
const sag = Math.min(dist * 0.25, 18);
const mx = (fx + tx) / 2;
const my = (fy + ty) / 2 + sag;
return `M ${fx} ${fy} Q ${mx} ${my} ${tx} ${ty}`;
}
function handleWireContextMenu(e: MouseEvent, wireId: string) {
e.preventDefault();
e.stopPropagation();
onRemoveWire(wireId);
}
</script>
<g class="wiring-layer">
{#each wires as wire (wire.id)}
{@const from = TERMINAL_POSITIONS[wire.fromTerminal]}
{@const to = TERMINAL_POSITIONS[wire.toTerminal]}
{#if from && to}
<!-- Wire shadow for depth -->
<path
class="wire-shadow"
d={wirePath(from.x, from.y + 0.4, to.x, to.y + 0.4)}
/>
<!-- Wire itself -->
			<path
				class="wire"
				stroke={wire.color}
				d={wirePath(from.x, from.y, to.x, to.y)}
				role="button"
				tabindex="0"
				aria-label={`Wire from terminal ${wire.fromTerminal} to ${wire.toTerminal}`}
				oncontextmenu={(e) => handleWireContextMenu(e, wire.id)}
			>
<title>Wire {wire.fromTerminal}–{wire.toTerminal} (right-click to remove)</title>
</path>
{/if}
{/each}
{#if drag.active && drag.fromTerminal !== null}
{@const from = TERMINAL_POSITIONS[drag.fromTerminal]}
{#if from}
<path
class="wire ghost"
d={wirePath(from.x, from.y, drag.currentX, drag.currentY)}
/>
{/if}
{/if}
</g>
<style>
.wire {
fill: none;
stroke-width: 1.2;
stroke-linecap: round;
cursor: pointer;
pointer-events: stroke;
}
.wire:hover {
stroke-width: 2;
filter: brightness(1.4);
}
.wire.ghost {
stroke: #ffffff;
stroke-width: 1;
stroke-dasharray: 3 2;
opacity: 0.7;
pointer-events: none;
cursor: none;
}
.wire-shadow {
fill: none;
stroke: rgba(0, 0, 0, 0.35);
stroke-width: 1.6;
stroke-linecap: round;
pointer-events: none;
}
</style>
