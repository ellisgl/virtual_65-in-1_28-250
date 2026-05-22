# CdS photoresistor (LDR1) — implementation

## What this adds
Support for the kit's CdS photoresistor as a new component kind.
Two-terminal element on board terminals **66, 67**.  Resistance is
controlled by a "Light level" slider in the toolbar:
* 0% (dark)   → **350 MΩ**
* 100% (bright) → **50 Ω**
* Mapped via log-linear interpolation, matching the decade-per-log-lux
  response of a real CdS cell.  At 50% you get the geometric mean,
  ~132 kΩ — not the arithmetic mean (which would be dominated by the
  much larger dark value).

No Rust-side changes needed.  The CdS emits as a plain resistor element
which `rust-e-sim-core` already handles.  No wasm rebuild required.

## What's in this package

Drop-in replacements for five files (no new files except the demo
script):

* `src/lib/types.ts` — adds `'cds'` to the `ComponentKind` union.
* `src/lib/data/components.ts` — adds the `LDR1` catalog entry.
* `src/lib/sim/netlist.ts` — adds the `'cds'` element-emission handler.
* `src/lib/components/Board.svelte` — adds `lightLevel` state, plumbs it
  through `currentControls()`, and renders a "LDR1 light" slider in the
  toolbar (next to the Run / Save / Load buttons).
* `src/lib/components/board/BoardDebugPanels.svelte` — adds matching
  `lightLevel` / `hasPhotoresistor` / `onLightLevelChange` props
  (forward-compatible; this file isn't currently mounted but the props
  are wired so adopting it later requires no further changes).

Plus:

* `scripts/cds-demo.ts` — runnable verification:
  `bun scripts/cds-demo.ts` will sweep the light level from 0 → 1 and
  print the emitted resistance at each step, comparing to the expected
  log-linear curve.  Also runs a negative test ensuring missing
  `lightResistance` metadata is reported as unsupported.
* `patches/*.patch` — unified diffs for each changed file, for review.

## Apply

```bash
tar xzf cds-impl.tar.gz -C path/to/your-svelte-project/
# No rebuild needed — drop in, hard-reload the page.
bun scripts/cds-demo.ts   # optional verification
```

## Behaviour notes

* **First-load default**: half-light (position 0.5 ≈ 132 kΩ).  The
  catalog's `metadata.defaultPosition` controls this — change there to
  shift the start state without touching code.
* **The 7-million-to-one dynamic range** (50 Ω → 350 MΩ) is wide but
  numerically safe for the sparse-LU solver — well under the ~12-order
  precision ceiling of f64 with realistic conductance scaling.  Mixed
  with the other kit components (R1 = 100 Ω, R10 = 220 kΩ, etc.) the
  MNA stays well-conditioned.
* **Slider is global** — affects every circuit that includes terminals
  66 and 67 in the wired topology.  If a circuit doesn't include LDR1,
  the slider has no effect (the element is built but the node is
  floating, which the builder skips).
* **No physical knob on the kit board** — that's why the control lives
  in the toolbar rather than as an SVG overlay knob.  The real kit's
  CdS responds to ambient light from the room; this slider is the
  simulator's stand-in.

## Suggested first test circuit

The kit's manual will have a "light-controlled" circuit using LDR1 —
probably as a base-current setter for Q3 (NPN) so that the speaker
buzzes when the room goes dark, or vice versa.  Wire that up, click
Run, then sweep the LDR1 light slider — you should hear the buzz
appear/disappear at the trigger threshold.
