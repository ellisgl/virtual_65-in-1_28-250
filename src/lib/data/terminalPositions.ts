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
TERMINAL_POSITIONS[38]  = { x: 64,  y: 180 };
TERMINAL_POSITIONS[39]  = { x: 64,  y: 200 };

// Antenna Coil
TERMINAL_POSITIONS[40]  = { x: 29,  y: 225 };
TERMINAL_POSITIONS[41]  = { x: 44,  y: 225 };
TERMINAL_POSITIONS[42]  = { x: 59,  y: 225 };
TERMINAL_POSITIONS[43]  = { x: 74,  y: 225 };
TERMINAL_POSITIONS[44]  = { x: 95,  y: 225 };
TERMINAL_POSITIONS[45]  = { x: 95,  y: 252 };

// Transistors
TERMINAL_POSITIONS[46]  = { x: 144, y: 60  };
TERMINAL_POSITIONS[47]  = { x: 177, y: 50  };
TERMINAL_POSITIONS[48]  = { x: 177, y: 70  };

TERMINAL_POSITIONS[49]  = { x: 144, y: 100 };
TERMINAL_POSITIONS[50]  = { x: 177, y: 88  };
TERMINAL_POSITIONS[51]  = { x: 177, y: 108 };

TERMINAL_POSITIONS[52]  = { x: 144, y: 138 };
TERMINAL_POSITIONS[53]  = { x: 155, y: 130 };
TERMINAL_POSITIONS[54]  = { x: 155, y: 145 };

// SCR
TERMINAL_POSITIONS[55]  = { x: 153, y: 170 };
TERMINAL_POSITIONS[56]  = { x: 170, y: 170 };
TERMINAL_POSITIONS[57]  = { x: 161.5, y: 185 };

// Diodes
TERMINAL_POSITIONS[58]  = { x: 116, y: 207.5 };
TERMINAL_POSITIONS[59]  = { x: 145, y: 207.5 };

TERMINAL_POSITIONS[60]  = { x: 170, y: 207.5 };
TERMINAL_POSITIONS[61]  = { x: 199, y: 207.5 };

// Zener
TERMINAL_POSITIONS[62]  = { x: 145, y: 245 };
TERMINAL_POSITIONS[63]  = { x: 175, y: 245 };

// Solar Battery (Cell)
TERMINAL_POSITIONS[64]  = { x: 220, y: 57  };
TERMINAL_POSITIONS[65]  = { x: 256, y: 57  };

// CdS Cell
TERMINAL_POSITIONS[66]  = { x: 289, y: 57  };
TERMINAL_POSITIONS[67]  = { x: 310, y: 57  };

// Signal Lamp
TERMINAL_POSITIONS[68]  = { x: 334, y: 57  };
TERMINAL_POSITIONS[69]  = { x: 368, y: 57  };

// Transformer
TERMINAL_POSITIONS[70]  = { x: 224, y: 78  };
TERMINAL_POSITIONS[71]  = { x: 224, y: 94  };
TERMINAL_POSITIONS[72]  = { x: 224, y: 110 };
TERMINAL_POSITIONS[73]  = { x: 279, y: 78  };
TERMINAL_POSITIONS[74]  = { x: 279, y: 110 };

// Relay
TERMINAL_POSITIONS[75]  = { x: 312, y: 100 };
TERMINAL_POSITIONS[76]  = { x: 312, y: 120 };
TERMINAL_POSITIONS[77]  = { x: 365, y: 80  };
TERMINAL_POSITIONS[78]  = { x: 365, y: 100 };
TERMINAL_POSITIONS[79]  = { x: 365, y: 120 };

// Meter
TERMINAL_POSITIONS[80]  = { x: 224, y: 176 };
TERMINAL_POSITIONS[81]  = { x: 277, y: 176 };

// Key (These are just connection posts to an external part)
TERMINAL_POSITIONS[82]  = { x: 336, y: 150 };
TERMINAL_POSITIONS[83]  = { x: 365, y: 150 };

// Earphone (There are just connection posts to an external part)
TERMINAL_POSITIONS[84]  = { x: 336, y: 167 };
TERMINAL_POSITIONS[85]  = { x: 365, y: 167 };

// 9V
TERMINAL_POSITIONS[86]  = { x: 220, y: 194 };
TERMINAL_POSITIONS[87]  = { x: 220, y: 209 };

// 3V
TERMINAL_POSITIONS[88]  = { x: 220, y: 226 };
TERMINAL_POSITIONS[89]  = { x: 220, y: 243 };

// Speaker
TERMINAL_POSITIONS[90]  = { x: 317, y: 184 };
TERMINAL_POSITIONS[91]  = { x: 357, y: 184 };