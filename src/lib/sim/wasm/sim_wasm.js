/* @ts-self-types="./sim_wasm.d.ts" */

export class Diode {
    static __wrap(ptr) {
        const obj = Object.create(Diode.prototype);
        obj.__wbg_ptr = ptr;
        DiodeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DiodeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_diode_free(ptr, 0);
    }
    /**
     * Plain Shockley diode with no Zener breakdown.
     * @param {number} is
     * @param {number} n
     * @returns {Diode}
     */
    static shockley(is, n) {
        const ret = wasm.diode_shockley(is, n);
        return Diode.__wrap(ret);
    }
    /**
     * Zener diode with reverse breakdown at `bv` volts.  `ibv` defaults to
     * 1e-3 A in the model if not supplied (pass `None` from JS).
     * @param {number} is
     * @param {number} n
     * @param {number} bv
     * @param {number | null} [ibv]
     * @returns {Diode}
     */
    static zener(is, n, bv, ibv) {
        const ret = wasm.diode_zener(is, n, bv, !isLikeNone(ibv), isLikeNone(ibv) ? 0 : ibv);
        return Diode.__wrap(ret);
    }
}
if (Symbol.dispose) Diode.prototype[Symbol.dispose] = Diode.prototype.free;

export class DiodeStamp {
    static __wrap(ptr) {
        const obj = Object.create(DiodeStamp.prototype);
        obj.__wbg_ptr = ptr;
        DiodeStampFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DiodeStampFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_diodestamp_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get gd() {
        const ret = wasm.diodestamp_gd(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get ieq() {
        const ret = wasm.diodestamp_ieq(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) DiodeStamp.prototype[Symbol.dispose] = DiodeStamp.prototype.free;

export class Simulator {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SimulatorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_simulator_free(ptr, 0);
    }
    /**
     * @param {string} id
     * @param {number} a
     * @param {number} b
     * @param {number} capacitance_farads
     * @param {number} initial_voltage
     */
    add_capacitor(id, a, b, capacitance_farads, initial_voltage) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.simulator_add_capacitor(this.__wbg_ptr, ptr0, len0, a, b, capacitance_farads, initial_voltage);
    }
    /**
     * Add a mutual-inductance coupling element binding all inductors
     * carrying the matching `coupling_group` string.  `k` is the coupling
     * coefficient (0..1).  Mutual inductance for each pair (i, j) of
     * inductors in the group is `M = k · sqrt(Li · Lj) · si · sj`.
     * @param {string} id
     * @param {string} coupling_group
     * @param {number} k
     */
    add_coupling(id, coupling_group, k) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(coupling_group, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.simulator_add_coupling(this.__wbg_ptr, ptr0, len0, ptr1, len1, k);
    }
    /**
     * @param {string} id
     * @param {number} anode
     * @param {number} cathode
     * @param {Diode} diode
     */
    add_diode(id, anode, cathode, diode) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(diode, Diode);
        wasm.simulator_add_diode(this.__wbg_ptr, ptr0, len0, anode, cathode, diode.__wbg_ptr);
    }
    /**
     * Add an inductor.  Optional `coupling_group` + `coupling_polarity`
     * link this winding into a mutual-inductance group with strength `k`
     * supplied by an `add_coupling()` element using the same group.
     * Pass `None`/`1` for stand-alone inductors.
     * @param {string} id
     * @param {number} a
     * @param {number} b
     * @param {number} inductance_henry
     * @param {number | null} [saturation_current_a]
     * @param {string | null} [coupling_group]
     * @param {number | null} [coupling_polarity]
     */
    add_inductor(id, a, b, inductance_henry, saturation_current_a, coupling_group, coupling_polarity) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(coupling_group) ? 0 : passStringToWasm0(coupling_group, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        wasm.simulator_add_inductor(this.__wbg_ptr, ptr0, len0, a, b, inductance_henry, !isLikeNone(saturation_current_a), isLikeNone(saturation_current_a) ? 0 : saturation_current_a, ptr1, len1, isLikeNone(coupling_polarity) ? Number.MAX_SAFE_INTEGER : (coupling_polarity) >> 0);
    }
    /**
     * @param {string} id
     * @param {number} a
     * @param {number} b
     * @param {number} resistance_ohms
     */
    add_resistor(id, a, b, resistance_ohms) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.simulator_add_resistor(this.__wbg_ptr, ptr0, len0, a, b, resistance_ohms);
    }
    /**
     * @param {string} id
     * @param {number} base
     * @param {number} collector
     * @param {number} emitter
     * @param {Transistor} q
     */
    add_transistor(id, base, collector, emitter, q) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        _assertClass(q, Transistor);
        wasm.simulator_add_transistor(this.__wbg_ptr, ptr0, len0, base, collector, emitter, q.__wbg_ptr);
    }
    /**
     * @param {string} id
     * @param {number} positive_node
     * @param {number} negative_node
     * @param {number} voltage
     */
    add_voltage_source(id, positive_node, negative_node, voltage) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.simulator_add_voltage_source(this.__wbg_ptr, ptr0, len0, positive_node, negative_node, voltage);
    }
    /**
     * Build the compiled netlist + transient state.  Must be called after
     * the last `add_*` and before the first `step()`.  Returns `true` on
     * success; `false` if the netlist has no non-ground nodes (empty
     * circuit).
     * @returns {boolean}
     */
    compile() {
        const ret = wasm.simulator_compile(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Create an empty simulator with `ground_node_id` as the reference.
     * @param {number} ground_node_id
     */
    constructor(ground_node_id) {
        const ret = wasm.simulator_new(ground_node_id);
        this.__wbg_ptr = ret;
        SimulatorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Total node count after compile (0 if not yet compiled).
     * @returns {number}
     */
    get node_count() {
        const ret = wasm.simulator_node_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Voltage at a topology node ID — 0.0 if the node is grounded or
     * hasn't been mentioned by any element.  Returns 0.0 if compile()
     * has not been called yet.
     * @param {number} node_id
     * @returns {number}
     */
    node_voltage(node_id) {
        const ret = wasm.simulator_node_voltage(this.__wbg_ptr, node_id);
        return ret;
    }
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
     * @returns {boolean}
     */
    solve_dc() {
        const ret = wasm.simulator_solve_dc(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Advance the simulation by `dt` seconds (backward Euler).
     * @param {number} dt
     * @returns {StepResult}
     */
    step(dt) {
        const ret = wasm.simulator_step(this.__wbg_ptr, dt);
        return StepResult.__wrap(ret);
    }
    /**
     * Advance with explicit gear selection: 1 = backward Euler, 2 = BDF-2
     * (falls back to BE on the first step after compile/DC).
     * @param {number} dt
     * @param {number} gear
     * @returns {StepResult}
     */
    step_with_gear(dt, gear) {
        const ret = wasm.simulator_step_with_gear(this.__wbg_ptr, dt, gear);
        return StepResult.__wrap(ret);
    }
}
if (Symbol.dispose) Simulator.prototype[Symbol.dispose] = Simulator.prototype.free;

/**
 * Opaque handle to a precomputed sparse LU pattern.
 *
 * JS receives a number-typed handle that it threads back into
 * `numeric_factor` and `sparse_solve_in_place`.  The pattern data itself
 * lives in wasm linear memory and is never serialized across the boundary.
 */
export class SparseLuPattern {
    static __wrap(ptr) {
        const obj = Object.create(SparseLuPattern.prototype);
        obj.__wbg_ptr = ptr;
        SparseLuPatternFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SparseLuPatternFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sparselupattern_free(ptr, 0);
    }
    /**
     * Matrix dimension this pattern was built for.
     * @returns {number}
     */
    get n() {
        const ret = wasm.sparselupattern_n(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) SparseLuPattern.prototype[Symbol.dispose] = SparseLuPattern.prototype.free;

/**
 * Outcome of a `step()` call, marshalled across the wasm boundary as a
 * small enum.  JS gets back either an iteration count (success) or a
 * negative error code.
 */
export class StepResult {
    static __wrap(ptr) {
        const obj = Object.create(StepResult.prototype);
        obj.__wbg_ptr = ptr;
        StepResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        StepResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_stepresult_free(ptr, 0);
    }
    /**
     * On failure: 1 = singular matrix, 2 = Newton did not converge, 3 = bad dt.
     * On success: 0.
     * @returns {number}
     */
    get issue() {
        const ret = wasm.__wbg_get_stepresult_issue(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * On success: Newton iteration count.  On failure: 0.
     * @returns {number}
     */
    get iters() {
        const ret = wasm.__wbg_get_stepresult_iters(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {boolean}
     */
    get ok() {
        const ret = wasm.__wbg_get_stepresult_ok(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * On failure: 1 = singular matrix, 2 = Newton did not converge, 3 = bad dt.
     * On success: 0.
     * @param {number} arg0
     */
    set issue(arg0) {
        wasm.__wbg_set_stepresult_issue(this.__wbg_ptr, arg0);
    }
    /**
     * On success: Newton iteration count.  On failure: 0.
     * @param {number} arg0
     */
    set iters(arg0) {
        wasm.__wbg_set_stepresult_iters(this.__wbg_ptr, arg0);
    }
    /**
     * @param {boolean} arg0
     */
    set ok(arg0) {
        wasm.__wbg_set_stepresult_ok(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) StepResult.prototype[Symbol.dispose] = StepResult.prototype.free;

export class Transistor {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TransistorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_transistor_free(ptr, 0);
    }
    /**
     * Construct a Gummel-Poon BJT.  All optional SPICE parameters can be
     * `undefined` on the JS side; defaults are applied inside the stamp
     * function to match the TS reference exactly.
     *
     * `polarity_npn` is a boolean instead of a string because wasm-bindgen
     * doesn't transparently marshal string enums.  JS adapter translates
     * `polarity === 'npn'` → `true`, `'pnp'` → `false`.
     * @param {boolean} polarity_npn
     * @param {number} beta
     * @param {number} is_sat
     * @param {number} nf
     * @param {number} vaf
     * @param {number} cje_farads
     * @param {number} cjc_farads
     * @param {number | null} [br]
     * @param {number | null} [nr]
     * @param {number | null} [var_]
     * @param {number | null} [ikf]
     * @param {number | null} [ikr]
     * @param {number | null} [ise]
     * @param {number | null} [ne]
     * @param {number | null} [isc]
     * @param {number | null} [nc]
     * @param {number | null} [tf_seconds]
     * @param {number | null} [tr_seconds]
     */
    constructor(polarity_npn, beta, is_sat, nf, vaf, cje_farads, cjc_farads, br, nr, var_, ikf, ikr, ise, ne, isc, nc, tf_seconds, tr_seconds) {
        const ret = wasm.transistor_new(polarity_npn, beta, is_sat, nf, vaf, cje_farads, cjc_farads, !isLikeNone(br), isLikeNone(br) ? 0 : br, !isLikeNone(nr), isLikeNone(nr) ? 0 : nr, !isLikeNone(var_), isLikeNone(var_) ? 0 : var_, !isLikeNone(ikf), isLikeNone(ikf) ? 0 : ikf, !isLikeNone(ikr), isLikeNone(ikr) ? 0 : ikr, !isLikeNone(ise), isLikeNone(ise) ? 0 : ise, !isLikeNone(ne), isLikeNone(ne) ? 0 : ne, !isLikeNone(isc), isLikeNone(isc) ? 0 : isc, !isLikeNone(nc), isLikeNone(nc) ? 0 : nc, !isLikeNone(tf_seconds), isLikeNone(tf_seconds) ? 0 : tf_seconds, !isLikeNone(tr_seconds), isLikeNone(tr_seconds) ? 0 : tr_seconds);
        this.__wbg_ptr = ret;
        TransistorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) Transistor.prototype[Symbol.dispose] = Transistor.prototype.free;

export class TransistorStamp {
    static __wrap(ptr) {
        const obj = Object.create(TransistorStamp.prototype);
        obj.__wbg_ptr = ptr;
        TransistorStampFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TransistorStampFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_transistorstamp_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get gBc() {
        const ret = wasm.transistorstamp_gBc(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get gBe() {
        const ret = wasm.transistorstamp_gBe(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get gm() {
        const ret = wasm.transistorstamp_gm(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get gmu() {
        const ret = wasm.transistorstamp_gmu(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get gmu_b() {
        const ret = wasm.transistorstamp_gmu_b(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get gpi() {
        const ret = wasm.transistorstamp_gpi(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get iEqB() {
        const ret = wasm.transistorstamp_iEqB(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get iEqC() {
        const ret = wasm.transistorstamp_iEqC(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get iEqE() {
        const ret = wasm.transistorstamp_iEqE(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) TransistorStamp.prototype[Symbol.dispose] = TransistorStamp.prototype.free;

/**
 * Build a `SparseLuPattern` from a boolean occupancy marker.
 *
 * `marker` must be of length `n*n`.  `marker[i*n+j] != 0` means position
 * `(i,j)` may carry a non-zero value during factorization.
 * @param {Uint8Array} marker
 * @param {number} n
 * @returns {SparseLuPattern}
 */
export function analyzePattern(marker, n) {
    const ptr0 = passArray8ToWasm0(marker, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.analyzePattern(ptr0, len0, n);
    return SparseLuPattern.__wrap(ret);
}

/**
 * Compute the diode stamp for the current Newton iterate.
 *
 * `prev_volts` is `Option<Vec<f64>>` (JS `Float64Array | undefined`).  When
 * supplied, the SPICE pnjlim limiter engages on large junction-voltage
 * swings — required for transient mode, omitted in DC operating-point.
 * @param {Diode} diode
 * @param {Float64Array} volts
 * @param {number} ai
 * @param {number} ki
 * @param {Float64Array | null} [prev_volts]
 * @returns {DiodeStamp}
 */
export function computeDiodeStamp(diode, volts, ai, ki, prev_volts) {
    _assertClass(diode, Diode);
    const ptr0 = passArrayF64ToWasm0(volts, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(prev_volts) ? 0 : passArrayF64ToWasm0(prev_volts, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.computeDiodeStamp(diode.__wbg_ptr, ptr0, len0, ai, ki, ptr1, len1);
    return DiodeStamp.__wrap(ret);
}

/**
 * Compute the transistor stamp for the current Newton iterate.
 * @param {Transistor} q
 * @param {Float64Array} volts
 * @param {number} bi
 * @param {number} ci
 * @param {number} ei
 * @param {Float64Array | null} [prev_volts]
 * @returns {TransistorStamp}
 */
export function computeTransistorStamp(q, volts, bi, ci, ei, prev_volts) {
    _assertClass(q, Transistor);
    const ptr0 = passArrayF64ToWasm0(volts, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(prev_volts) ? 0 : passArrayF64ToWasm0(prev_volts, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.computeTransistorStamp(q.__wbg_ptr, ptr0, len0, bi, ci, ei, ptr1, len1);
    return TransistorStamp.__wrap(ret);
}

/**
 * Greedy Minimum Degree elimination ordering.
 *
 * `flat_edges` is `[i0, j0, i1, j1, …]` — pairs of node indices forming
 * edges.  Self-loops and out-of-range indices are filtered.
 *
 * Returns the elimination order: `order[k] = i` means "eliminate row i at
 * step k".
 * @param {number} n
 * @param {Int32Array} flat_edges
 * @returns {Int32Array}
 */
export function minimumDegreeOrder(n, flat_edges) {
    const ptr0 = passArray32ToWasm0(flat_edges, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.minimumDegreeOrder(n, ptr0, len0);
    var v2 = getArrayI32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Numeric LU factorization in place using a precomputed symbolic pattern.
 *
 * `mat` must be of length `n*n` (row-major).  On return the lower triangle
 * stores L (unit diagonal not written) and the upper triangle + diagonal
 * store U.  Returns `false` if a pivot fell below the numerical threshold.
 * @param {Float64Array} mat
 * @param {number} n
 * @param {SparseLuPattern} pat
 * @returns {boolean}
 */
export function numericFactor(mat, n, pat) {
    var ptr0 = passArrayF64ToWasm0(mat, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    _assertClass(pat, SparseLuPattern);
    const ret = wasm.numericFactor(ptr0, len0, mat, n, pat.__wbg_ptr);
    return ret !== 0;
}

/**
 * Smoke-test export — verifies the JS-WASM round-trip works.
 * Returns the input + 1.0.  Will be removed once the real API is in use.
 * @param {number} x
 * @returns {number}
 */
export function ping(x) {
    const ret = wasm.ping(x);
    return ret;
}

/**
 * Solve `(L * U) * x = rhs` using a matrix already factored by
 * `numeric_factor`.  The solution overwrites `rhs` on return.
 * @param {Float64Array} mat
 * @param {Float64Array} rhs
 * @param {number} n
 * @param {SparseLuPattern} pat
 */
export function sparseSolveInPlace(mat, rhs, n, pat) {
    const ptr0 = passArrayF64ToWasm0(mat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = passArrayF64ToWasm0(rhs, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    _assertClass(pat, SparseLuPattern);
    wasm.sparseSolveInPlace(ptr0, len0, ptr1, len1, rhs, n, pat.__wbg_ptr);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_copy_to_typed_array_787746aeb47818bc: function(arg0, arg1, arg2) {
            new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbg___wbindgen_throw_9c31b086c2b26051: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./sim_wasm_bg.js": import0,
    };
}

const DiodeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_diode_free(ptr, 1));
const DiodeStampFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_diodestamp_free(ptr, 1));
const SimulatorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_simulator_free(ptr, 1));
const SparseLuPatternFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sparselupattern_free(ptr, 1));
const StepResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_stepresult_free(ptr, 1));
const TransistorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_transistor_free(ptr, 1));
const TransistorStampFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_transistorstamp_free(ptr, 1));

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat64ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('sim_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
