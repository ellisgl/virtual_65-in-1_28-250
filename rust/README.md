# sim-wasm — Rust/WASM port of the 65-in-1 simulator

Pure-Rust circuit simulator compiled to WebAssembly, replacing the TypeScript
solver in `src/lib/sim/` incrementally.

## Status (Phase 3d)

| Module                    | TypeScript            | Rust (this crate)          | Status |
|---------------------------|-----------------------|----------------------------|--------|
| Sparse LU + MD ordering   | `sparse.ts`           | `sim-core/src/sparse.rs`   | ✓ parity-verified |
| Element parameter types   | `types.ts`            | `sim-core/src/types.rs`    | ✓ Diode + Transistor |
| Diode stamp               | `diode.ts`            | `sim-core/src/diode.rs`    | ✓ parity-verified |
| Transistor stamp          | `transistor.ts`       | `sim-core/src/transistor.rs` | ✓ parity-verified |
| Netlist data model        | `netlist.ts`          | `sim-core/src/netlist.rs`  | ✓ R/C/L/V/BJT/Diode/Coupling |
| Netlist compile path      | `transient.ts`        | `sim-core/src/compile.rs`  | ✓ + mutual-inductance pairs |
| Newton + BE / BDF-2 step  | `transient.ts`        | `sim-core/src/transient.rs`| ✓ parity-verified |
| Predictor warm-start      | `transient.ts`        | `sim-core/src/transient.rs`| ✓ |
| DC operating-point        | `dc.ts`               | `sim-core/src/transient.rs`| ✓ |
| Mutual inductance         | `transient.ts`        | `sim-core/src/transient.rs`| ✓ parity-verified |
| Inductor saturation       | `transient.ts`        | `sim-core/src/transient.rs`| ✓ |
| Dense Gaussian fallback   | `linear.ts`           | `sim-core/src/linear.rs`   | ✓ |
| `Simulator` JS class      | —                     | `sim-wasm/src/lib.rs`      | ✓ +add_coupling |
| **Worker integration**    | `sim-worker.ts`       | via `solver-engine.ts`     | **✓ Phase 3d (opt-in)** |
| Relay state machine       | `transient.ts`        | —                          | Phase 3d-cont |
| Source-current diagnostics| `transient.ts`        | —                          | Phase 3d-cont |
| Adaptive dt, LTE          | `transient.ts`        | —                          | Phase 3d-cont |
| AudioWorklet hosting      | `speaker-worklet.js`  | —                          | Phase 4 |

### Phase 3d additions

**Engine abstraction (`src/lib/sim/solver-engine.ts`)** — single interface
implemented by both `TsEngine` and `RustEngine`, used by the worker.  The
only place that knows about both solvers.  The TS path is structurally
unchanged from previous phases; the abstraction is a thin wrapper around
the existing `compileNetlist` / `stepTransientNetlist` calls.

**Worker uses the abstraction.**  `sim-worker.ts` now calls `engine.step(dt)`
and `engine.nodeVoltageByTopologyId(id)` instead of branching on whether
TS or Rust is active.  The TS bench-steady test still runs at the same
~50 k steps/sec — no measurable overhead from the abstraction.

**Engine selection in the worker protocol.**  The `configure` message
takes an optional `engine: 'ts' | 'rust'` field (default `'ts'`).  After
configure, the worker posts an `engineReady` message reporting which
engine actually activated — Rust falls back to TS automatically if the
WASM module hasn't been built yet, with a console warning.

**Browser-side A/B parity check (`src/lib/sim/parity-check.ts`)** —
`runWorkerParityCheck(wires, controls, opts)` builds the same netlist,
hands it to both engines, advances them with the same dt sequence, and
returns a per-probe-node summary of disagreement.  Use this to verify
Rust on a real kit circuit before flipping the worker's default.

### Phase 3d usage

Opt into the Rust solver by sending an `engine: 'rust'` field with the
configure message.  From `Board.svelte` (or wherever the worker is owned):

```ts
worker.postMessage({
    type: 'configure',
    wires,
    controls,
    engine: 'rust',
});
worker.onmessage = (e) => {
    if (e.data.type === 'engineReady') {
        console.log('engine activated:', e.data.engine);
        // e.data.engine will be 'rust' if WASM init succeeded, else 'ts'.
    }
};
```

`updateControls` doesn't take an `engine` field — the engine is locked
at `configure` time.  Switching engines requires a full reconfigure.

### A/B parity check from a dev route

```ts
import { runWorkerParityCheck, formatParityReport } from '$lib/sim/parity-check';

// `wires` and `controls` from your dev fixture — same shape as the
// worker's configure message.
const report = await runWorkerParityCheck(wires, controls, {
    steps: 5000,
    dt: 1e-5,
});
console.log(formatParityReport(report));
```

The report sorts probe nodes descending by max disagreement.  Linear
sub-circuits should match to 1e-9; BJT-bearing transient sections drift
by O(1 V) (intrinsic to unconverged Newton — same limitation as the
`tests/parity_circuit.rs` BJT case).

### Phase 3d limitations (known)

1. **`updateControls` rebuilds Rust simulator.**  The Rust engine doesn't
   preserve transient state across recompiles — pot sweeps cause a brief
   audio glitch on each control change.  TS engine still hot-recompiles
   without losing state.  Hot-recompile for Rust is doable (capture
   `node_volts` + `cap_volts` + `inductor_currents`, rebuild Simulator,
   restore) but adds complexity; deferred to Phase 3d-cont if the glitches
   matter in practice.
2. **No startup-kick for Rust.**  Symmetric oscillators that the TS path
   kicks awake via a small random voltage will instead warm up over a few
   cycles on the Rust path.  Most kit projects use deliberately asymmetric
   bias and aren't affected.
3. **Relays still skipped.**  Projects using RL1 should keep the TS
   engine until Phase 3d-cont.
4. **No adaptive dt from Rust.**  `engine.step()` doesn't return a
   `recommendedDt`, so the worker keeps using its own dt heuristics.  TS
   path still benefits from LTE-based dt adjustment.

### Phase 3c additions

**Mutual inductance** — `Element::Coupling` and the
`coupling_group`/`coupling_polarity` fields on `Element::Inductor` together
implement the LT700 audio transformer (T1) and any other coupled-inductor
group from the kit.  `compile_netlist` builds an ordered pair list
`[i, j, M_ij, …]` per group with `M_ij = k · sqrt(Li · Lj) · si · sj`,
marks the off-diagonal positions into the sparsity pattern, and the step
function stamps:

```
matrix[branch_i, branch_j] −= M_coeff      (BE: M/dt; BDF-2: 3M/(2·dt))
rhs[branch_i]              −= M_rhs        (BE: M/dt · I_j;
                                           BDF-2: M/(2·dt) · (4·I_j − I_j_prev2))
```

Both orderings (a,b) and (b,a) are emitted so the matrix is symmetric
without a transpose pass.  This is the same algorithm as
`stepTransientNetlist` in `transient.ts`.

**Inductor saturation** — the `saturation_current_a` field is now used:
when `|I_prev| > i_sat`, the effective inductance drops to 1% of nominal
(simple two-state core-saturation model matching TS).

### Phase 3c parity coverage

`tests/parity_circuit.rs` now includes `transformer_step_response` —
two coupled inductors (k=0.5) with a 1V step on the primary, 100Ω load
on the secondary, sampled at 6 timesteps from 0 to 2ms.  Rust matches
TS to **1e-9** at every sample.  This is the critical proof that the
audio-transformer code path (T1 in the kit) will behave identically in
both implementations.

### Phase 3c usage

```ts
import { WasmTransientSimulator, initSimWasm } from '$lib/sim/transient-wasm';

await initSimWasm();

// Transformer circuits are now supported — buildSimulationNetlist
// expands T1 into individual inductors + coupling, all of which the
// Rust solver handles natively.
const netlist = buildSimulationNetlist(topology, KIT_COMPONENTS, opts);
const sim = WasmTransientSimulator.fromNetlist(netlist);

sim!.solveDc();                              // operating point
for (let i = 0; i < N; i++) {
    const r = sim!.stepBdf2(1e-6);
    if (!r.ok) break;
}
```

Relays still log a warning and are skipped at construction — projects
that use RL1 should keep using the TS solver until Phase 3c-cont.

### Phase 3b additions

**BDF-2 / Gear-2 integration** — `StepConfig::bdf2(dt)` switches the cap
and inductor companions to second-order BDF formulas:

```
cap:      g = 3C/(2·dt),   ieq = (C/(2·dt))·(4·V_prev − V_prev2)
inductor: coeff = 3L/(2·dt), rhs = (L/(2·dt))·(4·I_prev − I_prev2)
```

Falls back to BE on the first step (or after `solve_dc`) when there's no
usable history.  The `prev_*` history buffers in `TransientState` are
double-buffered via `std::mem::swap` to avoid allocation.

**Predictor warm-start** — once `state.gear2_ready` is set, Newton's
initial estimate is `est[i] = curr + clamp((curr - prev) * dt_ratio,
±PREDICTOR_CLIP)` for each node, extrapolating from the previous two
steps.  Saves 1-2 Newton iterations on every smooth-trajectory step.

**DC operating-point** — `solve_dc(c, state)` builds an MNA matrix with
caps open and inductors shorted, applies a transistor warm-start
(Vb≈0.6, Vc≈Vcc/2, Ve≈0 for NPN — PNP mirror), and runs 15 unclamped
Newton iterations.  Matches `dc.ts` exactly: same warm-start, same
fixed-iteration budget, same lack of damping.  After DC the state's
`gear2_ready` is cleared so the first transient step uses BE.

### Phase 3b parity coverage

`tests/parity_circuit.rs` now runs with **full TS defaults** (BDF-2 +
predictor enabled on both sides).  All four cases match to 1e-9:

- `rc_charging` — RC charging through 1kΩ to 1µF
- `rc_discharging` — pre-charged cap drains through 470Ω
- `rlc_underdamped` — V step through R-L-C oscillator
- `rl_step` — inductor current ramp via V/R

BJT DC operating-point parity: the dedicated `common_emitter_bjt_dc_via_solve_dc`
test verifies `solve_dc` matches TS `dc.ts` to 1e-6 on a divider-biased
common-emitter circuit (Vb=3.4478392641…).

**Why no BJT transient parity test:** Both implementations run unconverged
Newton iterates within the 20-iteration budget for BJT-bearing circuits
(the GMAX-clamped Gummel-Poon model has transient oscillation modes that
don't settle in 20 iters).  Floating-point operation ordering in the
sparse LU routes the unconverged iterate to slightly different basins
across implementations, giving O(1 V) per-step divergence.  This matches
TS's own behavior — `stepTransientNetlist` doesn't treat
non-convergence as an error; it commits the final iterate.  The kit's
oscillator circuits behave the same way and the audio output is
qualitatively identical between implementations; bit-exact BJT transient
parity would require matching TS's stamp/pivot order exactly.

### Phase 3b usage

```ts
import { WasmTransientSimulator, initSimWasm } from '$lib/sim/transient-wasm';

await initSimWasm();
const sim = WasmTransientSimulator.fromNetlist(netlist);

// Required for circuits with BJTs:
sim!.solveDc();

// BDF-2 transient (auto-falls back to BE on first step after DC):
for (let i = 0; i < N; i++) {
    const r = sim!.stepBdf2(1e-6);
    if (!r.ok) break;
}
const v = sim!.nodeVoltage(probeNodeId);
sim!.dispose();
```

### Parity verification

```bash
bun scripts/gen-stamp-parity.ts > rust/sim-core/tests/parity_stamps.rs
bun scripts/gen-circuit-parity.ts > rust/sim-core/tests/parity_circuit.rs
cd rust && cargo test    # 60 tests expected
```

### Whole-circuit cross-port parity

`tests/parity_circuit.rs` — autogenerated from TS via
`bun scripts/gen-circuit-parity.ts` — drives identical circuits through
both implementations and asserts node voltages match to within 1e-9 at
sampled timesteps.  Phase 3a covers: RC charging, RC discharging, RLC
underdamped, RL step response.  All four pass step-for-step.

The generator disables the TS-side predictor warm-start (resets
`gear2Ready=false` after each step) because Phase 3a Rust has no
predictor.  Phase 3b restores both and the fixture should be regenerated.

### Bug fixed during Phase 3a: cap-index off-diagonal in transient.ts

While building the parity fixture, the TS reference solver was returning
`singular-matrix` on a hand-built RC netlist.  Root cause: a real bug in
`compileNetlist`:

```ts
// BEFORE (buggy):
capStampIndices[i * 4 + 2] = ia >= 0 ? ia * size + ib : -1;
capStampIndices[i * 4 + 3] = ib >= 0 ? ib * size + ia : -1;
```

The off-diagonal index at `(ia, ib)` requires BOTH nodes non-grounded, but
the guards only checked one side.  For a ground-referenced cap with
`ia=1, ib=-1`, line 410 evaluated to `1*size + (-1) = 2` — a flat index
pointing at an unrelated cell.  When the cap stamp later did
`baseMatBuf[abIdx] -= g`, it silently corrupted whichever cell that
happened to be (in the test case: the V-source incidence at (0,2)).

```ts
// AFTER (fixed):
const off = ia >= 0 && ib >= 0;
capStampIndices[i * 4 + 2] = off ? ia * size + ib : -1;
capStampIndices[i * 4 + 3] = off ? ib * size + ia : -1;
```

The bug didn't crash the kit's actual circuits — real netlists rarely
have ground-referenced caps where the bogus index lands on a critical
cell, and the corruption was masked by gmin regularisation.  But the
math has been slightly off for any circuit with ground-referenced
capacitors.  The bench-steady benchmark shows no regression from the
fix.

### Parity verification

Re-run both generators after any change:

```bash
bun scripts/gen-stamp-parity.ts > rust/sim-core/tests/parity_stamps.rs
bun scripts/gen-circuit-parity.ts > rust/sim-core/tests/parity_circuit.rs
cd rust && cargo test
```

## Prerequisites

```bash
# 1. Rust toolchain (uses rust-toolchain.toml to pin the version)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 2. wasm-pack
cargo install wasm-pack

# (The wasm32 target is added automatically per rust-toolchain.toml.)
```

## Building

```bash
cd rust
./build.sh                 # release build for production
./build.sh profiling       # release + debug symbols (DevTools-readable)
./build.sh dev             # fast compile, slow runtime
```

Output lands in `src/lib/sim/wasm/`:

```
src/lib/sim/wasm/
├── sim_wasm.js          # ES module loader (wasm-bindgen glue)
├── sim_wasm.d.ts        # TypeScript types
└── sim_wasm_bg.wasm     # the WebAssembly binary
```

Vite picks these up automatically.  The build script overwrites the
hand-written stubs that ship in this repo (so type-checking works on a
fresh clone).

## Testing

```bash
cd rust
cargo test                 # host-side tests (no wasm toolchain needed)
cargo bench                # numeric kernel microbenchmarks (Phase 2+)
```

The host-side tests use plain Rust — no wasm-bindgen at runtime, no
browser, no wasm runtime needed.  They exercise the SAME code paths
that the wasm build will run.

Once the WASM build is in place, the browser-side parity script is at:

```
scripts/test-sparse-parity.ts
```

It runs the same test vectors through both the TS reference and the WASM
build, and asserts the outputs agree to within 1e-12.  See the comment
at the top of the file for how to invoke it.

## Project layout

```
rust/
├── Cargo.toml                 # workspace
├── rust-toolchain.toml        # pinned compiler version
├── build.sh                   # wasm-pack invocation
├── sim-core/                  # pure-Rust simulation kernels
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs
│   │   └── sparse.rs          # sparse LU, MD ordering
│   └── tests/
│       └── parity.rs          # cross-port integration tests
└── sim-wasm/                  # wasm-bindgen wrapper
    ├── Cargo.toml
    └── src/
        └── lib.rs             # JS-facing exports
```

`sim-core` is a pure Rust library with no foreign dependencies.  It can be
unit-tested and benchmarked with stock `cargo test` / `cargo bench`.

`sim-wasm` is the thin layer that exposes `sim-core` to JavaScript via
`wasm-bindgen`.  All the inter-language plumbing (typed-array marshalling,
opaque handles, etc) lives in this crate.  Pure Rust algorithms NEVER
depend on `wasm-bindgen` directly.

## Phase 1 design notes

### Why a workspace, why two crates?

Keeping the algorithm core (`sim-core`) free of wasm-bindgen means:

1. **Native testing.**  `cargo test` runs on the host CPU at full speed —
   no headless browser, no wasm runtime.  Test feedback in <1 second.
2. **Future-proofing.**  If we later want to ship a CLI test harness, a
   native bench tool, or even reuse the kernel from another project,
   `sim-core` is already a standalone library.
3. **Audit boundary.**  All the "unsafe by nature" code that touches the
   JS heap stays inside `sim-wasm`.  `sim-core` is plain safe Rust.

### Performance expectations

- Pattern compile (`analyzePattern`) runs once per netlist; speed
  irrelevant.
- `numericFactor` + `sparseSolveInPlace` are the hot Newton-iteration
  inner loops.  TS at ~50 k steps/sec; expect Rust at 100-150 k.  Real win
  is **predictability** — no JIT deopt, no GC pauses.
- `minimumDegreeOrder` runs once per compile — speed irrelevant.

### What's deliberately NOT done in Phase 1

- No SIMD intrinsics yet.  V8 already emits SSE2 for tight Float64Array
  loops; before we add `core::arch::wasm32::v128_*` we should measure.
- No `unsafe` `get_unchecked` in hot loops.  Profiling first.
- No `wee_alloc`.  Default allocator is fine until we measure pressure.

## Phase 2 plan

Port element types and stamp functions:

- `SimulationResistorElement`, `SimulationCapacitorElement`, … as Rust
  structs in `sim-core/src/types.rs`.
- `computeTransistorStamp` and `computeDiodeStamp` in `sim-core`.
- `compileNetlist` returning a `CompiledNetlist` struct.

At the end of Phase 2 the WASM module can take a netlist JSON, compile it,
and stamp transistor/diode contributions — but the Newton outer loop still
runs in TypeScript.  Parity test: build the same circuit through both
paths, compare matrices position-by-position after stamping.

## Phase 3 plan

Move `stepTransientNetlist` into Rust.  After Phase 3, the worker calls a
single `simulator.step(dt)` function across the wasm boundary; the TS
solver is removed.

## Phase 4 plan

AudioWorklet hosting.  The simulator runs **inside** `process()`, advances
exactly 128 samples of sim time per audio quantum, writes samples directly
into the output buffer.  No buffer pipeline, no message-passing.  Latency
drops from ~20 ms to ~2.67 ms (one quantum).

This is the architectural fix the trace data has been pointing at all
along.
