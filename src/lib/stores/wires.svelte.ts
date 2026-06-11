import { KIT_COMPONENTS } from '$lib/data/components';
import { TERMINAL_POSITIONS } from '$lib/data/terminalPositions';
import { buildCircuitTopology } from '$lib/sim/topology';
import type { DragState, Wire } from '$lib/types';

// ── Wire colour model ────────────────────────────────────────────────────────
//
// Each wire is coloured as the shortest standard wire length that can
// physically bridge its endpoints, matching the kit's physical wire bins:
//
//   White  — 7.5 cm    Red    — 15 cm    Blue   — 25 cm
//   Yellow — 35 cm     Black  — 38 cm    Green  — 3 m
//
// Approximate SVG coordinate scale: 11 units ≈ 1 cm.
// Adjust SVG_UNITS_PER_CM if the board artwork changes.

const SVG_UNITS_PER_CM = 11;

const WIRE_BINS = [
	{ maxCm: 15,  color: '#e53935' }, // red    — 15 cm
	{ maxCm: 25,  color: '#1e88e5' }, // blue   — 25 cm
	{ maxCm: 38,  color: '#fdd835' }, // yellow — 38 cm
	{ maxCm: 300, color: '#43a047' }, // green  — 3 m
] as const;

function wireInfo(fromTerminal: number, toTerminal: number): { color: string; lengthCm: number } {
	const from = TERMINAL_POSITIONS[fromTerminal];
	const to   = TERMINAL_POSITIONS[toTerminal];
	// Unmapped terminals (position −1, −1) default to the shortest wire.
	if (!from || !to || from.x < 0 || to.x < 0) return { color: WIRE_BINS[0].color, lengthCm: WIRE_BINS[0].maxCm };
	const cm = Math.hypot(to.x - from.x, to.y - from.y) / SVG_UNITS_PER_CM;
	for (const bin of WIRE_BINS) {
		if (cm <= bin.maxCm) return { color: bin.color, lengthCm: bin.maxCm };
	}
	return { color: WIRE_BINS[WIRE_BINS.length - 1].color, lengthCm: WIRE_BINS[WIRE_BINS.length - 1].maxCm };
}

// ── Store ────────────────────────────────────────────────────────────────────

function makeStore() {
	let wires = $state<Wire[]>([]);
	let drag = $state<DragState>({
		active: false,
		fromTerminal: null,
		currentX: 0,
		currentY: 0,
		shapingPoints: []
	});
	let _topology = $derived(buildCircuitTopology(wires, KIT_COMPONENTS));

	return {
		get wires() {
			return wires;
		},
		get drag() {
			return drag;
		},
		get topology() {
			return _topology;
		},
		startDrag(fromTerminal: number, x: number, y: number) {
			if (drag.active && drag.fromTerminal !== null) {
				// If clicking a terminal while one is already selected, try to complete
				this.complete(fromTerminal);
				return;
			}
			drag.active = true;
			drag.fromTerminal = fromTerminal;
			drag.currentX = x;
			drag.currentY = y;
			drag.shapingPoints = [];
		},
		addShapingPoint(x: number, y: number) {
			if (!drag.active) return;
			drag.shapingPoints.push({ x, y });
		},
		updateDrag(x: number, y: number) {
			drag.currentX = x;
			drag.currentY = y;
		},
		complete(toTerminal: number) {
			if (!drag.active || drag.fromTerminal === null) return;
			if (drag.fromTerminal === toTerminal) {
				this.cancel();
				return;
			}
			const from = drag.fromTerminal;
			const exists = wires.some(
				(w) =>
					(w.fromTerminal === from && w.toTerminal === toTerminal) ||
					(w.fromTerminal === toTerminal && w.toTerminal === from)
			);
			if (!exists) {
				const info = wireInfo(from, toTerminal);
				wires.push({
					id: crypto.randomUUID(),
					fromTerminal: from,
					toTerminal,
					color: info.color,
					lengthCm: info.lengthCm,
					shapingPoints: [...drag.shapingPoints]
				});
			}
			this.cancel();
		},
		cancel() {
			drag.active = false;
			drag.fromTerminal = null;
			drag.shapingPoints = [];
		},
		removeWire(id: string) {
			const idx = wires.findIndex((w) => w.id === id);
			if (idx !== -1) wires.splice(idx, 1);
		},
		removeByTerminal(terminalId: number) {
			for (let i = wires.length - 1; i >= 0; i--) {
				if (wires[i].fromTerminal === terminalId || wires[i].toTerminal === terminalId) {
					wires.splice(i, 1);
				}
			}
		},
		clearAll() {
			wires.length = 0;
		},
		loadWires(newWires: Array<{ fromTerminal: number; toTerminal: number }>) {
			wires.length = 0;
			for (const { fromTerminal, toTerminal } of newWires) {
				const exists = wires.some(
					(w) =>
						(w.fromTerminal === fromTerminal && w.toTerminal === toTerminal) ||
						(w.fromTerminal === toTerminal && w.toTerminal === fromTerminal)
				);
				if (!exists) {
					const info = wireInfo(fromTerminal, toTerminal);
					wires.push({
						id: crypto.randomUUID(),
						fromTerminal,
						toTerminal,
						color: info.color,
						lengthCm: info.lengthCm
					});
				}
			}
		}
	};
}

export const wiresStore = makeStore();
