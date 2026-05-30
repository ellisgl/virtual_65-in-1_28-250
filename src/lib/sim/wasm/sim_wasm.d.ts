/* tslint:disable */
/* eslint-disable */

export class Diode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Plain Shockley diode with no Zener breakdown.
     */
    static shockley(is: number, n: number): Diode;
    /**
     * Zener diode with reverse breakdown at `bv` volts.  `ibv` defaults to
     * 1e-3 A in the model if not supplied (pass `None` from JS).
     */
    static zener(is: number, n: number, bv: number, ibv?: number | null): Diode;
}

export class DiodeStamp {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly gd: number;
    readonly ieq: number;
}

export class Simulator {
    free(): void;
    [Symbol.dispose](): void;
    add_capacitor(id: string, a: number, b: number, capacitance_farads: number, initial_voltage: number): void;
    /**
     * Add a mutual-inductance coupling element binding all inductors
     * carrying the matching `coupling_group` string.  `k` is the coupling
     * coefficient (0..1).  Mutual inductance for each pair (i, j) of
     * inductors in the group is `M = k · sqrt(Li · Lj) · si · sj`.
     */
    add_coupling(id: string, coupling_group: string, k: number): void;
    add_diode(id: string, anode: number, cathode: number, diode: Diode): void;
    /**
     * Add an inductor.  Optional `coupling_group` + `coupling_polarity`
     * link this winding into a mutual-inductance group with strength `k`
     * supplied by an `add_coupling()` element using the same group.
     * Pass `None`/`1` for stand-alone inductors.
     */
    add_inductor(id: string, a: number, b: number, inductance_henry: number, saturation_current_a?: number | null, coupling_group?: string | null, coupling_polarity?: number | null): void;
    /**
     * Add an SPDT relay.  All five terminals are topology node IDs.  The
     * coil sits between `coil_positive` and `coil_negative`; the contact
     * connects `common` to either `normally_closed` (rest state) or
     * `normally_open` (energised state) with low resistance `ron_ohms`,
     * while the inactive throw is connected with high resistance
     * `roff_ohms`.  State transitions use coil-current hysteresis: relay
     * activates when `|I_coil| > on_current`, releases when
     * `|I_coil| < off_current`.  Pass `off_current < on_current` for
     * proper Schmitt-trigger behaviour.
     */
    add_relay(id: string, coil_positive: number, coil_negative: number, common: number, normally_closed: number, normally_open: number, coil_resistance_ohms: number, ron_ohms: number, roff_ohms: number, on_current: number, off_current: number): void;
    add_resistor(id: string, a: number, b: number, resistance_ohms: number): void;
    add_transistor(id: string, base: number, collector: number, emitter: number, q: Transistor): void;
    add_voltage_source(id: string, positive_node: number, negative_node: number, voltage: number): void;
    /**
     * Build the compiled netlist + transient state.  Must be called after
     * the last `add_*` and before the first `step()`.  Returns `true` on
     * success; `false` if the netlist has no non-ground nodes (empty
     * circuit).
     */
    compile(): boolean;
    /**
     * Snapshot of per-capacitor voltages.
     */
    export_cap_volts(): Float64Array;
    /**
     * Snapshot of Gear-2 readiness (true once a step has been committed).
     */
    export_gear2_ready(): boolean;
    /**
     * Snapshot of per-inductor branch currents.
     */
    export_inductor_currents(): Float64Array;
    /**
     * Snapshot of `node_volts` (current MNA unknowns).
     */
    export_node_volts(): Float64Array;
    /**
     * Snapshot of per-capacitor voltages from two steps ago (Gear-2).
     */
    export_prev_cap_volts(): Float64Array;
    /**
     * Snapshot of the previous step's dt (used to scale the predictor).
     */
    export_prev_dt(): number;
    /**
     * Snapshot of per-inductor currents from two steps ago (Gear-2).
     */
    export_prev_inductor_currents(): Float64Array;
    /**
     * Snapshot of `prev_node_volts` (predictor history).
     */
    export_prev_node_volts(): Float64Array;
    /**
     * Snapshot of relay active flags (`true` = energised).  Returned as
     * `Vec<u8>` since `Vec<bool>` isn't natively exposable through
     * rust-e-sim-wasm-bindgen; 0/1 encoding.
     */
    export_relay_active(): Uint8Array;
    /**
     * Snapshot of BJT junction-cap voltages (layout: `[Q0_Vbe, Q0_Vbc, Q1_Vbe, …]`).
     */
    export_tj_cap_volts(): Float64Array;
    /**
     * Export the entire simulator state (netlist + current voltages/currents)
     * as a single JS object.
     */
    get_full_state(): any;
    import_cap_volts(v: Float64Array): void;
    import_gear2_ready(ready: boolean): void;
    import_inductor_currents(v: Float64Array): void;
    /**
     * Restore `node_volts`.  Silently ignored on length mismatch.
     */
    import_node_volts(v: Float64Array): void;
    import_prev_cap_volts(v: Float64Array): void;
    import_prev_dt(dt: number): void;
    import_prev_inductor_currents(v: Float64Array): void;
    import_prev_node_volts(v: Float64Array): void;
    import_relay_active(v: Uint8Array): void;
    import_tj_cap_volts(v: Float64Array): void;
    /**
     * Per-inductor branch current by component id.  Returns 0.0 if the
     * component is unknown or the simulator hasn't been compiled/stepped.
     *
     * Sign convention: positive current flows from terminal `a` to terminal
     * `b` (the order passed to `add_inductor`).  For an audio speaker
     * modelled as `Rvc + Lvc` in series, this is the actual *cone-driving*
     * current — proportional to acoustic output force (F = B·L·I).  Often
     * a better audio probe than the voltage across the speaker terminals,
     * which mixes resistive drop and inductive EMF.
     */
    inductor_current(id: string): number;
    /**
     * Create an empty simulator with `ground_node_id` as the reference.
     */
    constructor(ground_node_id: number);
    /**
     * Voltage at a topology node ID — 0.0 if the node is grounded or
     * hasn't been mentioned by any element.  Returns 0.0 if compile()
     * has not been called yet.
     */
    node_voltage(node_id: number): number;
    /**
     * Import a previously exported simulator state.  Invalidates the current
     * compilation, so `compile()` must be called before the next step.
     */
    set_full_state(val: any): void;
    /**
     * Solve for the DC operating point and write the result into the
     * transient state.  Caps are treated as open, inductors as shorts.
     * Must be called after `compile()` and before the first `step()` if
     * you want the simulator to start at a nontrivial steady state — e.g.
     * any circuit with BJTs needs this to converge.  Returns `true` on
     * success.
     *
     * On the first transient step after `solve_dc()`, the simulator
     * uses backward Euler regardless of the gear flag (matches TS).
     */
    solve_dc(): boolean;
    /**
     * Advance the simulation by `dt` seconds (backward Euler).
     */
    step(dt: number): StepResult;
    /**
     * Advance with explicit gear selection: 1 = backward Euler, 2 = BDF-2
     * (falls back to BE on the first step after compile/DC).
     */
    step_with_gear(dt: number, gear: number): StepResult;
    /**
     * Audio-hot-path step variant that returns a packed `u32` instead of
     * a wasm-bindgen-managed `StepResult` struct.
     *
     * Why this exists: every `step_with_gear` call returning `StepResult`
     * costs ~5 JS↔WASM boundary crossings (the call itself, the wasm
     * alloc for the struct, the JS wrapper construction, getter calls
     * for `.ok`/`.iters`/`.issue`, and the final `.free()` to release
     * the wasm allocation).  At ~1-3 µs per crossing in Chrome, that's
     * 10-15 µs of pure overhead per step before any actual sim work.
     *
     * In the AudioWorklet this is called ~128-256 times per quantum
     * (2.67 ms of audio).  The overhead alone consumes most of the
     * quantum budget — causing the worklet to fall behind realtime and
     * Chrome to drop quanta (the user hears silence even though the
     * simulator output is correct).
     *
     * Encoding of the returned `u32` (little-endian bit layout):
     * ```text
     *   bit 0       : ok    (1 = success, 0 = failure)
     *   bits 1..=7  : issue (0 = ok, 1 = singular, 2 = no-converge, 3 = bad-dt)
     *   bits 8..=31 : iters (24-bit Newton iteration count, plenty)
     * ```
     *
     * JS unpacking:
     * ```js
     * const r = sim.step_with_gear_packed(dt, 2);
     * const ok    = (r & 1) !== 0;
     * const issue = (r >> 1) & 0x7f;
     * const iters = r >>> 8;
     * ```
     *
     * One wasm call, one number, no alloc, no `.free()`.  Functionally
     * identical to `step_with_gear` — uses the exact same Rust step
     * kernel underneath; only the return-value plumbing differs.
     */
    step_with_gear_packed(dt: number, gear: number): number;
    /**
     * Update the resistance of an existing resistor.  This is a low-latency
     * operation that avoids full netlist reconstruction.
     */
    update_resistor(id: string, resistance_ohms: number): boolean;
    /**
     * Update the voltage of an existing voltage source.
     */
    update_voltage_source(id: string, voltage: number): boolean;
    /**
     * Voltage-source branch current by component id.  Returns 0.0 if the
     * component is unknown or the simulator hasn't been compiled/stepped.
     *
     * Sign convention (matches TS `sourceCurrents` exactly): the value is
     * the MNA augmented unknown, where a positive current flows from the
     * EXTERNAL circuit INTO the + terminal of the source — i.e. the
     * source is in *sink* mode.  A battery driving a load is in *source*
     * mode, so its branch current is **negative** with magnitude equal
     * to the load current.  Callers that want a user-friendly "supply
     * current" should negate the value at the call site.
     */
    voltage_source_current(id: string): number;
    /**
     * Total node count after compile (0 if not yet compiled).
     */
    readonly node_count: number;
}

/**
 * Opaque handle to a precomputed sparse LU pattern.
 *
 * JS receives a number-typed handle that it threads back into
 * `numeric_factor` and `sparse_solve_in_place`.  The pattern data itself
 * lives in rust-e-sim-wasm linear memory and is never serialized across the boundary.
 */
export class SparseLuPattern {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Matrix dimension this pattern was built for.
     */
    readonly n: number;
}

/**
 * Outcome of a `step()` call, marshalled across the rust-e-sim-wasm boundary as a
 * small enum.  JS gets back either an iteration count (success) or a
 * negative error code.
 */
export class StepResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * On failure: 1 = singular matrix, 2 = Newton did not converge, 3 = bad dt.
     * On success: 0.
     */
    issue: number;
    /**
     * On success: Newton iteration count.  On failure: 0.
     */
    iters: number;
    /**
     * Estimated Local Truncation Error (LTE).
     */
    lte: number;
    ok: boolean;
}

export class Transistor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Construct a Gummel-Poon BJT.  All optional SPICE parameters can be
     * `undefined` on the JS side; defaults are applied inside the stamp
     * function to match the TS reference exactly.
     *
     * `polarity_npn` is a boolean instead of a string because rust-e-sim-wasm-bindgen
     * doesn't transparently marshal string enums.  JS adapter translates
     * `polarity === 'npn'` → `true`, `'pnp'` → `false`.
     */
    constructor(polarity_npn: boolean, beta: number, is_sat: number, nf: number, vaf: number, cje_farads: number, cjc_farads: number, br?: number | null, nr?: number | null, var_?: number | null, ikf?: number | null, ikr?: number | null, ise?: number | null, ne?: number | null, isc?: number | null, nc?: number | null, tf_seconds?: number | null, tr_seconds?: number | null);
}

export class TransistorStamp {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly gBc: number;
    readonly gBe: number;
    readonly gm: number;
    readonly gmu: number;
    readonly gmu_b: number;
    readonly gpi: number;
    readonly iEqB: number;
    readonly iEqC: number;
    readonly iEqE: number;
}

/**
 * Build a `SparseLuPattern` from a boolean occupancy marker.
 *
 * `marker` must be of length `n*n`.  `marker[i*n+j] != 0` means position
 * `(i,j)` may carry a non-zero value during factorization.
 */
export function analyzePattern(marker: Uint8Array, n: number): SparseLuPattern;

/**
 * Compute the diode stamp for the current Newton iterate.
 *
 * `prev_volts` is `Option<Vec<f64>>` (JS `Float64Array | undefined`).  When
 * supplied, the SPICE pnjlim limiter engages on large junction-voltage
 * swings — required for transient mode, omitted in DC operating-point.
 */
export function computeDiodeStamp(diode: Diode, volts: Float64Array, ai: number, ki: number, prev_volts?: Float64Array | null): DiodeStamp;

/**
 * Compute the transistor stamp for the current Newton iterate.
 */
export function computeTransistorStamp(q: Transistor, volts: Float64Array, bi: number, ci: number, ei: number, prev_volts?: Float64Array | null): TransistorStamp;

/**
 * Greedy Minimum Degree elimination ordering.
 *
 * `flat_edges` is `[i0, j0, i1, j1, …]` — pairs of node indices forming
 * edges.  Self-loops and out-of-range indices are filtered.
 *
 * Returns the elimination order: `order[k] = i` means "eliminate row i at
 * step k".
 */
export function minimumDegreeOrder(n: number, flat_edges: Int32Array): Int32Array;

/**
 * Numeric LU factorization in place using a precomputed symbolic pattern.
 *
 * `mat` must be of length `n*n` (row-major).  On return the lower triangle
 * stores L (unit diagonal not written) and the upper triangle + diagonal
 * store U.  Returns `false` if a pivot fell below the numerical threshold.
 */
export function numericFactor(mat: Float64Array, n: number, pat: SparseLuPattern): boolean;

/**
 * Solve `(L * U) * x = rhs` using a matrix already factored by
 * `numeric_factor`.  The solution overwrites `rhs` on return.
 */
export function sparseSolveInPlace(mat: Float64Array, rhs: Float64Array, n: number, pat: SparseLuPattern): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_diode_free: (a: number, b: number) => void;
    readonly __wbg_diodestamp_free: (a: number, b: number) => void;
    readonly __wbg_get_stepresult_issue: (a: number) => number;
    readonly __wbg_get_stepresult_iters: (a: number) => number;
    readonly __wbg_get_stepresult_lte: (a: number) => number;
    readonly __wbg_get_stepresult_ok: (a: number) => number;
    readonly __wbg_set_stepresult_issue: (a: number, b: number) => void;
    readonly __wbg_set_stepresult_iters: (a: number, b: number) => void;
    readonly __wbg_set_stepresult_lte: (a: number, b: number) => void;
    readonly __wbg_set_stepresult_ok: (a: number, b: number) => void;
    readonly __wbg_simulator_free: (a: number, b: number) => void;
    readonly __wbg_sparselupattern_free: (a: number, b: number) => void;
    readonly __wbg_stepresult_free: (a: number, b: number) => void;
    readonly __wbg_transistor_free: (a: number, b: number) => void;
    readonly __wbg_transistorstamp_free: (a: number, b: number) => void;
    readonly analyzePattern: (a: number, b: number, c: number) => number;
    readonly computeDiodeStamp: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly computeTransistorStamp: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly diode_shockley: (a: number, b: number) => number;
    readonly diode_zener: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly diodestamp_gd: (a: number) => number;
    readonly diodestamp_ieq: (a: number) => number;
    readonly minimumDegreeOrder: (a: number, b: number, c: number) => [number, number];
    readonly numericFactor: (a: number, b: number, c: any, d: number, e: number) => number;
    readonly simulator_add_capacitor: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly simulator_add_coupling: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly simulator_add_diode: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly simulator_add_inductor: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly simulator_add_relay: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => void;
    readonly simulator_add_resistor: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly simulator_add_transistor: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly simulator_add_voltage_source: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly simulator_compile: (a: number) => number;
    readonly simulator_export_cap_volts: (a: number) => [number, number];
    readonly simulator_export_gear2_ready: (a: number) => number;
    readonly simulator_export_inductor_currents: (a: number) => [number, number];
    readonly simulator_export_node_volts: (a: number) => [number, number];
    readonly simulator_export_prev_cap_volts: (a: number) => [number, number];
    readonly simulator_export_prev_dt: (a: number) => number;
    readonly simulator_export_prev_inductor_currents: (a: number) => [number, number];
    readonly simulator_export_prev_node_volts: (a: number) => [number, number];
    readonly simulator_export_relay_active: (a: number) => [number, number];
    readonly simulator_export_tj_cap_volts: (a: number) => [number, number];
    readonly simulator_get_full_state: (a: number) => [number, number, number];
    readonly simulator_import_cap_volts: (a: number, b: number, c: number) => void;
    readonly simulator_import_gear2_ready: (a: number, b: number) => void;
    readonly simulator_import_inductor_currents: (a: number, b: number, c: number) => void;
    readonly simulator_import_node_volts: (a: number, b: number, c: number) => void;
    readonly simulator_import_prev_cap_volts: (a: number, b: number, c: number) => void;
    readonly simulator_import_prev_dt: (a: number, b: number) => void;
    readonly simulator_import_prev_inductor_currents: (a: number, b: number, c: number) => void;
    readonly simulator_import_prev_node_volts: (a: number, b: number, c: number) => void;
    readonly simulator_import_relay_active: (a: number, b: number, c: number) => void;
    readonly simulator_import_tj_cap_volts: (a: number, b: number, c: number) => void;
    readonly simulator_inductor_current: (a: number, b: number, c: number) => number;
    readonly simulator_new: (a: number) => number;
    readonly simulator_node_count: (a: number) => number;
    readonly simulator_node_voltage: (a: number, b: number) => number;
    readonly simulator_set_full_state: (a: number, b: any) => [number, number];
    readonly simulator_solve_dc: (a: number) => number;
    readonly simulator_step: (a: number, b: number) => number;
    readonly simulator_step_with_gear: (a: number, b: number, c: number) => number;
    readonly simulator_step_with_gear_packed: (a: number, b: number, c: number) => number;
    readonly simulator_update_resistor: (a: number, b: number, c: number, d: number) => number;
    readonly simulator_update_voltage_source: (a: number, b: number, c: number, d: number) => number;
    readonly simulator_voltage_source_current: (a: number, b: number, c: number) => number;
    readonly sparseSolveInPlace: (a: number, b: number, c: number, d: number, e: any, f: number, g: number) => void;
    readonly sparselupattern_n: (a: number) => number;
    readonly transistor_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number, z: number, a1: number, b1: number, c1: number) => number;
    readonly transistorstamp_gm: (a: number) => number;
    readonly transistorstamp_gmu: (a: number) => number;
    readonly transistorstamp_gmu_b: (a: number) => number;
    readonly transistorstamp_gpi: (a: number) => number;
    readonly transistorstamp_iEqB: (a: number) => number;
    readonly transistorstamp_iEqC: (a: number) => number;
    readonly transistorstamp_iEqE: (a: number) => number;
    readonly transistorstamp_gBc: (a: number) => number;
    readonly transistorstamp_gBe: (a: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
