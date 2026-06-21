/**
 * WASM-backed transient simulator.
 *
 * Builds a Rust-side `Simulator` from a TypeScript `SimulationNetlist`,
 * mapping each element to the corresponding `add_*` call.  Once compiled,
 * the simulator owns its matrix and state inside wasm linear memory; the
 * TS side only invokes `step(dt)` and reads voltages back as needed.
 *
 * Phase 3a scope
 * --------------
 *   - Supported elements: resistor, capacitor, inductor (single-coil),
 *     voltage source, transistor, diode.
 *   - Integration: backward Euler only.
 *   - No DC operating-point solve — the simulator starts from zero
 *     voltages (or the capacitor's `initialVoltage`).  Phase 3b adds DC.
 *   - No predictor warm-start, no adaptive dt, no relays, no transformers,
 *     no mutual inductance.  All come in Phase 3b.
 *
 * Caller is responsible for `await initSimWasm()` before using the
 * simulator.  Re-entrance is safe — `initSimWasm` memoises the init promise.
 */

import init, {
    Simulator as WasmSimulator,
    Diode as WasmDiode,
    Transistor as WasmTransistor,
    StepResult as WasmStepResult,
} from '$lib/sim/wasm/sim_wasm.js';
import type { SimulationNetlist } from '$lib/types';

let _ready: Promise<void> | null = null;
export function initSimWasm(): Promise<void> {
    if (_ready === null) {
        _ready = init().then(() => undefined);
    }
    return _ready as Promise<void>;
}

/** Issue codes returned by `step()` — mirrors the Rust `StepIssue` enum. */
export type StepIssue = 'singular-matrix' | 'newton-did-not-converge' | 'bad-timestep';

export interface StepResult {
    ok: boolean;
    /** Newton iteration count on success; 0 on failure. */
    iters: number;
    issue?: StepIssue;
}

/**
 * Convenience wrapper around the wasm-bindgen Simulator.
 *
 * Holds onto wasm-side handles for each transistor and diode so they
 * survive across the lifetime of the simulator (the underlying Rust
 * Element clones the parameter struct at `add_*` time, so once added
 * the JS-side wrapper isn't strictly needed — we `free()` immediately).
 */
export class WasmTransientSimulator {
    private sim: WasmSimulator;
    private compiled = false;

    constructor(groundNodeId: number) {
        this.sim = new WasmSimulator(groundNodeId);
    }

    /** Free the underlying wasm-side simulator.  Safe to call multiple times. */
    dispose(): void {
        this.sim.free();
    }

    /** Build a simulator from a SimulationNetlist in one call.  Returns
     *  `null` if the netlist has no non-ground nodes. */
    static fromNetlist(netlist: SimulationNetlist): WasmTransientSimulator | null {
        if (netlist.groundNodeId === null) return null;
        const s = new WasmTransientSimulator(netlist.groundNodeId);
        for (const el of netlist.elements) {
            switch (el.type) {
                case 'resistor':
                    s.sim.add_resistor(el.componentId, el.nodes[0], el.nodes[1], el.resistanceOhms);
                    break;
                case 'capacitor':
                    s.sim.add_capacitor(el.componentId, el.nodes[0], el.nodes[1],
                        el.capacitanceFarads, el.initialVoltage);
                    break;
                case 'inductor':
                    s.sim.add_inductor(
                        el.componentId, el.nodes[0], el.nodes[1],
                        el.inductanceHenry, el.saturationCurrentA,
                        el.couplingGroup, el.couplingPolarity,
                    );
                    break;
                case 'coupling':
                    s.sim.add_coupling(el.componentId, el.couplingGroup, el.k);
                    break;
                case 'voltage-source':
                    s.sim.add_voltage_source(el.componentId,
                        el.positiveNode, el.negativeNode, el.voltage);
                    break;
                case 'diode': {
                    const d = el.bv !== undefined
                        ? WasmDiode.zener(el.is, el.n, el.bv, el.ibv)
                        : WasmDiode.shockley(el.is, el.n);
                    s.sim.add_diode(el.componentId, el.anodeNode, el.cathodeNode, d);
                    d.free(); // Rust side cloned the params at add time.
                    break;
                }
                case 'transistor': {
                    const q = new WasmTransistor(
                        el.polarity === 'npn',
                        el.beta, el.is, el.nf, el.vaf,
                        el.cjeFarads, el.cjcFarads,
                        el.br, el.nr, el.var, el.ikf, el.ikr,
                        el.ise, el.ne, el.isc, el.nc,
                        el.tfSeconds, el.trSeconds,
                    );
                    s.sim.add_transistor(el.componentId,
                        el.baseNode, el.collectorNode, el.emitterNode, q);
                    q.free();
                    break;
                }
                case 'transformer':
                    // Transformers are decomposed into individual inductors +
                    // resistors + a coupling element by `buildSimulationNetlist`.
                    // A raw `transformer` element appearing here means the
                    // caller skipped that expansion — not supported.
                    console.warn(
                        `WasmTransientSimulator: bare 'transformer' element `
                        + `(${el.componentId}) is not supported; pass the netlist `
                        + `through buildSimulationNetlist to expand it into `
                        + `inductors + coupling first.`,
                    );
                    break;
                case 'relay':
                    s.sim.add_relay(
                        el.componentId,
                        el.coilPositiveNode,    el.coilNegativeNode,
                        el.commonNode,          el.normallyClosedNode, el.normallyOpenNode,
                        el.coilResistanceOhms,
                        el.ronOhms,             el.roffOhms,
                        el.onCurrent,           el.offCurrent,
                    );
                    break;
                default: {
                    const _exhaustive: never = el;
                    void _exhaustive;
                }
            }
        }
        if (!s.sim.compile()) {
            s.dispose();
            return null;
        }
        s.compiled = true;
        return s;
    }

    /** Solve the DC operating point.  Caps treated as open, inductors as
     *  shorts.  Required for circuits with BJTs to converge on cold start.
     *  Must be called after `fromNetlist` succeeds and before stepping.
     *  Returns `true` on success.  After DC, the next `step()` call will
     *  use BE (the first transient step after DC always falls back to BE,
     *  matching TS). */
    solveDc(): boolean {
        return this.sim.solve_dc();
    }

    /** Advance by `dt` seconds with backward Euler. */
    step(dt: number): StepResult {
        return this.stepInner(this.sim.step(dt));
    }

    /** Advance by `dt` seconds with BDF-2 / Gear-2 integration.  Falls
     *  back to BE if there's no usable history (first step after DC or
     *  after `compile`). */
    stepBdf2(dt: number): StepResult {
        return this.stepInner(this.sim.step_with_gear(dt, 2));
    }

    private stepInner(r: WasmStepResult): StepResult {
        try {
            if (r.ok) return { ok: true, iters: r.iters };
            const issue =
                r.issue === 1 ? 'singular-matrix' :
                r.issue === 2 ? 'newton-did-not-converge' :
                                'bad-timestep';
            return { ok: false, iters: 0, issue };
        } finally {
            r.free();
        }
    }

    /** Voltage at the given topology node ID.  Returns 0 for ground or
     *  for nodes not present in any element. */
    nodeVoltage(nodeId: number): number {
        return this.sim.node_voltage(nodeId);
    }

    /** Voltage-source branch current by component id.
     *
     *  Sign convention (matches TS `sourceCurrents`): positive when the
     *  external circuit is FORCING current INTO the + terminal of the
     *  source (sink mode).  A battery driving a load is in *source* mode,
     *  so the value comes back NEGATIVE with magnitude equal to the load
     *  current.  Callers that want a "supply current" display should
     *  negate at the call site.
     *
     *  Returns 0 if the id doesn't match any voltage source or if the
     *  simulator hasn't been stepped yet. */
    voltageSourceCurrent(componentId: string): number {
        return this.sim.voltage_source_current(componentId);
    }

    /** Per-inductor branch current by component id.
     *
     *  Sign convention: positive current flows from terminal `a` to
     *  terminal `b` (the order passed to the netlist).  For an audio
     *  speaker modelled as `Rvc + Lvc` in series, this is the actual
     *  cone-driving current — usually a more accurate audio probe than
     *  the voltage across the speaker terminals (which mixes resistive
     *  drop and inductive EMF).
     *
     *  Returns 0 if the id doesn't match or the sim is uncompiled. */
    inductorCurrent(componentId: string): number {
        return this.sim.inductor_current(componentId);
    }

    /** Number of non-ground nodes in the compiled netlist. */
    get nodeCount(): number {
        return this.sim.node_count;
    }

    get isCompiled(): boolean {
        return this.compiled;
    }

    // ── State preservation for hot-recompile ────────────────────────────
    //
    // exportState() captures every piece of transient state into a plain
    // JS object.  importState() copies it back into a freshly-built
    // simulator (e.g. one produced by fromNetlist after a pot/cap value
    // change).  Position-indexed: callers must ensure the new simulator
    // has identical state-vector shapes — i.e. value-only changes only,
    // not topology changes.  For kit simulations this holds for any
    // updateControls call (catalog component list is fixed; element
    // counts depend only on which components are wired, which doesn't
    // change between an updateControls and its predecessor).

    exportState(): TransientStateSnapshot {
        return {
            nodeVolts:           this.sim.export_node_volts(),
            prevNodeVolts:       this.sim.export_prev_node_volts(),
            capVolts:            this.sim.export_cap_volts(),
            prevCapVolts:        this.sim.export_prev_cap_volts(),
            inductorCurrents:    this.sim.export_inductor_currents(),
            prevInductorCurrents:this.sim.export_prev_inductor_currents(),
            tjCapVolts:          this.sim.export_tj_cap_volts(),
            relayActive:         this.sim.export_relay_active(),
            gear2Ready:          this.sim.export_gear2_ready(),
            prevDt:              this.sim.export_prev_dt(),
        };
    }

    importState(snap: TransientStateSnapshot): void {
        this.sim.import_node_volts(snap.nodeVolts);
        this.sim.import_prev_node_volts(snap.prevNodeVolts);
        this.sim.import_cap_volts(snap.capVolts);
        this.sim.import_prev_cap_volts(snap.prevCapVolts);
        this.sim.import_inductor_currents(snap.inductorCurrents);
        this.sim.import_prev_inductor_currents(snap.prevInductorCurrents);
        this.sim.import_tj_cap_volts(snap.tjCapVolts);
        this.sim.import_relay_active(snap.relayActive);
        this.sim.import_gear2_ready(snap.gear2Ready);
        this.sim.import_prev_dt(snap.prevDt);
    }
}

/** Complete transient state snapshot — exported by one Simulator,
 *  importable into another.  See `exportState` / `importState`.
 *
 *  All typed-array fields are returned natively by the wasm-bindgen
 *  bindings (Vec<f64> → Float64Array, Vec<u8> → Uint8Array); the import
 *  side expects the same.  Using typed arrays only — not Array<number> —
 *  keeps the round-trip allocation-free and matches the strict d.ts
 *  generated by the Rust build process. */
export interface TransientStateSnapshot {
    nodeVolts:            Float64Array;
    prevNodeVolts:        Float64Array;
    capVolts:             Float64Array;
    prevCapVolts:         Float64Array;
    inductorCurrents:     Float64Array;
    prevInductorCurrents: Float64Array;
    tjCapVolts:           Float64Array;
    relayActive:          Uint8Array;
    gear2Ready:           boolean;
    prevDt:               number;
}
