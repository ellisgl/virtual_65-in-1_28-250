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
	{ maxCm: 7.5,      color: '#ffffff' }, // white  — 7.5 cm
	{ maxCm: 15,       color: '#e53935' }, // red    — 15 cm
	{ maxCm: 25,       color: '#1e88e5' }, // blue   — 25 cm
	{ maxCm: 35,       color: '#fdd835' }, // yellow — 35 cm
	{ maxCm: 38,       color: '#2d2d2d' }, // black  — 38 cm
	{ maxCm: Infinity, color: '#43a047' }, // green  — 3 m
] as const;

function wireColor(fromTerminal: number, toTerminal: number): string {
	const from = TERMINAL_POSITIONS[fromTerminal];
	const to   = TERMINAL_POSITIONS[toTerminal];
	// Unmapped terminals (position −1, −1) default to the shortest wire.
	if (!from || !to || from.x < 0 || to.x < 0) return WIRE_BINS[0].color;
	const cm = Math.hypot(to.x - from.x, to.y - from.y) / SVG_UNITS_PER_CM;
	for (const bin of WIRE_BINS) {
		if (cm <= bin.maxCm) return bin.color;
	}
	return WIRE_BINS[WIRE_BINS.length - 1].color;
}

// ── Store ────────────────────────────────────────────────────────────────────

function makeStore() {
	let wires = $state<Wire[]>([]);
	let drag = $state<DragState>({
		active: false,
		fromTerminal: null,
		currentX: 0,
		currentY: 0
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
			drag.active = true;
			drag.fromTerminal = fromTerminal;
			drag.currentX = x;
			drag.currentY = y;
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
				wires.push({
					id: crypto.randomUUID(),
					fromTerminal: from,
					toTerminal,
					color: wireColor(from, toTerminal)
				});
			}
			this.cancel();
		},
		cancel() {
			drag.active = false;
			drag.fromTerminal = null;
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
					wires.push({
						id: crypto.randomUUID(),
						fromTerminal,
						toTerminal,
						color: wireColor(fromTerminal, toTerminal)
					});
				}
			}
		}
	};
}

export const wiresStore = makeStore();
