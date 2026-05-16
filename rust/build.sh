#!/usr/bin/env bash
# Build the WASM module for the SvelteKit app.
#
# Output: ../src/lib/sim/wasm/  containing
#   - sim_wasm.js      (wasm-bindgen JS glue, ES module)
#   - sim_wasm_bg.wasm (the wasm binary)
#   - sim_wasm.d.ts    (TypeScript types)
#
# Vite picks this up automatically — see src/lib/sim/sparse-wasm.ts for the
# import side.  For AudioWorklet hosting (Phase 4) we'll also build a
# `--target no-modules` variant since AudioWorklet doesn't support `import`.
#
# Prerequisites:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-pack    (or use the installer at rustwasm.github.io)
#
# The Rust toolchain version is pinned in rust-toolchain.toml so everyone
# building this gets the same compiler.

set -euo pipefail
cd "$(dirname "$0")"

PROFILE="${1:-release}"

case "$PROFILE" in
    release)
        echo "Building sim-wasm (release)..."
        wasm-pack build sim-wasm \
            --release \
            --target web \
            --out-name sim_wasm \
            --out-dir "../../src/lib/sim/wasm"
        ;;
    profiling)
        echo "Building sim-wasm (profiling — release optimisations + debug symbols)..."
        wasm-pack build sim-wasm \
            --profiling \
            --target web \
            --out-name sim_wasm \
            --out-dir "../../src/lib/sim/wasm"
        ;;
    dev)
        echo "Building sim-wasm (dev — fast compile, slow runtime)..."
        wasm-pack build sim-wasm \
            --dev \
            --target web \
            --out-name sim_wasm \
            --out-dir "../../src/lib/sim/wasm"
        ;;
    *)
        echo "usage: $0 [release|profiling|dev]"
        exit 1
        ;;
esac

# wasm-pack writes a package.json into the out-dir that Vite doesn't need;
# leaving it doesn't hurt but it confuses some auditing tools.
rm -f ../src/lib/sim/wasm/package.json ../src/lib/sim/wasm/.gitignore || true

echo "Done.  Built artifacts:"
ls -la ../src/lib/sim/wasm/
