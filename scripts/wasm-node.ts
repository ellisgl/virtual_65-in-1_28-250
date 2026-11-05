/**
 * wasm-node.ts — load the rust-e-sim WASM synchronously for Bun/Node scripts.
 *
 * The browser code fetches the .wasm via a Vite `?url` import; scripts read
 * it from disk instead.  Import this module first (side-effect import) and
 * the shared `sim_wasm.js` module instance is ready for `#lib/sim/*-wasm`.
 */
import { readFileSync } from 'node:fs';
import { initSync } from '#lib/sim/wasm/sim_wasm.js';

initSync({
	module: readFileSync(new URL('../src/lib/sim/wasm/sim_wasm_bg.wasm', import.meta.url))
});
