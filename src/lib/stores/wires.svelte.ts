import { KIT_COMPONENTS } from '$lib/data/components';
import { buildCircuitTopology } from '$lib/sim/topology';
import type { DragState, Wire } from '$lib/types';

const WIRE_COLORS = [
	'#e53935',
	'#1e88e5',
	'#43a047',
	'#fdd835',
	'#ff6f00',
	'#6a1b9a',
	'#00838f',
	'#f4511e'
];

let colorIndex = 0;

function nextColor(): string {
	return WIRE_COLORS[colorIndex++ % WIRE_COLORS.length];
}

function makeStore() {
	let wires = $state<Wire[]>([]);
	let drag = $state<DragState>({
		active: false,
		fromTerminal: null,
		currentX: 0,
		currentY: 0
	});

	return {
		get wires() {
			return wires;
		},
		get drag() {
			return drag;
		},
		get topology() {
			return buildCircuitTopology(wires, KIT_COMPONENTS);
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
					color: nextColor()
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
			colorIndex = 0;
		}
	};
}

export const wiresStore = makeStore();
