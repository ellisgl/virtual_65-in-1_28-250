# Rust NaN-detection v2 — covers solve_dc too

## What's new vs v1
v1 added NaN guards to `step_with_config` only.  The siren still produced
NaN after applying v1 because `solve_dc` *also* commits NaN when its LU
solve goes near-singular.  The worklet's recovery path on step failure
is to call `solve_dc` → which produced more NaN → which made the next
step fail → infinite loop.

v2 adds matching NaN guards to `solve_dc`.

## CRITICAL: you must rebuild the wasm
This fix is a Rust change.  Replacing `transient.rs` alone does NOTHING
to the running browser — the wasm binary in `static/audio/sim_wasm_bg.wasm`
and `src/lib/sim/wasm/sim_wasm_bg.wasm` was compiled before this change.

To verify the fix is deployed:

```bash
cd path/to/project/rust
# 1. Confirm tests pass (verifies the .rs file is updated)
cargo test -p sim-core --lib transient::nan_in_state_is_caught_not_committed
# Expected: "test transient::tests::nan_in_state_is_caught_not_committed ... ok"

# 2. Rebuild the wasm binary
./build.sh

# 3. Compare timestamps to confirm rebuild happened
ls -la ../static/audio/sim_wasm_bg.wasm
ls -la ../src/lib/sim/wasm/sim_wasm_bg.wasm
# Both should have just-now timestamps.
```

Then hard-reload the browser tab (Ctrl+Shift+R / Cmd+Shift+R, NOT regular
reload) to force Chrome to drop its cached wasm.

## Expected log after rebuild
For the siren, simNaN counts should drop dramatically — from ~135 000/sec
to under ~1 000/sec (or zero).  The audio chain output should be a clean
sustained tone for the full key-hold duration.

If you STILL see simNaN > 50 000/sec, then either:
  - The rebuild didn't actually run (check timestamps above)
  - There's a third NaN source we haven't found, and we need to dig further
