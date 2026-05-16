/**
 * Solver-engine abstraction.
 *
 * Wraps either the TypeScript reference solver or the WASM-backed Rust
 * solver behind a common interface so `sim-worker.ts` doesn't have to
 * branch on every call.  This is the only place that knows about both
 * implementations; the worker calls into the abstraction.
 *
 * Lifecycle
 * ---------
 *   createEngine('ts'|'rust')          one-time async setup; returns the engine
 *   engine.configure(netlist, dcSeed)  build compiled state from a fresh netlist
 *   engine.updateControls(netlist)     recompile (values changed, topology same)
 *   engine.step(dt)                    advance one transient step
 *   engine.nodeVoltageByTopologyId(id) read current node voltage
 *   engine.dispose()                   free WASM resources (no-op for TS)
 *
 * The Rust engine builds its `Simulator` from the same `SimulationNetlist`
 * the TS engine consumes, then ignores all `transformer`/`relay` elements
 * for the moment (relays are Phase 3c-cont).  Bare-transformer elements
 * shouldn't appear because `buildSimulationNetlist` decomposes them into
 * inductors + coupling before we see them.
 */

import { applyStartupKick, compileNetlist, initializeTransientState, stepTransientNetlist } from '$lib/sim/transient';
import { solveDcNetlist } from '$lib/sim/dc';
import { WasmTransientSimulator, initSimWasm } from '$lib/sim/transient-wasm';
import type { CompiledNetlist, SimulationNetlist, TransientState } from '$lib/types';

export interface StepOutcome {
    ok: boolean;
    /** Adaptive-dt suggestion for the next step.  TS provides this from its
     *  LTE estimator; Rust returns undefined (Phase 3d doesn't have LTE). */
    recommendedDt?: number;
}

export interface SolverEngineInstance {
    readonly kind: 'ts' | 'rust';
    /** Set up a fresh simulation from the given netlist.  Resets transient
     *  state.  `startupKick` adds a small random voltage to break perfect
     *  symmetry on oscillators that won't otherwise start. */
    configure(netlist: SimulationNetlist, startupKick: number): boolean;
    /** Apply a new netlist (same topology, possibly different values) while
     *  preserving the running transient state.  For the Rust engine, state
     *  preservation across rebuilds isn't supported (the simulator owns its
     *  matrix layout) — Phase 3d limitation; controls work but cause a
     *  brief audio glitch on each change.  For the TS engine, this is the
     *  standard hot-recompile path. */
    updateControls(netlist: SimulationNetlist): void;
    step(dt: number): StepOutcome;
    /** Read a node voltage by its topology node ID (NOT compact index).
     *  Returns 0 for ground or unknown nodes. */
    nodeVoltageByTopologyId(topologyNodeId: number): number;
    /** Map of topology node ID → voltage for snapshots.  Excluded: ground. */
    snapshot(): Record<number, number>;
    dispose(): void;
}

// ── TS implementation ────────────────────────────────────────────────────

class TsEngine implements SolverEngineInstance {
    readonly kind = 'ts';
    private netlist: SimulationNetlist | null = null;
    private compiled: CompiledNetlist | null = null;
    private state: TransientState | null = null;

    configure(netlist: SimulationNetlist, startupKick: number): boolean {
        const compiled = compileNetlist(netlist);
        if (!compiled) return false;
        const dc = solveDcNetlist(netlist);
        this.netlist  = netlist;
        this.compiled = compiled;
        this.state = applyStartupKick(
            initializeTransientState(compiled, dc.ok ? dc.nodeVoltages : undefined),
            startupKick,
        );
        return true;
    }

    updateControls(netlist: SimulationNetlist): void {
        const compiled = compileNetlist(netlist);
        if (!compiled) return;
        this.netlist  = netlist;
        this.compiled = compiled;
        // state intentionally preserved
    }

    step(dt: number): StepOutcome {
        if (!this.netlist || !this.compiled || !this.state) return { ok: false };
        const r = stepTransientNetlist(this.netlist, this.state, { dt, gear: 2 }, this.compiled);
        if (!r.ok) return { ok: false };
        this.state = r.state;
        return { ok: true, recommendedDt: r.recommendedDt };
    }

    nodeVoltageByTopologyId(id: number): number {
        if (!this.compiled || !this.state) return 0;
        const compact = this.compiled.nodeIndex.get(id);
        return compact === undefined ? 0 : this.state.nodeVolts[compact];
    }

    snapshot(): Record<number, number> {
        if (!this.compiled || !this.state) return {};
        const out: Record<number, number> = {};
        // nodeIndex maps topology-node → compact index.
        for (const [topId, compact] of this.compiled.nodeIndex) {
            out[topId] = this.state.nodeVolts[compact];
        }
        return out;
    }

    dispose(): void {
        // TS engine has no native resources.
    }
}

// ── Rust implementation ──────────────────────────────────────────────────

class RustEngine implements SolverEngineInstance {
    readonly kind = 'rust';
    private sim: WasmTransientSimulator | null = null;
    private nodeIds: Set<number> = new Set();

    configure(netlist: SimulationNetlist, _startupKick: number): boolean {
        // The Rust engine doesn't have an applyStartupKick equivalent yet —
        // the small symmetry-breaking voltage is added inside the netlist
        // builder for symmetric oscillators, so most circuits start cleanly
        // without it.  For Phase 3d we accept the limitation: oscillators
        // that need an explicit kick will warm up over a few cycles instead.
        if (this.sim) {
            this.sim.dispose();
            this.sim = null;
        }
        const sim = WasmTransientSimulator.fromNetlist(netlist);
        if (!sim) return false;
        // Required for BJT-bearing circuits; harmless for purely-linear ones
        // (DC just gives the same answer the first transient step would).
        sim.solveDc();
        this.sim = sim;
        this.nodeIds = collectTopologyNodeIds(netlist);
        return true;
    }

    updateControls(netlist: SimulationNetlist): void {
        // Phase 3d: rebuild from scratch.  State is lost — produces a brief
        // audio glitch on each control change.  A proper hot-recompile that
        // preserves transient state is doable (capture node_volts +
        // cap_volts + inductor_currents, rebuild Simulator, restore), but
        // adds complexity — defer to a Phase 3d-cont if the glitches matter
        // in practice.
        this.configure(netlist, 0);
    }

    step(dt: number): StepOutcome {
        if (!this.sim) return { ok: false };
        const r = this.sim.stepBdf2(dt);
        return { ok: r.ok };
    }

    nodeVoltageByTopologyId(id: number): number {
        return this.sim ? this.sim.nodeVoltage(id) : 0;
    }

    snapshot(): Record<number, number> {
        if (!this.sim) return {};
        const out: Record<number, number> = {};
        for (const id of this.nodeIds) {
            out[id] = this.sim.nodeVoltage(id);
        }
        return out;
    }

    dispose(): void {
        if (this.sim) {
            this.sim.dispose();
            this.sim = null;
        }
    }
}

function collectTopologyNodeIds(netlist: SimulationNetlist): Set<number> {
    const ids = new Set<number>();
    for (const el of netlist.elements) {
        switch (el.type) {
            case 'resistor':
            case 'capacitor':
            case 'inductor':
                ids.add(el.nodes[0]); ids.add(el.nodes[1]); break;
            case 'voltage-source':
                ids.add(el.positiveNode); ids.add(el.negativeNode); break;
            case 'transistor':
                ids.add(el.baseNode); ids.add(el.collectorNode); ids.add(el.emitterNode); break;
            case 'diode':
                ids.add(el.anodeNode); ids.add(el.cathodeNode); break;
            case 'transformer':
                ids.add(el.primaryNodeA); ids.add(el.primaryNodeB);
                ids.add(el.secondaryNodeA); ids.add(el.secondaryNodeB);
                break;
            case 'relay':
                ids.add(el.coilPositiveNode); ids.add(el.coilNegativeNode);
                ids.add(el.commonNode); ids.add(el.normallyClosedNode); ids.add(el.normallyOpenNode);
                break;
            case 'coupling':
                break; // no nodes
        }
    }
    // `groundNodeId` is `number | null` — a netlist with no chosen ground
    // can't simulate, but it can still flow through here (the engines bail
    // earlier).  Only delete when actually set.
    if (netlist.groundNodeId !== null) ids.delete(netlist.groundNodeId);
    return ids;
}

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Create a solver engine of the requested kind.  Falls back to TS if
 * `kind === 'rust'` but the WASM module fails to init (e.g. wasm-pack
 * hasn't been run yet).
 *
 * Returns the engine PLUS the kind that actually activated, so the caller
 * can report it back to the UI / log.
 */
export async function createEngine(
    kind: 'ts' | 'rust',
): Promise<{ engine: SolverEngineInstance; actual: 'ts' | 'rust' }> {
    if (kind === 'rust') {
        try {
            await initSimWasm();
            return { engine: new RustEngine(), actual: 'rust' };
        } catch (e) {
            console.warn(
                'createEngine: WASM init failed; falling back to TS solver.  '
                + 'Build the WASM module with `cd rust && ./build.sh`.',
                e,
            );
            return { engine: new TsEngine(), actual: 'ts' };
        }
    }
    return { engine: new TsEngine(), actual: 'ts' };
}
