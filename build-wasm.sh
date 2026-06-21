#!/usr/bin/env bash
# build-wasm.sh — Build the rust-e-sim WASM and copy outputs to the right places.
#
# Usage:
#   ./build-wasm.sh              # build with current submodule commit
#   ./build-wasm.sh --update     # pull latest from GitHub first, then build
#   ./build-wasm.sh --debug      # build debug (unoptimised) WASM, faster
#   ./build-wasm.sh --help       # show this help
#
# Destinations (both are updated on every build):
#   static/audio/                -- audio worklet loads these at runtime via fetch
#     sim_wasm.js
#     sim_wasm_bg.wasm
#
#   src/lib/sim/wasm/            -- Vite/main-thread code imports these
#     sim_wasm.js
#     sim_wasm_bg.wasm
#     sim_wasm.d.ts
#     sim_wasm_bg.wasm.d.ts
#
# Prerequisites:
#   cargo / rustup  — https://rustup.rs/
#   wasm-pack       — https://rustwasm.github.io/wasm-pack/
#                     (installed automatically if missing via cargo)
#
# The Rust source lives in the `rust/` git submodule:
#   https://github.com/ellisgl/rust-e-sim
# Run `git submodule update --init rust/` to populate it the first time.

set -euo pipefail

# ─── Paths ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$SCRIPT_DIR/rust"
WASM_CRATE="$RUST_DIR/rust-e-sim-wasm"
PKG_DIR="$WASM_CRATE/pkg"
STATIC_AUDIO="$SCRIPT_DIR/static/audio"
LIB_WASM="$SCRIPT_DIR/src/lib/sim/wasm"

# ─── Colour helpers ───────────────────────────────────────────────────────────
if [ -t 1 ]; then
    GRN='\033[0;32m'; YLW='\033[1;33m'; RED='\033[0;31m'; BLD='\033[1m'; NC='\033[0m'
else
    GRN=''; YLW=''; RED=''; BLD=''; NC=''
fi
log()  { echo -e "${GRN}[build-wasm]${NC} $1"; }
warn() { echo -e "${YLW}[build-wasm] warning:${NC} $1"; }
err()  { echo -e "${RED}[build-wasm] error:${NC} $1" >&2; }
step() { echo -e "\n${BLD}── $1 ──${NC}"; }

# ─── Args ─────────────────────────────────────────────────────────────────────
OPT_UPDATE=0
OPT_DEBUG=0

for arg in "$@"; do
    case "$arg" in
        --update) OPT_UPDATE=1 ;;
        --debug)  OPT_DEBUG=1  ;;
        --help|-h)
            sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            err "Unknown argument: $arg  (run with --help for usage)"
            exit 1
            ;;
    esac
done

# ─── 1. Prerequisites ─────────────────────────────────────────────────────────
step "Checking prerequisites"

if ! command -v cargo &>/dev/null; then
    err "cargo not found.  Install Rust via https://rustup.rs/ then re-run."
    exit 1
fi
log "cargo: $(cargo --version)"

# wasm32-unknown-unknown target required
if ! rustup target list --installed 2>/dev/null | grep -q "wasm32-unknown-unknown"; then
    warn "wasm32-unknown-unknown target not installed — adding..."
    rustup target add wasm32-unknown-unknown
fi

# wasm-pack
if ! command -v wasm-pack &>/dev/null; then
    warn "wasm-pack not found — installing (this may take a minute)..."
    cargo install wasm-pack
fi
log "wasm-pack: $(wasm-pack --version)"

# ─── 2. Submodule ─────────────────────────────────────────────────────────────
step "Rust submodule"

cd "$SCRIPT_DIR"

if [ ! -f "$WASM_CRATE/Cargo.toml" ]; then
    log "Submodule not yet initialised — running git submodule update --init rust/"
    git submodule update --init --recursive rust/
else
    log "Submodule present at: $RUST_DIR"
    CURRENT_SHA=$(git -C "$RUST_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
    log "Current commit: $CURRENT_SHA"
fi

if [ "$OPT_UPDATE" -eq 1 ]; then
    log "Pulling latest from remote (--update)..."
    git submodule update --remote --merge rust/
    NEW_SHA=$(git -C "$RUST_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
    log "Updated to: $NEW_SHA"
fi

# ─── 3. WASM build ────────────────────────────────────────────────────────────
step "Building WASM"

BUILD_FLAGS=""
if [ "$OPT_DEBUG" -eq 0 ]; then
    BUILD_FLAGS="--release"
    log "Mode: release (use --debug for a faster unoptimised build)"
else
    warn "Mode: debug (unoptimised — do not use for production)"
fi

cd "$WASM_CRATE"
log "Running: wasm-pack build --target web $BUILD_FLAGS --out-name sim_wasm --out-dir pkg"
wasm-pack build \
    --target web \
    $BUILD_FLAGS \
    --out-name sim_wasm \
    --out-dir pkg

# ─── 4. Copy outputs ──────────────────────────────────────────────────────────
step "Copying build outputs"

# Helper: copy with size report
copy_file() {
    local src="$1"
    local dst_dir="$2"
    local dst="$dst_dir/$(basename "$src")"
    if [ ! -f "$src" ]; then
        err "Expected file not found after build: $src"
        exit 1
    fi
    mkdir -p "$dst_dir"
    cp "$src" "$dst"
    SIZE=$(du -h "$dst" | cut -f1)
    log "  ✓  $dst  ($SIZE)"
}

# static/audio/ — fetched directly by the browser, not processed by Vite
log "→ static/audio/"
copy_file "$PKG_DIR/sim_wasm.js"           "$STATIC_AUDIO"
copy_file "$PKG_DIR/sim_wasm_bg.wasm"      "$STATIC_AUDIO"

# src/lib/sim/wasm/ — imported by Vite-bundled main-thread code
log "→ src/lib/sim/wasm/"
copy_file "$PKG_DIR/sim_wasm.js"           "$LIB_WASM"
copy_file "$PKG_DIR/sim_wasm_bg.wasm"      "$LIB_WASM"
copy_file "$PKG_DIR/sim_wasm.d.ts"         "$LIB_WASM"
# sim_wasm_bg.wasm.d.ts — generated by newer wasm-pack; copy if present
if [ -f "$PKG_DIR/sim_wasm_bg.wasm.d.ts" ]; then
    copy_file "$PKG_DIR/sim_wasm_bg.wasm.d.ts" "$LIB_WASM"
fi

# ─── 5. Summary ───────────────────────────────────────────────────────────────
step "Done"
WASM_SIZE=$(du -h "$STATIC_AUDIO/sim_wasm_bg.wasm" | cut -f1)
log "WASM binary: $WASM_SIZE"
log "To start the dev server: npm run dev  (or pnpm / yarn / bun)"
