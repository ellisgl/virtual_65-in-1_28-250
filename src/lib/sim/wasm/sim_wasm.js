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
     * Add an SPDT relay.  All five terminals are topology node IDs.  The
     * coil sits between `coil_positive` and `coil_negative`; the contact
     * connects `common` to either `normally_closed` (rest state) or
     * `normally_open` (energised state) with low resistance `ron_ohms`,
     * while the inactive throw is connected with high resistance
     * `roff_ohms`.  State transitions use coil-current hysteresis: relay
     * activates when `|I_coil| > on_current`, releases when
     * `|I_coil| < off_current`.  Pass `off_current < on_current` for
     * proper Schmitt-trigger behaviour.
     * @param {string} id
     * @param {number} coil_positive
     * @param {number} coil_negative
     * @param {number} common
     * @param {number} normally_closed
     * @param {number} normally_open
     * @param {number} coil_resistance_ohms
     * @param {number} ron_ohms
     * @param {number} roff_ohms
     * @param {number} on_current
     * @param {number} off_current
     */
    add_relay(id, coil_positive, coil_negative, common, normally_closed, normally_open, coil_resistance_ohms, ron_ohms, roff_ohms, on_current, off_current) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.simulator_add_relay(this.__wbg_ptr, ptr0, len0, coil_positive, coil_negative, common, normally_closed, normally_open, coil_resistance_ohms, ron_ohms, roff_ohms, on_current, off_current);
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
     * Snapshot of per-capacitor voltages.
     * @returns {Float64Array}
     */
    export_cap_volts() {
        const ret = wasm.simulator_export_cap_volts(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Snapshot of Gear-2 readiness (true once a step has been committed).
     * @returns {boolean}
     */
    export_gear2_ready() {
        const ret = wasm.simulator_export_gear2_ready(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Snapshot of per-inductor branch currents.
     * @returns {Float64Array}
     */
    export_inductor_currents() {
        const ret = wasm.simulator_export_inductor_currents(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Snapshot of `node_volts` (current MNA unknowns).
     * @returns {Float64Array}
     */
    export_node_volts() {
        const ret = wasm.simulator_export_node_volts(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Snapshot of per-capacitor voltages from two steps ago (Gear-2).
     * @returns {Float64Array}
     */
    export_prev_cap_volts() {
        const ret = wasm.simulator_export_prev_cap_volts(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Snapshot of the previous step's dt (used to scale the predictor).
     * @returns {number}
     */
    export_prev_dt() {
        const ret = wasm.simulator_export_prev_dt(this.__wbg_ptr);
        return ret;
    }
    /**
     * Snapshot of per-inductor currents from two steps ago (Gear-2).
     * @returns {Float64Array}
     */
    export_prev_inductor_currents() {
        const ret = wasm.simulator_export_prev_inductor_currents(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Snapshot of `prev_node_volts` (predictor history).
     * @returns {Float64Array}
     */
    export_prev_node_volts() {
        const ret = wasm.simulator_export_prev_node_volts(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Snapshot of relay active flags (`true` = energised).  Returned as
     * `Vec<u8>` since `Vec<bool>` isn't natively exposable through
     * rust-e-sim-wasm-bindgen; 0/1 encoding.
     * @returns {Uint8Array}
     */
    export_relay_active() {
        const ret = wasm.simulator_export_relay_active(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Snapshot of BJT junction-cap voltages (layout: `[Q0_Vbe, Q0_Vbc, Q1_Vbe, …]`).
     * @returns {Float64Array}
     */
    export_tj_cap_volts() {
        const ret = wasm.simulator_export_tj_cap_volts(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Export the entire simulator state (netlist + current voltages/currents)
     * as a single JS object.
     * @returns {any}
     */
    get_full_state() {
        const ret = wasm.simulator_get_full_state(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {Float64Array} v
     */
    import_cap_volts(v) {
        const ptr0 = passArrayF64ToWasm0(v, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.simulator_import_cap_volts(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {boolean} ready
     */
    import_gear2_ready(ready) {
        wasm.simulator_import_gear2_ready(this.__wbg_ptr, ready);
    }
    /**
     * @param {Float64Array} v
     */
    import_inductor_currents(v) {
        const ptr0 = passArrayF64ToWasm0(v, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.simulator_import_inductor_currents(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Restore `node_volts`.  Silently ignored on length mismatch.
     * @param {Float64Array} v
     */
    import_node_volts(v) {
        const ptr0 = passArrayF64ToWasm0(v, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.simulator_import_node_volts(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {Float64Array} v
     */
    import_prev_cap_volts(v) {
        const ptr0 = passArrayF64ToWasm0(v, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.simulator_import_prev_cap_volts(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {number} dt
     */
    import_prev_dt(dt) {
        wasm.simulator_import_prev_dt(this.__wbg_ptr, dt);
    }
    /**
     * @param {Float64Array} v
     */
    import_prev_inductor_currents(v) {
        const ptr0 = passArrayF64ToWasm0(v, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.simulator_import_prev_inductor_currents(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {Float64Array} v
     */
    import_prev_node_volts(v) {
        const ptr0 = passArrayF64ToWasm0(v, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.simulator_import_prev_node_volts(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {Uint8Array} v
     */
    import_relay_active(v) {
        const ptr0 = passArray8ToWasm0(v, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.simulator_import_relay_active(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @param {Float64Array} v
     */
    import_tj_cap_volts(v) {
        const ptr0 = passArrayF64ToWasm0(v, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.simulator_import_tj_cap_volts(this.__wbg_ptr, ptr0, len0);
    }
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
     * @param {string} id
     * @returns {number}
     */
    inductor_current(id) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.simulator_inductor_current(this.__wbg_ptr, ptr0, len0);
        return ret;
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
     * Import a previously exported simulator state.  Invalidates the current
     * compilation, so `compile()` must be called before the next step.
     * @param {any} val
     */
    set_full_state(val) {
        const ret = wasm.simulator_set_full_state(this.__wbg_ptr, val);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
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
     * @param {number} dt
     * @param {number} gear
     * @returns {number}
     */
    step_with_gear_packed(dt, gear) {
        const ret = wasm.simulator_step_with_gear_packed(this.__wbg_ptr, dt, gear);
        return ret >>> 0;
    }
    /**
     * Update the resistance of an existing resistor.  This is a low-latency
     * operation that avoids full netlist reconstruction.
     * @param {string} id
     * @param {number} resistance_ohms
     * @returns {boolean}
     */
    update_resistor(id, resistance_ohms) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.simulator_update_resistor(this.__wbg_ptr, ptr0, len0, resistance_ohms);
        return ret !== 0;
    }
    /**
     * Update the voltage of an existing voltage source.
     * @param {string} id
     * @param {number} voltage
     * @returns {boolean}
     */
    update_voltage_source(id, voltage) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.simulator_update_voltage_source(this.__wbg_ptr, ptr0, len0, voltage);
        return ret !== 0;
    }
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
     * @param {string} id
     * @returns {number}
     */
    voltage_source_current(id) {
        const ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.simulator_voltage_source_current(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
}
if (Symbol.dispose) Simulator.prototype[Symbol.dispose] = Simulator.prototype.free;

/**
 * Opaque handle to a precomputed sparse LU pattern.
 *
 * JS receives a number-typed handle that it threads back into
 * `numeric_factor` and `sparse_solve_in_place`.  The pattern data itself
 * lives in rust-e-sim-wasm linear memory and is never serialized across the boundary.
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
 * Outcome of a `step()` call, marshalled across the rust-e-sim-wasm boundary as a
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
     * Estimated Local Truncation Error (LTE).
     * @returns {number}
     */
    get lte() {
        const ret = wasm.__wbg_get_stepresult_lte(this.__wbg_ptr);
        return ret;
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
     * Estimated Local Truncation Error (LTE).
     * @param {number} arg0
     */
    set lte(arg0) {
        wasm.__wbg_set_stepresult_lte(this.__wbg_ptr, arg0);
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
     * `polarity_npn` is a boolean instead of a string because rust-e-sim-wasm-bindgen
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
        __wbg_Error_bce6d499ff0a4aff: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_Number_b7972a139bfbfdf0: function(arg0) {
            const ret = Number(arg0);
            return ret;
        },
        __wbg___wbindgen_boolean_get_2304fb8c853028c8: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_copy_to_typed_array_787746aeb47818bc: function(arg0, arg1, arg2) {
            new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbg___wbindgen_debug_string_edece8177ad01481: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_07056af4f902c445: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_function_5cd60d5cf78b4eef: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_b4593df85baada48: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_dde0fd9020db4434: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_35bb9f4c7fd651d5: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_0ad77b7717db155c: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_f73a1244370fcc2c: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_d109740c0d18f4d7: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_9c31b086c2b26051: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_13665d9f14390edc: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_done_54b8da57023b7ed2: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_entries_564a7e8b1e54ede5: function(arg0) {
            const ret = Object.entries(arg0);
            return ret;
        },
        __wbg_get_3e9a707ab7d352eb: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_98fdf51d029a75eb: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_unchecked_1dfe6d05ad91d9b7: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {
            const ret = arg0[arg1];
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_53db37b06f6b9afe: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_abd07d4bd221d50b: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_94898ed3aad6947b: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isSafeInteger_01e964d144ad3a55: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_iterator_1441b47f341dc34f: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_length_2591a0f4f659a55c: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_56fcd3e2b7e0299d: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_02d162bc6cf02f60: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_310879b66b6e95e1: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_7ddec6de44ff8f5d: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_next_2a4e19f4f5083b0f: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_next_6429a146bf756f93: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_prototypesetcall_5f9bdc8d75e07276: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_78ea6a19f4818587: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_value_9cc0518af87a489c: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
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

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
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

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
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

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
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
    cachedDataViewMemory0 = null;
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
