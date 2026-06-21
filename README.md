# Virtual Science Fair 65-in-1 Electronic Project Kit (Cat# 28-250)

A browser-based circuit simulator for the classic Radio Shack spring-terminal 65-in-1 kit. I'm dedicating this to my Father, who was electronics engineer and hobbyist till the end.

**[Try it live →](https://ellisgl.github.io/virtual_65-in-1_28-250/)**

## Project manual

The original RadioShack / Science Fair 65-in-1 manual lists all 65 projects with circuit diagrams and terminal connections:

**[65-in-1 Manual (Radio Shack Catalogs) →](https://www.radioshackcatalogs.com/flipbook/m-science_fair_kits_65-in-1_electronic_project_kit_28-250.html)**

## Related

- **[rust-e-sim](https://github.com/ellisgl/rust-e-sim)** — the Rust/WASM SPICE-style circuit solver that powers the simulation

## How it works

- Click terminal dots on the board to wire up circuits — matching the project connections in the manual
- Press **Run** to start the real-time SPICE-style simulation; audio plays through your speakers or earphone terminals
- Drag the on-board **VR1** and **VC1** knobs to adjust variable components
- Use **Save wires / Load wires** to save and restore circuit configurations as plain-text files
- Click **? Help** in the toolbar for more usage details

## Requirements

- [Bun](https://bun.sh/) 1.3+

## Quick Start

```bash
bun install
bun run dev
```

Then open the local URL shown by Vite.

## Commands

```bash
bun run check    # type-check
bun run lint     # lint
bun run build    # production build
bun run preview  # preview production build
```

## Architecture

### Data layer

| File | Purpose |
|------|---------|
| `src/lib/types.ts` | Shared TypeScript types |
| `src/lib/data/components.ts` | 65-in-1 part catalog (terminals, values, model metadata) |
| `src/lib/data/terminalPositions.ts` | Spring terminal coordinates in board SVG space (`viewBox 0 0 437 267`) |

### Simulation layer

| File | Purpose |
|------|---------|
| `src/lib/sim/topology.ts` | Wire-union → node graph |
| `src/lib/sim/netlist.ts` | Topology → SPICE-style element list |
| `src/lib/sim/sim-rust-worklet-host.ts` | Main-thread host for the audio worklet |
| `static/audio/sim-rust-worklet.js` | AudioWorklet — runs the WASM solver on the audio thread |
| `static/audio/sim_wasm_bg.wasm` | Compiled Rust solver ([rust-e-sim](https://github.com/ellisgl/rust-e-sim)) |

### Terminal placement (Inkscape workflow)

1. Open `graphics/65-in-1_new.svg` in Inkscape (viewBox `0 0 437 267`)
2. Place a temporary circle centered on a spring terminal and read its `X, Y` coordinates
3. Update `TERMINAL_POSITIONS[id]` in `terminalPositions.ts`
4. Run `bun run check && bun run dev` to verify alignment

```bash
bun run terminals:status   # mapping progress
bun run terminals:check    # strict mode — fails if any terminal is unmapped
```
