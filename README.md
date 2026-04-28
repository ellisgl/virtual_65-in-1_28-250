# Virtual Science Fair 65 In 1 Electronic Project Kit (Cat# 28-250)

A web-based simulator inspired by the classic Radio Shack spring-terminal electronics kit.

## Status

Work in progress. The current focus is building the board data layer and interactive wiring POC.

## Requirements

- [Bun](https://bun.sh/) 1.3+

## Quick Start (Bun)

```bash
bun install
bun run dev
```

Then open the local URL shown by Vite.

## Useful Commands

```bash
bun run check
bun run lint
bun run build
bun run preview
```

## Project Goal (POC)

- Drag wires between spring terminals
- Free-form wiring using the kit part list
- Real-time simulation with SPICE-like device models where possible
- Audio output support for speaker circuits

## Data Layer

Core simulator data currently lives in these files:

- `src/lib/types.ts` - shared TypeScript types used by component and terminal data
- `src/lib/data/components.ts` - canonical 65-in-1 part catalog (terminals, values, model metadata)
- `src/lib/data/terminalPositions.ts` - spring terminal coordinates in board SVG space (`viewBox 0 0 387 267`)
- `src/lib/data/index.ts` - barrel exports for data modules

### Editing Workflow

1. Add or update part definitions in `src/lib/data/components.ts`.
2. Measure spring positions from `graphics/65-in-1_new.svg` and update `src/lib/data/terminalPositions.ts`.
3. Run checks:

```bash
bun run check
```

4. Validate in the app:

```bash
bun run dev
```

### Terminal Placement Guide (Inkscape)

Use this workflow to place spring terminal coordinates into `src/lib/data/terminalPositions.ts`.

1. Open `graphics/65-in-1_new.svg` in Inkscape.
2. Confirm document viewBox is `0 0 387 267` (the app uses this coordinate space directly).
3. Enable snapping and place a temporary circle marker centered on a spring terminal.
4. Read the marker center coordinates (`X`, `Y`) from Inkscape's tool controls.
5. Copy those numbers into `TERMINAL_POSITIONS[terminalId]` as `{ x, y }`.
6. Repeat for each terminal ID present in `KIT_TERMINAL_IDS`.

Coordinate rules:

- Keep units in SVG/viewBox space (do not convert to pixels).
- Use top-left origin coordinates as reported by Inkscape.
- Keep unmapped terminals as `{ x: -1, y: -1 }` until measured.
- Use decimal values when needed for precise alignment.

Example:

```ts
TERMINAL_POSITIONS[1] = { x: 24.5, y: 38.2 };
TERMINAL_POSITIONS[2] = { x: 42.1, y: 38.2 };
```

Quick verification loop:

```bash
bun run check
bun run dev
```

Then visually confirm the interactive hotspot aligns with each spring center in the running app.

Quick progress command:

```bash
bun run terminals:status
```

Strict mode (fails if any terminal is still unmapped):

```bash
bun run terminals:check
```

List available section names:

```bash
bun run terminals:sections
```

Show progress for one section:

```bash
bun scripts/terminals-status.ts --section "Resistors"
```

## Topology Layer (Next Step)

The app now derives a circuit topology from your wire connections in real time.

- Builder: `src/lib/sim/topology.ts`
- Store access: `src/lib/stores/wires.svelte.ts` via `wiresStore.topology`
- UI debug panel: `src/lib/components/Board.svelte`

`CircuitTopology` output includes:

- node groups (terminal IDs merged by wire unions)
- terminal-to-node map
- component pin-to-node bindings
- connected node IDs
- inferred ground node (from battery negative terminal metadata)

Topology demo harness:

```bash
bun run topology:demo
```

## Runtime Netlist Layer

The project now includes a first runtime netlist compiler that transforms topology into solver-ready elements.

- Compiler: `src/lib/sim/netlist.ts`
- Current compiled types: `resistor`, `voltage-source` (battery)
- Unsupported parts are reported explicitly with reasons

Runtime demo harness:

```bash
bun run runtime:demo
```

## DC Solver Layer

A minimal linear DC solver is now available for compiled runtime netlists.

- Solver: `src/lib/sim/dc.ts`
- Method: Modified nodal analysis + Gaussian elimination
- Current scope: resistors and battery voltage sources

Run demo:

```bash
bun run dc:demo
```

## Transient Step Layer

Capacitors are now compiled into the runtime netlist and a minimal transient stepper is available.

- Compiler support: `capacitor`, `variable-capacitor`
- Stepper: `src/lib/sim/transient.ts`
- Method: backward-Euler capacitor companion model

Board UI: live transient controls plus adjustable `VC1` variable capacitor slider

Debug UI: capacitor charge/voltage state panel

Run RC step demo:

```bash
bun run transient:demo
```

Ground-terminal policy is centralized in:

- `src/lib/sim/config.ts` (`GROUND_TERMINAL_IDS`)
