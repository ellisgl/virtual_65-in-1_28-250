/**
 * Side-by-side parity check: TS vs Rust on a real kit circuit.
 *
 * Builds the same `SimulationNetlist` once, hands it to both engines,
 * advances them with the same dt sequence, and reports per-step
 * disagreement.  Use this from a dev route to gain confidence before
 * flipping the worker's default engine to 'rust'.
 *
 * Usage (from a SvelteKit dev route):
 *
 *   import { runWorkerParityCheck } from '$lib/sim/parity-check';
 *   import { KIT_COMPONENTS } from '$lib/data/components';
 *
 *   const wires = [ ... your test circuit wires ... ];
 *   const controls = { valueOverrides: {}, positionOverrides: {}, switchStates: {} };
 *   const report = await runWorkerParityCheck(wires, controls, { steps: 5000, dt: 1e-5 });
 *   console.log(report);
 *
 * Output: a per-probe-node summary of max |Δ| and the timestep at which it
 * occurred.  Bit-exact match is not expected on BJT-bearing circuits
 * (see Phase 3b rationale); linear sub-circuits match to ~1e-9.
 */

import { KIT_COMPONENTS } from '$lib/data/components';
import { buildCircuitTopology } from '$lib/sim/topology';
import { buildSimulationNetlist } from '$lib/sim/netlist';
import { createEngine } from '$lib/sim/solver-engine';
import type { ControlState, WireSpec } from '$lib/sim/worker-protocol';

export interface ParityCheckOptions {
    /** Number of timesteps to advance.  Default: 1000. */
    steps?: number;
    /** Timestep size (s).  Default: 1e-5. */
    dt?: number;
    /** Topology node IDs to track.  Default: all non-ground nodes. */
    probeNodes?: number[];
    /** Apply a startup kick to both engines.  Default: 0.005 V. */
    startupKick?: number;
}

export interface PerNodeReport {
    nodeId: number;
    maxAbsDelta: number;
    /** Step index at which `maxAbsDelta` was observed. */
    worstStep: number;
    tsValueAtWorst: number;
    rustValueAtWorst: number;
}

export interface ParityReport {
    engineActivated: 'ts' | 'rust';
    steps: number;
    dt: number;
    /** Per-node summaries, sorted descending by max |Δ|. */
    perNode: PerNodeReport[];
    /** Worst delta across all nodes and steps. */
    overallMaxDelta: number;
    /** True if the Rust engine was actually used (vs. fell back to TS). */
    rustReady: boolean;
}

function toWireObjects(specs: WireSpec[]) {
    return specs.map((w) => ({
        fromTerminal: w.fromTerminal, toTerminal: w.toTerminal, id: '', color: '',
    }));
}

export async function runWorkerParityCheck(
    wires: WireSpec[],
    controls: ControlState,
    opts: ParityCheckOptions = {},
): Promise<ParityReport> {
    const steps       = opts.steps ?? 1000;
    const dt          = opts.dt ?? 1e-5;
    const startupKick = opts.startupKick ?? 0.005;

    const topology = buildCircuitTopology(toWireObjects(wires), KIT_COMPONENTS);
    const netlist  = buildSimulationNetlist(topology, KIT_COMPONENTS, controls);

    // Probe all non-ground topology nodes by default.
    const probeNodes = opts.probeNodes ?? (() => {
        const set = new Set<number>();
        for (const t of Object.values(topology.terminalToNode)) {
            if (typeof t === 'number' && t !== netlist.groundNodeId) set.add(t);
        }
        return Array.from(set).sort((a, b) => a - b);
    })();

    const { engine: tsEngine }   = await createEngine('ts');
    const rustResult             = await createEngine('rust');
    const rustEngine             = rustResult.engine;
    const rustReady              = rustResult.actual === 'rust';

    if (!tsEngine.configure(netlist, startupKick)) {
        throw new Error('TS engine configure failed (empty netlist?)');
    }
    if (!rustEngine.configure(netlist, startupKick)) {
        throw new Error('Rust engine configure failed (empty netlist?)');
    }

    const perNode = new Map<number, PerNodeReport>();
    for (const id of probeNodes) {
        perNode.set(id, {
            nodeId: id, maxAbsDelta: 0, worstStep: 0,
            tsValueAtWorst: 0, rustValueAtWorst: 0,
        });
    }

    let overallMaxDelta = 0;
    for (let step = 0; step < steps; step++) {
        const tsOk   = tsEngine.step(dt).ok;
        const rustOk = rustEngine.step(dt).ok;
        if (!tsOk || !rustOk) {
            console.warn(`parity-check: solver failed at step ${step} (ts=${tsOk}, rust=${rustOk})`);
            break;
        }
        for (const id of probeNodes) {
            const tsV = tsEngine.nodeVoltageByTopologyId(id);
            const rustV = rustEngine.nodeVoltageByTopologyId(id);
            const delta = Math.abs(tsV - rustV);
            const rec = perNode.get(id)!;
            if (delta > rec.maxAbsDelta) {
                rec.maxAbsDelta = delta;
                rec.worstStep = step;
                rec.tsValueAtWorst = tsV;
                rec.rustValueAtWorst = rustV;
            }
            if (delta > overallMaxDelta) overallMaxDelta = delta;
        }
    }

    tsEngine.dispose();
    rustEngine.dispose();

    const sorted = Array.from(perNode.values()).sort((a, b) => b.maxAbsDelta - a.maxAbsDelta);
    return {
        engineActivated: rustResult.actual,
        steps, dt,
        perNode: sorted,
        overallMaxDelta,
        rustReady,
    };
}

/**
 * Convenience pretty-printer for the parity report.  Returns a multi-line
 * string suitable for `console.log` or a dev-route pre-tag.
 */
export function formatParityReport(r: ParityReport): string {
    const lines: string[] = [];
    lines.push(`Solver parity check — ${r.steps} steps × dt=${r.dt}s`);
    lines.push(`Rust ready: ${r.rustReady ? 'yes' : 'NO (fell back to TS — build WASM first)'}`);
    lines.push(`Overall max |Δ|: ${r.overallMaxDelta.toExponential(3)} V`);
    lines.push('');
    lines.push('Top 10 worst nodes:');
    for (const n of r.perNode.slice(0, 10)) {
        lines.push(
            `  node ${String(n.nodeId).padStart(4)}  max|Δ|=${n.maxAbsDelta.toExponential(3)}  `
            + `@step ${String(n.worstStep).padStart(5)}  `
            + `ts=${n.tsValueAtWorst.toFixed(6)} rust=${n.rustValueAtWorst.toFixed(6)}`,
        );
    }
    return lines.join('\n');
}
