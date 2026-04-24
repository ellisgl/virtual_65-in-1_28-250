import { KIT_TERMINAL_IDS } from '$lib/data/components';
import type { TerminalPosition } from '$lib/types';

// Use -1 placeholders until springs are measured from the board artwork.
export const TERMINAL_POSITIONS: Record<number, TerminalPosition> = Object.fromEntries(
	KIT_TERMINAL_IDS.map((id) => [id, { x: -1, y: -1 }])
);

export function isTerminalPositionMapped(terminalId: number): boolean {
	const position = TERMINAL_POSITIONS[terminalId];
	if (!position) return false;
	return position.x >= 0 && position.y >= 0;
}

