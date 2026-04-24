<script lang="ts">
import { KIT_TERMINAL_IDS, TERMINAL_POSITIONS, isTerminalPositionMapped } from '$lib/data';
import { wiresStore } from '$lib/stores/wires.svelte';
import Terminal from '$lib/components/Terminal.svelte';
import WiringLayer from '$lib/components/WiringLayer.svelte';
const mappedTerminalIds = KIT_TERMINAL_IDS.filter((id) => isTerminalPositionMapped(id));
const unmappedCount = KIT_TERMINAL_IDS.length - mappedTerminalIds.length;
let overlaySvg: SVGSVGElement;
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
// Capture pointer to the SVG so moves/up fire even outside terminal dots
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
function handlePointerUp() {
// Fired on SVG (not on a terminal) — cancel the drag
wiresStore.cancel();
}
function handleRemoveTerminalWires(terminalId: number) {
wiresStore.removeByTerminal(terminalId);
}
</script>
<section class="board-shell">
<div class="toolbar">
<span class="wire-count">{wiresStore.wires.length} wire{wiresStore.wires.length !== 1 ? 's' : ''}</span>
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
			viewBox="0 0 387 267"
			role="application"
			aria-label="Kit board wiring area"
			bind:this={overlaySvg}
			onpointermove={handlePointerMove}
			onpointerup={handlePointerUp}
		>
<!-- Transparent capture surface so pointermove fires between terminals -->
<rect width="387" height="267" fill="transparent" />
<WiringLayer
wires={wiresStore.wires}
drag={wiresStore.drag}
onRemoveWire={(id) => wiresStore.removeWire(id)}
/>
{#each mappedTerminalIds as id (id)}
<Terminal
id={id}
x={TERMINAL_POSITIONS[id].x}
y={TERMINAL_POSITIONS[id].y}
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
.wire-count {
font-size: 0.9rem;
color: #aaa;
min-width: 5ch;
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
.mapping-hint {
font-size: 0.8rem;
color: #888;
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
