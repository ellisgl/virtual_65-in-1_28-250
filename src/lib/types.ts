export type ComponentKind =
	| 'resistor'
	| 'potentiometer'
	| 'capacitor'
	| 'variable-capacitor'
	| 'inductor'
	| 'transistor'
	| 'scr'
	| 'diode'
	| 'zener-diode'
	| 'battery'
	| 'speaker'
	| 'transformer'
	| 'lamp'
	| 'relay'
	| 'antenna';

export type DeviceModelType = 'diode' | 'bjt' | 'scr' | 'relay' | 'lamp';

export interface DeviceModel {
	name: string;
	type: DeviceModelType;
	params: Record<string, number | string | boolean>;
}

export interface KitComponent {
	id: string;
	kind: ComponentKind;
	name: string;
	terminals: number[];
	value?: number;
	unit?: string;
	model?: DeviceModel;
	metadata?: Record<string, number | string | boolean>;
}

export interface TerminalPosition {
	x: number;
	y: number;
}

export interface Wire {
	id: string;
	fromTerminal: number;
	toTerminal: number;
	color: string;
}

export interface DragState {
	active: boolean;
	fromTerminal: number | null;
	currentX: number;
	currentY: number;
}

