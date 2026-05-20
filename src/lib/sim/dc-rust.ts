/**
 * dc-rust.ts — main-thread DC solver routed through the Rust WASM core.
 *
 * Replaces the TypeScript DC solver in `dc.ts` for the live UI snapshot
 * that Board.svelte uses for voltmeter readings, lamp brightness, and
 * other always-on overlays.  The TS solver had a relay-sparsity bug
 * (contact stamp positions weren't in `dcPatMark`) and a too-strict
 * floating-throw filter; the Rust path has neither, plus all the BJT
 * junction-capacitance + pnjlim fixes from Phase 4.
 *
 * Lifecycle:
 *   - On client-side module load, kick off WASM init asynchronously.
 *   - Until init resolves, `solveDcRust()` returns an empty result with
 *     ok=false.  Board.svelte should default to a sentinel DcSolution
 *     during the first few frames after page load.  In practice the
 *     load completes within ~50ms of first paint on a warm cache.
 *   - Once ready, calls are fully synchronous — wasm-bindgen exports
 *     have no async overhead inside.  Each call builds a fresh Simulator
 *     from the netlist, solves DC, reads back voltages + VS currents,
 *     and frees the simulator.  Matches the TS solver's "fresh state
 *     per call" semantics; no caching.
 *
 * The shape returned matches `DcSolution` from `types.ts`, byte-for-byte
 * compatible with everything that currently consumes TS DC output.
 */

import init from '$lib/sim/wasm/sim_wasm.js';
import wasmUrl from '$lib/sim/wasm/sim_wasm_bg.wasm?url';
import { browser } from '$app/environment';
import { WasmTransientSimulator } from '$lib/sim/transient-wasm';
import type { DcSolution, SimulationNetlist } from '$lib/types';

// ── WASM init ───────────────────────────────────────────────────────────────

let _readyPromise: Promise<void> | null = null;
let _ready = false;

/** Kick off WASM init.  Idempotent — returns the same Promise on each call.
 *  Called at module load on the client; callers can `await` to make sure
 *  the synchronous `solveDcRust()` will work. */
export function initRustDc(): Promise<void> {
    if (_readyPromise) return _readyPromise;
    _readyPromise = init({ module_or_path: wasmUrl }).then(() => {
        _ready = true;
    });
    return _readyPromise;
}

/** True once `initRustDc()` has resolved.  Reactive code can read this
 *  to know whether `solveDcRust()` will produce real output. */
export function isRustDcReady(): boolean {
    return _ready;
}

// Fire init as soon as this module loads in the browser.  On SvelteKit
// SSR (typeof window === 'undefined'), the `browser` guard keeps the
// fetch from running where it'd fail.
if (browser) {
    initRustDc().catch((err) => {
        console.error('[dc-rust] WASM init failed:', err);
    });
}

// ── DC solver ───────────────────────────────────────────────────────────────

const EMPTY_LOADING: DcSolution = {
    ok: false,
    nodeVoltages: {},
    sourceCurrents: {},
    warnings: [],
    issue: { code: 'singular-matrix', message: 'WASM not yet loaded' },
};

/**
 * Solve the DC operating point of `netlist` using the Rust WASM core.
 * Synchronous after WASM has loaded; returns an empty result before then.
 *
 * Return shape matches the TS `solveDcNetlist()` so all callers can
 * migrate by swapping the import.
 */
export function solveDcRust(netlist: SimulationNetlist): DcSolution {
    if (!_ready) return EMPTY_LOADING;

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
