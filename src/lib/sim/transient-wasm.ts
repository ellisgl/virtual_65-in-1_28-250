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
 *   - Transformer/relay/coupling silently warn and skip — fall back to the
 *     TS solver for circuits that need them.
 *
 * Phase 3b/3c add: DC operating-point, BDF-2, predictor warm-start,
 * mutual inductance, inductor saturation.
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
// Vite-specific: `?url` makes Vite track the .wasm as a static asset and
// returns its resolved URL (hashed in production).  Without this, the
// wasm-pack init() falls back to `new URL('sim_wasm_bg.wasm', import.meta.url)`
// which inside a bundled web worker points to a path Vite never copied the
// .wasm to — initialisation fails and the engine falls back to TS.
import wasmUrl from '$lib/sim/wasm/sim_wasm_bg.wasm?url';
import type { SimulationNetlist } from '$lib/types';

let _ready: Promise<void> | null = null;
export function initSimWasm(): Promise<void> {
    if (_ready === null) {
        _ready = init({ module_or_path: wasmUrl }).then(() => undefined);
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

    /**
     * Build a simulator from a `SimulationNetlist`.  Each element maps to
     * a Rust `add_*` call.  Returns `null` if the netlist is empty or
     * compilation fails (no non-ground nodes).
     *
     * REQUIRES `await initSimWasm()` to have completed.
     */
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
                        el.capacitanceFarads, el.initialVoltage ?? 0);
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
                    d.free();
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
                    console.warn(
                        `WasmTransientSimulator: bare 'transformer' element `
                        + `(${el.componentId}) is not supported; pass the netlist `
                        + `through buildSimulationNetlist to expand it into `
                        + `inductors + coupling first.`,
                    );
                    break;
                case 'relay':
                    console.warn(
                        `WasmTransientSimulator: relay '${el.componentId}' is `
                        + `not yet supported; skipping.`,
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

    solveDc(): boolean {
        return this.sim.solve_dc();
    }

    step(dt: number): StepResult {
        return this.stepInner(this.sim.step(dt));
    }

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

    nodeVoltage(topologyNodeId: number): number {
        return this.sim.node_voltage(topologyNodeId);
    }

    dispose(): void {
        this.sim.free();
    }
}
