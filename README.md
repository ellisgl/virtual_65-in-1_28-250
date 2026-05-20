# Rust NaN-detection v2 — covers solve_dc too

## What's new vs v1
v1 added NaN guards to `step_with_config` only.  The siren still produced
NaN after applying v1 because `solve_dc` *also* commits NaN when its LU
solve goes near-singular.  The worklet's recovery path on step failure
is to call `solve_dc` → which produced more NaN → which made the next
step fail → infinite loop.

v2 adds matching NaN guards to `solve_dc`.

## Building WASM
The Rust simulator code is included as a git submodule in the `rust/` directory.

### Initial Setup
If you just cloned this repository, you'll need to initialize the submodule:
```bash
git submodule update --init --recursive
```

### Building
To rebuild the WASM binary and update the artifacts in `static/audio/`:
```bash
bun run wasm:build
```
This requires `wasm-pack` to be installed on your system.

### Verification
To verify the fix is deployed, hard-reload the browser tab (Ctrl+Shift+R / Cmd+Shift+R) to force the browser to drop its cached WASM.

## Expected log after rebuild
For the siren, simNaN counts should drop dramatically — from ~135 000/sec
to under ~1 000/sec (or zero).  The audio chain output should be a clean
sustained tone for the full key-hold duration.

If you STILL see simNaN > 50 000/sec, then either:
  - The rebuild didn't actually run (check timestamps above)
  - There's a third NaN source we haven't found, and we need to dig further
