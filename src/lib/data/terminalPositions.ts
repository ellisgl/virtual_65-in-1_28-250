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

// Resistors
TERMINAL_POSITIONS[1]   = { x: 15,  y: 20  };
TERMINAL_POSITIONS[2]   = { x: 45,  y: 20  };
TERMINAL_POSITIONS[3]   = { x: 15,  y: 35  };
TERMINAL_POSITIONS[4]   = { x: 45,  y: 35  };
TERMINAL_POSITIONS[5]   = { x: 15,  y: 50  };
TERMINAL_POSITIONS[6]   = { x: 45,  y: 50  };
TERMINAL_POSITIONS[7]   = { x: 15,  y: 65  };
TERMINAL_POSITIONS[8]   = { x: 45,  y: 65  };
TERMINAL_POSITIONS[9]   = { x: 15,  y: 80  };
TERMINAL_POSITIONS[10]  = { x: 45,  y: 80  };
TERMINAL_POSITIONS[11]  = { x: 15,  y: 95  };
TERMINAL_POSITIONS[12]  = { x: 45,  y: 95  };
TERMINAL_POSITIONS[13]  = { x: 15,  y: 110 };
TERMINAL_POSITIONS[14]  = { x: 45,  y: 110 };
TERMINAL_POSITIONS[15]  = { x: 15,  y: 125 };
TERMINAL_POSITIONS[16]  = { x: 45,  y: 125 };
TERMINAL_POSITIONS[17]  = { x: 15,  y: 140 };
TERMINAL_POSITIONS[18]  = { x: 45,  y: 140 };
TERMINAL_POSITIONS[19]  = { x: 15,  y: 155 };
TERMINAL_POSITIONS[20]  = { x: 45,  y: 155 };

// Variable Resistor
TERMINAL_POSITIONS[21]  = { x: 15,  y: 177 };
TERMINAL_POSITIONS[22]  = { x: 15,  y: 190 };
TERMINAL_POSITIONS[23]  = { x: 15,  y: 205 };

// Capacitors
TERMINAL_POSITIONS[24]  = { x: 68,  y: 20  };
TERMINAL_POSITIONS[25]  = { x: 98,  y: 20  };
TERMINAL_POSITIONS[26]  = { x: 68,  y: 43  };
TERMINAL_POSITIONS[27]  = { x: 98,  y: 43  };
TERMINAL_POSITIONS[28]  = { x: 68,  y: 63  };
TERMINAL_POSITIONS[29]  = { x: 98,  y: 63  };
TERMINAL_POSITIONS[30]  = { x: 68,  y: 83  };
TERMINAL_POSITIONS[31]  = { x: 98,  y: 83  };
TERMINAL_POSITIONS[32]  = { x: 68,  y: 104 };
TERMINAL_POSITIONS[33]  = { x: 98,  y: 104 };
TERMINAL_POSITIONS[34]  = { x: 68,  y: 124 };
TERMINAL_POSITIONS[35]  = { x: 98,  y: 124 };
TERMINAL_POSITIONS[36]  = { x: 68,  y: 145 };
TERMINAL_POSITIONS[37]  = { x: 98,  y: 145 };

// Variable Capacitor
TERMINAL_POSITIONS[38]  = { x: 68,  y: 180 };
TERMINAL_POSITIONS[39]  = { x: 68,  y: 200 };

// Antenna Coil
TERMINAL_POSITIONS[40]  = { x: 29,  y: 225 };
TERMINAL_POSITIONS[41]  = { x: 44,  y: 225 };
TERMINAL_POSITIONS[42]  = { x: 59,  y: 225 };
TERMINAL_POSITIONS[43]  = { x: 74,  y: 225 };
TERMINAL_POSITIONS[44]  = { x: 95,  y: 225 };
TERMINAL_POSITIONS[45]  = { x: 95,  y: 251 };