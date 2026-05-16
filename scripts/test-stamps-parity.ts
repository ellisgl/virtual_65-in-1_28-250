/**
 * Parity test: TypeScript vs WASM element stamps.
 *
 * Run after building the WASM module (`cd rust && ./build.sh`).  Drives
 * both implementations through a battery of cases and asserts agreement to
 * within 1e-12 on every output field.
 *
 * To run from a SvelteKit dev route, import and call `runStampsParityTests()`.
 */

import { computeDiodeStamp as tsDiodeStamp } from '$lib/sim/diode';
import { computeTransistorStamp as tsTransistorStamp } from '$lib/sim/transistor';
import {
    computeDiodeStamp as wasmDiodeStamp,
    initSimWasm,
} from '$lib/sim/diode-wasm';
import { computeTransistorStamp as wasmTransistorStamp } from '$lib/sim/transistor-wasm';
import type { SimulationDiodeElement, SimulationTransistorElement } from '$lib/types';

const TOL = 1e-12;

function diff(a: number, b: number): number {
    return Math.abs(a - b);
}

export async function runStampsParityTests(): Promise<{ passed: number; failed: number }> {
    await initSimWasm();
    let passed = 0, failed = 0;

    // ── Diode cases ────────────────────────────────────────────────────
    interface DiodeCase {
        name: string;
        d: SimulationDiodeElement;
        volts: number[];
        ai: number;
        ki: number;
        prev?: number[];
    }

    const D = (overrides: Partial<SimulationDiodeElement> = {}): SimulationDiodeElement => ({
        type: 'diode', componentId: 'D', anodeNode: 0, cathodeNode: 1,
        is: 1e-14, n: 1, ...overrides,
    });

    const diodeCases: DiodeCase[] = [
        { name: 'reverse',         d: D(),                volts: [-5, 0],   ai: 0, ki: 1 },
        { name: 'forward 0.7V',    d: D(),                volts: [0.7, 0],  ai: 0, ki: 1 },
        { name: 'high n',          d: D({ n: 1.8 }),      volts: [0.7, 0],  ai: 0, ki: 1 },
        { name: 'grounded anode',  d: D(),                volts: [0, -0.6], ai: -1, ki: 1 },
        { name: 'grounded cathode', d: D(),               volts: [0.6],     ai: 0, ki: -1 },
        { name: 'zener off',       d: D({ bv: 5.0 }),     volts: [0, 0],    ai: 0, ki: 1 },
        { name: 'zener breakdown', d: D({ bv: 5.0 }),     volts: [-6, 0],   ai: 0, ki: 1 },
        { name: 'pnjlim swing',    d: D(),                volts: [1, 0],    ai: 0, ki: 1, prev: [-1, 0] },
    ];

    for (const c of diodeCases) {
        const ts = tsDiodeStamp(c.d, new Float64Array(c.volts), c.ai, c.ki,
            c.prev ? new Float64Array(c.prev) : undefined);
        const ws = wasmDiodeStamp(c.d, new Float64Array(c.volts), c.ai, c.ki,
            c.prev ? new Float64Array(c.prev) : undefined);
        const dGd  = diff(ts.gd,  ws.gd);
        const dIeq = diff(ts.ieq, ws.ieq);
        const ok = dGd < TOL && dIeq < TOL;
        if (ok) {
            passed++;
            console.log(`✓ diode ${c.name}  (Δgd=${dGd.toExponential(2)}, Δieq=${dIeq.toExponential(2)})`);
        } else {
            failed++;
            console.error(`✗ diode ${c.name}`);
            console.error(`  ts gd=${ts.gd} ieq=${ts.ieq}`);
            console.error(`  ws gd=${ws.gd} ieq=${ws.ieq}`);
        }
    }

    // ── Transistor cases ───────────────────────────────────────────────
    interface TransistorCase {
        name: string;
        q: SimulationTransistorElement;
        volts: number[];
        bi: number;
        ci: number;
        ei: number;
        prev?: number[];
    }

    const Q = (overrides: Partial<SimulationTransistorElement> = {}): SimulationTransistorElement => ({
        type: 'transistor', componentId: 'Q', polarity: 'npn',
        baseNode: 0, collectorNode: 1, emitterNode: 2,
        beta: 200, is: 6.734e-15, nf: 1, vaf: 74.03,
        cjeFarads: 0, cjcFarads: 0, ...overrides,
    });

    const transistorCases: TransistorCase[] = [
        { name: 'npn off',         q: Q(),                          volts: [0,    0,    0   ], bi: 0, ci: 1, ei: 2 },
        { name: 'npn active',      q: Q(),                          volts: [0.65, 3.65, 0   ], bi: 0, ci: 1, ei: 2 },
        { name: 'npn saturation',  q: Q(),                          volts: [0.7,  0.2,  0   ], bi: 0, ci: 1, ei: 2 },
        { name: 'pnp active',      q: Q({ polarity: 'pnp', beta: 50, is: 1e-14, vaf: 50 }),
                                                                    volts: [0,   -3,    0.65], bi: 0, ci: 1, ei: 2 },
        { name: 'npn pnjlim',      q: Q(),                          volts: [1.5,  3,    0   ], bi: 0, ci: 1, ei: 2, prev: [0, 3, 0] },
        { name: 'npn transient',   q: Q(),                          volts: [0.65, 3.65, 0   ], bi: 0, ci: 1, ei: 2, prev: [0.65, 3.65, 0] },
        { name: 'npn full GP',     q: Q({ ikf: 0.05, ikr: 0.05, br: 5, var: 50, ise: 1e-12, nc: 2 }),
                                                                    volts: [0.65, 3.65, 0   ], bi: 0, ci: 1, ei: 2 },
        { name: 'npn grounded B',  q: Q(),                          volts: [3.65, 0       ], bi: -1, ci: 0, ei: 1 },
    ];

    const fields: (keyof ReturnType<typeof tsTransistorStamp>)[] =
        ['gBe', 'gBc', 'gm', 'gmu', 'gpi', 'gmu_b', 'iEqB', 'iEqC', 'iEqE'];

    for (const c of transistorCases) {
        const ts = tsTransistorStamp(c.q, new Float64Array(c.volts), c.bi, c.ci, c.ei,
            c.prev ? new Float64Array(c.prev) : undefined);
        const ws = wasmTransistorStamp(c.q, new Float64Array(c.volts), c.bi, c.ci, c.ei,
            c.prev ? new Float64Array(c.prev) : undefined);
        let maxDiff = 0;
        let worstField = '';
        for (const f of fields) {
            const d = diff(ts[f] as number, ws[f] as number);
            if (d > maxDiff) { maxDiff = d; worstField = f; }
        }
        if (maxDiff < TOL) {
            passed++;
            console.log(`✓ transistor ${c.name}  (max Δ=${maxDiff.toExponential(2)})`);
        } else {
            failed++;
            console.error(`✗ transistor ${c.name}  worst field=${worstField} Δ=${maxDiff}`);
            console.error(`  ts:`, ts);
            console.error(`  ws:`, ws);
        }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    return { passed, failed };
}
