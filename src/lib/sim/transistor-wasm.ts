/**
 * WASM-backed transistor stamp.
 *
 * Drop-in replacement for `$lib/sim/transistor` once the WASM build is in
 * place.  Same function signature, same numerical output.
 *
 * Same Phase 2 caveat as `diode-wasm.ts`: this adapter constructs a fresh
 * WASM `Transistor` handle per call.  Phase 3 moves elements into wasm
 * memory permanently and this adapter goes away.
 */

import init, {
    Transistor as WasmTransistor,
    computeTransistorStamp as wasmComputeTransistorStamp,
} from '$lib/sim/wasm/sim_wasm.js';
import type { SimulationTransistorElement } from '$lib/types';

export interface TransistorStamp {
    gBe:   number;
    gBc:   number;
    gm:    number;
    gmu:   number;
    gpi:   number;
    gmu_b: number;
    iEqB:  number;
    iEqC:  number;
    iEqE:  number;
}

let _ready: Promise<void> | null = null;

export function initSimWasm(): Promise<void> {
    if (_ready === null) {
        _ready = init().then(() => undefined);
    }
    return _ready as Promise<void>;
}

export function computeTransistorStamp(
    transistor: SimulationTransistorElement,
    volts: Float64Array,
    bi: number,
    ci: number,
    ei: number,
    prevVolts?: Float64Array,
): TransistorStamp {
    const q = new WasmTransistor(
        /*polarity_npn*/ transistor.polarity === 'npn',
        transistor.beta,
        transistor.is,
        transistor.nf,
        transistor.vaf,
        transistor.cjeFarads,
        transistor.cjcFarads,
        transistor.br,
        transistor.nr,
        transistor.var,
        transistor.ikf,
        transistor.ikr,
        transistor.ise,
        transistor.ne,
        transistor.isc,
        transistor.nc,
        transistor.tfSeconds,
        transistor.trSeconds,
    );

    const s = wasmComputeTransistorStamp(q, volts, bi, ci, ei, prevVolts);
    const result: TransistorStamp = {
        gBe: s.gBe, gBc: s.gBc,
        gm:  s.gm,  gmu: s.gmu,
        gpi: s.gpi, gmu_b: s.gmu_b,
        iEqB: s.iEqB, iEqC: s.iEqC, iEqE: s.iEqE,
    };
    q.free();
    s.free();
    return result;
}
