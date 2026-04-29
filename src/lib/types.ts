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
	| 'antenna'
	| 'switch'
	| 'voltmeter';

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

export interface CircuitNode {
	nodeId: number;
	terminals: number[];
}

export interface ComponentNodeBinding {
	componentId: string;
	componentKind: ComponentKind;
	terminals: number[];
	nodeIds: number[];
}

export interface CircuitTopology {
	nodes: CircuitNode[];
	terminalToNode: Record<number, number>;
	componentBindings: ComponentNodeBinding[];
	connectedNodeIds: number[];
	groundNodeId: number | null;
	wireCount: number;
}

export interface SimulationResistorElement {
	type: 'resistor';
	componentId: string;
	nodes: [number, number];
	resistanceOhms: number;
}

export interface SimulationVoltageSourceElement {
	type: 'voltage-source';
	componentId: string;
	positiveNode: number;
	negativeNode: number;
	voltage: number;
}

export interface SimulationCapacitorElement {
	type: 'capacitor';
	componentId: string;
	nodes: [number, number];
	capacitanceFarads: number;
	initialVoltage: number;
}

export interface SimulationTransistorElement {
	type: 'transistor';
	componentId: string;
	polarity: 'npn' | 'pnp';
	baseNode: number;
	collectorNode: number;
	emitterNode: number;
	beta: number;
}

export interface SimulationRelayElement {
	type: 'relay';
	componentId: string;
	coilPositiveNode: number;
	coilNegativeNode: number;
	commonNode: number;
	normallyClosedNode: number;
	normallyOpenNode: number;
	coilResistanceOhms: number;
	ronOhms: number;
	roffOhms: number;
	onCurrent: number;
	offCurrent: number;
}

export type SimulationElement =
	| SimulationResistorElement
	| SimulationVoltageSourceElement
	| SimulationCapacitorElement
	| SimulationTransistorElement
	| SimulationRelayElement;

export interface UnsupportedElement {
	componentId: string;
	kind: ComponentKind;
	reason: string;
}

export interface SimulationNetlist {
	elements: SimulationElement[];
	unsupported: UnsupportedElement[];
	groundNodeId: number | null;
	connectedNodeIds: number[];
}

export interface SimulationBuildOptions {
	valueOverrides?: Record<string, number>;
	positionOverrides?: Record<string, number>;
	switchStates?: Record<string, boolean>;
}

export type DcSolveIssueCode =
	| 'no-ground'
	| 'empty-netlist'
	| 'singular-matrix'
	| 'unsupported-elements'
	| 'floating-subcircuit'
	| 'capacitor-open-circuit';

export interface DcSolveIssue {
	code: DcSolveIssueCode;
	message: string;
}

export interface DcSolution {
	ok: boolean;
	nodeVoltages: Record<number, number>;
	sourceCurrents: Record<string, number>;
	issue?: DcSolveIssue;
	warnings: DcSolveIssue[];
}

export interface TransientConfig {
	dt: number;
}

export interface TransientState {
	time: number;
	capacitorVoltages: Record<string, number>;
	nodeVoltages: Record<number, number>;
	relayStates: Record<string, boolean>;
}

export interface TransientResult {
	ok: boolean;
	state: TransientState;
	nodeVoltages: Record<number, number>;
	sourceCurrents: Record<string, number>;
	issue?: DcSolveIssue;
	warnings: DcSolveIssue[];
}

