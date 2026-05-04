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
	/** Forward beta (= bf in SPICE Gummel-Poon). */
	beta: number;
	/** Reverse beta (br). Default 1 if not specified. */
	br?: number;
	/** Saturation current (is). */
	is: number;
	/** Forward emission coefficient (nf). */
	nf: number;
	/** Reverse emission coefficient (nr). Default 1. */
	nr?: number;
	/** Forward Early voltage (vaf). */
	vaf: number;
	/** Reverse Early voltage (var). Default 100. */
	var?: number;
	/** Forward knee current — high-injection rolloff (ikf). */
	ikf?: number;
	/** Reverse knee current (ikr). */
	ikr?: number;
	/** B-E leakage saturation current (ise). */
	ise?: number;
	/** B-E leakage emission coefficient (ne). Default 1.5. */
	ne?: number;
	/** B-C leakage saturation current (isc). */
	isc?: number;
	/** B-C leakage emission coefficient (nc). Default 2. */
	nc?: number;
	/** B-E zero-bias junction capacitance (cje). */
	cjeFarads: number;
	/** B-C zero-bias junction capacitance (cjc). */
	cjcFarads: number;
	/** Forward transit time (tf), models diffusion capacitance. */
	tfSeconds?: number;
	/** Reverse transit time (tr). */
	trSeconds?: number;
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

export interface SimulationTransformerElement {
	type: 'transformer';
	componentId: string;
	primaryNodeA: number;
	primaryNodeB: number;
	secondaryNodeA: number;
	secondaryNodeB: number;
	turnsRatio: number;
}

export interface SimulationInductorElement {
	type: 'inductor';
	componentId: string;
	nodes: [number, number];
	inductanceHenry: number;
	saturationCurrentA?: number; // optional: when |i| exceeds this, L collapses (models core saturation)
	/** Magnetic coupling group ID. All inductors with the same group share a core. */
	couplingGroup?: string;
	/** Polarity of this winding within the coupling group: +1 or -1.
	 *  Determines the sign of the mutual inductance term against other windings
	 *  in the same group. Both windings of a transformer half-primary use +1
	 *  (additive flux when wired toward center tap); reversed windings use -1. */
	couplingPolarity?: 1 | -1;
}

/**
 * Magnetic coupling between inductors that share a core.
 * The mutual inductance is M_ij = k * sqrt(L_i * L_j), where k is the coupling
 * coefficient (0 = no coupling, 1 = ideal transformer). Real iron-core audio
 * transformers like the LT700 have k ≈ 0.99.
 *
 * In branch-current MNA, mutual inductance adds off-diagonal terms to the
 * inductor branch rows: V_i = L_ii * dI_i/dt + Σ_{j≠i} M_ij * dI_j/dt.
 */
export interface SimulationCouplingElement {
	type: 'coupling';
	componentId: string;
	/** Coupling group ID - matches couplingGroup on each inductor */
	couplingGroup: string;
	/** Coupling coefficient k (0 < k <= 1) */
	k: number;
}

export type SimulationElement =
	| SimulationResistorElement
	| SimulationVoltageSourceElement
	| SimulationCapacitorElement
	| SimulationInductorElement
	| SimulationTransistorElement
	| SimulationRelayElement
	| SimulationTransformerElement
	| SimulationCouplingElement;

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


/**
 * Pre-computed, netlist-static data. Build once with compileNetlist(),
 * reuse across every stepTransientNetlist() call to avoid per-step allocation.
 */
export interface CompiledNetlist {
	groundedElements: SimulationElement[];
	nonGroundNodes: number[];
	voltageSources: SimulationVoltageSourceElement[];
	transformerElements: SimulationTransformerElement[];
	inductorElements: SimulationInductorElement[];
	transistorElements: SimulationTransistorElement[];
	nodeIndex: Map<number, number>;
	n: number;  // non-ground node count
	m: number;  // voltage source count
	t: number;  // transformer count
	size: number; // total MNA matrix dimension
	// Pre-allocated scratch buffers — zero before each use
	matrix: Float64Array;  // flat row-major, size×size
	rhs: Float64Array;     // size
	scratch: Float64Array; // size*size + size — for the linear solver copy
	/** Precomputed static stamp entries for resistors/fixed-conductances.
	 *  Packed as triples: [row0, col0, val0, row1, col1, val1, ...]
	 *  Applied every Newton iteration with a tight loop — no Map lookups. */
	staticStamps: Float64Array;
	/** gmin diagonal entries: [idx0, idx1, ...] for nonGroundNodes */
	gminIndices: Int32Array;
	/** Capacitor elements with precomputed matrix indices for zero-lookup stamping. */
	capElements: SimulationCapacitorElement[];
	capStampIndices: Int32Array;
	/** Inductor branch-row index per inductor (one entry per element in inductorElements). */
	inductorBranchRows: Int32Array;
	/** Compact node indices [iaIdx, ibIdx] per inductor, -1 if grounded. */
	inductorNodeIndices: Int32Array;
	/** Mutual inductance pairs as flat triples [i, j, M_signed, ...].
	 *  M_signed = k * sqrt(L_i*L_j) * polarity_i * polarity_j.
	 *  Each unordered pair appears twice so the matrix is stamped symmetrically. */
	inductorCouplingPairs: Float64Array;
}

export interface TransientConfig {
	dt: number;
	/** GEAR integration order: 1 = backward Euler, 2 = BDF-2/GEAR-2. Default 1. */
	gear?: 1 | 2;
}

export interface TransientState {
	time: number;
	capacitorVoltages: Record<string, number>;
	nodeVoltages: Record<number, number>;
	relayStates: Record<string, boolean>;
	/** Previous-step capacitor voltages, needed for GEAR-2 companion model. */
	prevCapacitorVoltages?: Record<string, number>;
	/** Previous-step inductor currents (stored in capacitorVoltages map under ':i' key). */
	prevInductorCurrents?: Record<string, number>;
	/** Previous-step node voltages for GEAR-2. */
	prevNodeVoltages?: Record<number, number>;
	/** Whether GEAR-2 history is ready (requires at least one completed step). */
	gear2Ready?: boolean;
}

export interface TransientResult {
	ok: boolean;
	state: TransientState;
	nodeVoltages: Record<number, number>;
	sourceCurrents: Record<string, number>;
	issue?: DcSolveIssue;
	warnings: DcSolveIssue[];
	/** Recommended next timestep based on LTE estimate (adaptive stepping). */
	recommendedDt?: number;
	/** Estimated max local truncation error relative to tolerance. */
	lteRatio?: number;
}

