/**
 * dc-wasm.ts — environment-agnostic DC solve on the Rust WASM core.
 *
 * Split out of `dc-rust.ts` so it has no SvelteKit / Vite dependencies
 * (`$app/env`, `?url` imports) and can be used from Bun/Node scripts.
 * `dc-rust.ts` adds browser WASM init + a not-ready guard on top.
 */

import { WasmTransientSimulator } from '#lib/sim/transient-wasm';
import type { DcSolution, SimulationNetlist } from '#lib/types';

// ── DC solver ───────────────────────────────────────────────────────────────

/**
 * Solve the DC operating point of `netlist` using the Rust WASM core.
 *
 * Pure and synchronous: the caller must have initialised the WASM module
 * first (`initRustDc()` in the browser, `initSync()` in scripts).  Builds
 * a fresh Simulator per call and frees it afterwards.
 */
export function solveDcWasm(netlist: SimulationNetlist): DcSolution {
    if (netlist.groundNodeId === null) {
        return {
            ok: false, nodeVoltages: {}, sourceCurrents: {}, warnings: [],
            issue: { code: 'no-ground', message: 'No ground node in netlist' },
        };
    }
    if (netlist.elements.length === 0) {
        return {
            ok: false, nodeVoltages: {}, sourceCurrents: {}, warnings: [],
            issue: { code: 'empty-netlist', message: 'Netlist has no elements' },
        };
    }

    const sim = WasmTransientSimulator.fromNetlist(netlist);
    if (!sim) {
        return {
            ok: false, nodeVoltages: {}, sourceCurrents: {}, warnings: [],
            issue: { code: 'empty-netlist', message: 'Cannot build simulator from netlist' },
        };
    }

    try {
        if (!sim.solveDc()) {
            return {
                ok: false, nodeVoltages: {}, sourceCurrents: {}, warnings: [],
                issue: { code: 'singular-matrix', message: 'DC solve failed (singular or non-convergent)' },
            };
        }

        // Gather every topology node touched by any element so we know
        // which IDs to query.  Rust's node_voltage() returns 0 for unknown
        // IDs, so we could enumerate blindly, but enumerating only the
        // touched nodes keeps the output shape identical to TS — which
        // omits unused nodes entirely.
        const touchedNodes = collectNetlistNodeIds(netlist);

        const nodeVoltages: Record<number, number> = {
            [netlist.groundNodeId]: 0,
        };
        for (const nodeId of touchedNodes) {
            if (nodeId !== netlist.groundNodeId) {
                nodeVoltages[nodeId] = sim.nodeVoltage(nodeId);
            }
        }

        const sourceCurrents: Record<string, number> = {};
        for (const el of netlist.elements) {
            if (el.type === 'voltage-source') {
                sourceCurrents[el.componentId] = sim.voltageSourceCurrent(el.componentId);
            }
        }

        return { ok: true, nodeVoltages, sourceCurrents, warnings: [] };
    } finally {
        sim.dispose();
    }
}

/** Every topology node ID touched by at least one element.  Used to bound
 *  the readback loop so we only fetch voltages for nodes that actually
 *  exist in the compiled netlist. */
function collectNetlistNodeIds(netlist: SimulationNetlist): Set<number> {
    const ids = new Set<number>();
    for (const el of netlist.elements) {
        switch (el.type) {
            case 'resistor':
            case 'capacitor':
            case 'inductor':
                ids.add(el.nodes[0]);
                ids.add(el.nodes[1]);
                break;
            case 'voltage-source':
                ids.add(el.positiveNode);
                ids.add(el.negativeNode);
                break;
            case 'transistor':
                ids.add(el.baseNode);
                ids.add(el.collectorNode);
                ids.add(el.emitterNode);
                break;
            case 'diode':
                ids.add(el.anodeNode);
                ids.add(el.cathodeNode);
                break;
            case 'relay':
                ids.add(el.coilPositiveNode);
                ids.add(el.coilNegativeNode);
                ids.add(el.commonNode);
                ids.add(el.normallyClosedNode);
                ids.add(el.normallyOpenNode);
                break;
            case 'coupling':
                // Coupling element has no terminals of its own; it just
                // pairs inductors that already appeared in the netlist.
                break;
            case 'transformer':
                // Lumped-transformer elements are decomposed into
                // inductors + coupling by buildSimulationNetlist before
                // we see them here.  If one slips through, its node IDs
                // would still be valid — touch them so the readback
                // includes them.
                ids.add(el.primaryNodeA);
                ids.add(el.primaryNodeB);
                ids.add(el.secondaryNodeA);
                ids.add(el.secondaryNodeB);
                break;
            default:
                // Exhaustiveness — if a new element type is added to the
                // SimulationNetlist union, TypeScript flags this branch.
                ((_exhaustive: never) => _exhaustive)(el);
        }
    }
    return ids;
}
