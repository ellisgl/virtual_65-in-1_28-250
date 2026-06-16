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
	| 'earphone'
	| 'transformer'
	| 'lamp'
	| 'relay'
	| 'antenna'
	| 'switch'
	| 'cds'
	| 'solar-cell'
	| 'voltmeter';

export type DeviceModelType = 'diode' | 'bjt' | 'scr' | 'relay' | 'lamp' | 'earphone';

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
	lengthCm: number;
	/** Optional points for shaping the wire.
	 *  If provided, the wire will be drawn as a poly-bezier passing through or influenced by these points. */
	shapingPoints?: Array<{ x: number; y: number }>;
}

export interface DragState {
	active: boolean;
	fromTerminal: number | null;
	currentX: number;
	currentY: number;
	shapingPoints: Array<{ x: number; y: number }>;
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

export interface SimulationDiodeElement {
	type: 'diode';
	componentId: string;
	/** Junction anode. If Rs > 0 the component has an internal mid-node allocated by netlist.ts. */
	anodeNode: number;
	cathodeNode: number;
	/** Saturation current (A). */
	is: number;
	/** Emission coefficient. */
	n: number;
	/** Reverse breakdown voltage (V). Present for Zener diodes only. */
	bv?: number;
	/** Knee current at breakdown (A). Default 1 mA. */
	ibv?: number;
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
	| SimulationDiodeElement
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
 * Symbolic LU pattern computed once per compiled netlist (analyzePattern in sparse.ts).
 * Reused for every numeric factorization in the Newton loop.
 */
export interface SparseLUPattern {
    /** Matrix dimension. */
    n: number;
    /**
     * For each pivot k: Int32Array of row indices i > k where L[i,k] can be non-zero.
     * Includes fill-in discovered during symbolic analysis.
     */
    lCols: Int32Array[];
    /**
     * For each pivot k: Int32Array of column indices j > k where U[k,j] can be non-zero.
     */
    uRows: Int32Array[];
    /**
     * For each pivot k: flat [i₀,j₀, i₁,j₁, …] pairs updated by A[i,j] -= L[i,k]·U[k,j].
     * Only positions in the fill pattern are included.
     */
    rankOneUpdates: Int32Array[];
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
	/** Diode elements (Shockley model and optional Zener breakdown). Stamped per Newton iteration. */
	diodeElements: SimulationDiodeElement[];
	/**
	 * Symbolic LU pattern covering every position that any stamp (static or dynamic)
	 * can write to. Computed once in compileNetlist(); the numeric factorization uses
	 * this structure on every Newton step without rediscovering fill-in.
	 */
	sparsePattern: SparseLUPattern;
	nodeIndex: Map<number, number>;
	n: number;  // non-ground node count
	m: number;  // voltage source count
	t: number;  // transformer count
	size: number; // total MNA matrix dimension
	// Pre-allocated scratch buffers — zero before each use
	matrix: Float64Array;  // flat row-major, size×size
	rhs: Float64Array;     // size
	scratch: Float64Array; // size*size + size — for the linear solver copy
	/** Pre-allocated baseMatrix — sized once at compile, zeroed each step. */
	baseMatrix: Float64Array;  // size×size
	/** Pre-allocated baseRhs — sized once at compile, zeroed each step. */
	baseRhs: Float64Array;     // size
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
	/**
	 * Compact (nodeIndex) indices for each transistor's base, collector, emitter.
	 * Layout: [bi, ci, ei,  bi, ci, ei, …]  (-1 = grounded, voltage treated as 0).
	 * Eliminates nodeIndex.get() calls inside the Newton loop.
	 */
	transistorNodeIndices: Int32Array;
	/**
	 * Compact (nodeIndex) indices for each diode's anode and cathode.
	 * Layout: [ai, ki,  ai, ki, …]  (-1 = grounded).
	 */
	diodeNodeIndices: Int32Array;
}

export interface TransientConfig {
	dt: number;
	/** GEAR integration order: 1 = backward Euler, 2 = BDF-2/GEAR-2. Default 1. */
	gear?: 1 | 2;
}

export interface TransientState {
	/**
	 * Node voltages in compact order (index i = position of node in nonGroundNodes).
	 * Ground is not stored; its voltage is always 0.
	 */
	nodeVolts:     Float64Array;
	/** Previous-step node voltages — kept for potential LTE extension; not in hot path. */
	prevNodeVolts: Float64Array;

	/** Capacitor element voltages indexed by position in CompiledNetlist.capElements. */
	capVolts:     Float64Array;
	/** Previous-step capacitor voltages for GEAR-2 companion model. */
	prevCapVolts: Float64Array;

	/**
	 * Transistor junction capacitor voltages.
	 * Layout: [Q0_Vbe, Q0_Vbc, Q1_Vbe, Q1_Vbc, …]  (2 entries per transistor).
	 * Only backward-Euler companions are used for junction caps, so no GEAR-2 history.
	 */
	tjCapVolts: Float64Array;
	/**
	 * Back-buffer for tjCapVolts — used as the write target each step so we can
	 * ping-pong refs instead of allocating a fresh array per step.
	 */
	tjCapVoltsBack: Float64Array;

	/** Inductor branch currents indexed by position in inductorElements. */
	inductorCurrents:     Float64Array;
	/** Previous-step inductor currents for GEAR-2 companion model. */
	prevInductorCurrents: Float64Array;

	/** Relay states — rarely accessed; stays as Record to avoid added complexity. */
	relayStates: Record<string, boolean>;
	/** True once the first accepted step has completed; enables GEAR-2 on step 2+. */
	gear2Ready:   boolean;
	/**
	 * Timestep used in the previous completed step.
	 * Stored so the linear predictor can scale correctly when dt changes between steps.
	 * 0 on the very first step (disables the predictor).
	 */
	prevDt:       number;
	/**
	 * Exponentially weighted moving average of the Newton iteration count.
	 * α = 0.3, so it tracks recent behaviour without overreacting to single spikes.
	 * Used to set an adaptive ceiling on the next step's iteration budget.
	 */
	avgIterCount: number;
}

export interface TransientResult {
	ok: boolean;
	state: TransientState;
	sourceCurrents: Record<string, number>;
	issue?: DcSolveIssue;
	warnings: DcSolveIssue[];
	/** Recommended next timestep based on LTE estimate (adaptive stepping). */
	recommendedDt?: number;
	/** Estimated max local truncation error relative to tolerance. */
	lteRatio?: number;
}

