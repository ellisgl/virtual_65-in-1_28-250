/**
 * Cross-port parity fixture generator — whole-circuit version.
 *
 * Builds small representative circuits in TypeScript, runs them through
 * the TS reference transient solver with backward-Euler, dumps the node
 * voltages at intermediate timesteps as a Rust source file.  The Rust
 * port then builds the same circuit, runs the same steps, and asserts
 * every sampled state matches to within 1e-9.
 *
 * Scope (Phase 3a): RC and RLC circuits — no BJT/diode, because cold-
 * start of nonlinear elements requires the DC operating-point solve that
 * Phase 3b ports.  The BJT and diode stamps themselves are independently
 * parity-tested in tests/parity_stamps.rs.
 *
 * Run with:
 *   bun scripts/gen-circuit-parity.ts > rust/sim-core/tests/parity_circuit.rs
 */

import { compileNetlist, initializeTransientState, stepTransientNetlist } from '$lib/sim/transient';
import type { SimulationNetlist } from '$lib/types';

interface Case {
    name: string;
    /** Human-readable description for the Rust test name. */
    description: string;
    /** Build the netlist.  Returns netlist + the topology-node ID to probe. */
    build: () => { netlist: SimulationNetlist; probe_nodes: number[] };
    /** Timestep (seconds). */
    dt: number;
    /** Total steps to run. */
    n_steps: number;
    /** Capture node voltages at these step indices (0 = after first step). */
    sample_steps: number[];
}

const cases: Case[] = [
    {
        name: 'rc_charging',
        description: 'RC charging: 5V → 1kΩ → 1µF → ground, sampled across 5τ',
        dt: 1e-6,
        n_steps: 5_000,
        sample_steps: [0, 100, 500, 1_000, 2_000, 4_999],
        build: () => ({
            netlist: {
                groundNodeId: 0,
                elements: [
                    { type: 'voltage-source', componentId: 'V1',
                        positiveNode: 1, negativeNode: 0, voltage: 5.0 },
                    { type: 'resistor', componentId: 'R1',
                        nodes: [1, 2], resistanceOhms: 1_000.0 },
                    { type: 'capacitor', componentId: 'C1',
                        nodes: [2, 0], capacitanceFarads: 1e-6, initialVoltage: 0.0 },
                ],
                unsupported: [],
            },
            probe_nodes: [1, 2],
        }),
    },
    {
        name: 'rc_discharging',
        description: 'RC discharge: cap pre-charged to 3V, drains through 470Ω',
        dt: 1e-6,
        n_steps: 3_000,
        sample_steps: [0, 100, 500, 1_500, 2_999],
        build: () => ({
            netlist: {
                groundNodeId: 0,
                elements: [
                    { type: 'resistor', componentId: 'R1',
                        nodes: [1, 0], resistanceOhms: 470.0 },
                    { type: 'capacitor', componentId: 'C1',
                        nodes: [1, 0], capacitanceFarads: 1e-6, initialVoltage: 3.0 },
                ],
                unsupported: [],
            },
            probe_nodes: [1],
        }),
    },
    {
        name: 'rlc_underdamped',
        description: 'RLC underdamped: V step → R → L → C, oscillates',
        dt: 5e-7,
        n_steps: 4_000,
        sample_steps: [0, 50, 200, 500, 1_000, 2_000, 3_999],
        build: () => ({
            netlist: {
                groundNodeId: 0,
                elements: [
                    { type: 'voltage-source', componentId: 'V1',
                        positiveNode: 1, negativeNode: 0, voltage: 5.0 },
                    { type: 'resistor', componentId: 'R1',
                        nodes: [1, 2], resistanceOhms: 10.0 },
                    { type: 'inductor', componentId: 'L1',
                        nodes: [2, 3], inductanceHenry: 1e-3 },
                    { type: 'capacitor', componentId: 'C1',
                        nodes: [3, 0], capacitanceFarads: 1e-7, initialVoltage: 0.0 },
                ],
                unsupported: [],
            },
            probe_nodes: [2, 3],
        }),
    },
    {
        name: 'rl_step',
        description: 'RL step response: L current builds up to V/R',
        dt: 1e-6,
        n_steps: 5_000,
        sample_steps: [0, 100, 500, 1_500, 4_999],
        build: () => ({
            netlist: {
                groundNodeId: 0,
                elements: [
                    { type: 'voltage-source', componentId: 'V1',
                        positiveNode: 1, negativeNode: 0, voltage: 1.0 },
                    { type: 'resistor', componentId: 'R1',
                        nodes: [1, 2], resistanceOhms: 100.0 },
                    { type: 'inductor', componentId: 'L1',
                        nodes: [2, 0], inductanceHenry: 1e-3 },
                ],
                probe_nodes: [2],
            } as unknown as SimulationNetlist,
            probe_nodes: [2],
        }),
    },
];

function rustFloat(n: number): string {
    if (!Number.isFinite(n)) return n > 0 ? 'f64::INFINITY' : 'f64::NEG_INFINITY';
    return n.toString().includes('.') || n.toString().includes('e')
        ? `${n.toString()}_f64`
        : `${n}.0_f64`;
}

let out = '';
out += '// AUTOGENERATED by `bun scripts/gen-circuit-parity.ts` — do not edit by hand.\n';
out += '//\n';
out += '// Each test builds a small circuit in Rust identical to one driven through\n';
out += '// the TypeScript reference solver, runs the same number of backward-Euler\n';
out += '// steps with the same dt, and asserts node voltages match TS to within 1e-9\n';
out += '// at every sampled step.\n\n';
out += 'use sim_core::compile::compile_netlist;\n';
out += 'use sim_core::netlist::{Element, Netlist};\n';
out += 'use sim_core::transient::{step, TransientState};\n\n';
out += 'const TOL: f64 = 1e-9;\n\n';

for (const tc of cases) {
    const { netlist, probe_nodes } = tc.build();
    const compiled = compileNetlist(netlist)!;
    let state = initializeTransientState(compiled);

    // Run TS simulation, capturing samples.
    const samples: { step: number; volts: Record<number, number> }[] = [];
    const sampleSet = new Set(tc.sample_steps);
    for (let i = 0; i < tc.n_steps; i++) {
        const r = stepTransientNetlist(netlist, state, { dt: tc.dt, gear: 1 }, compiled);
        if (!r.ok) {
            console.error(`TS solver failed at step ${i} for case ${tc.name}: ${JSON.stringify(r.issue)}`);
            process.exit(1);
        }
        state = r.state;
        if (sampleSet.has(i)) {
            const volts: Record<number, number> = {};
            for (const nodeId of probe_nodes) {
                const idx = compiled.nodeIndex.get(nodeId);
                if (idx !== undefined) volts[nodeId] = state.nodeVolts[idx];
            }
            samples.push({ step: i, volts });
        }
    }

    // Emit the Rust test.
    out += `/// ${tc.description}\n`;
    out += `#[test]\nfn ${tc.name}() {\n`;
    out += `    let mut nl = Netlist::new(0);\n`;
    for (const el of netlist.elements) {
        if (el.type === 'voltage-source') {
            out += `    nl.push(Element::VoltageSource {\n`;
            out += `        id: "${el.componentId}".into(),\n`;
            out += `        positive_node: ${el.positiveNode}, negative_node: ${el.negativeNode},\n`;
            out += `        voltage: ${rustFloat(el.voltage)},\n`;
            out += `    });\n`;
        } else if (el.type === 'resistor') {
            out += `    nl.push(Element::Resistor {\n`;
            out += `        id: "${el.componentId}".into(),\n`;
            out += `        a: ${el.nodes[0]}, b: ${el.nodes[1]},\n`;
            out += `        resistance_ohms: ${rustFloat(el.resistanceOhms)},\n`;
            out += `    });\n`;
        } else if (el.type === 'capacitor') {
            out += `    nl.push(Element::Capacitor {\n`;
            out += `        id: "${el.componentId}".into(),\n`;
            out += `        a: ${el.nodes[0]}, b: ${el.nodes[1]},\n`;
            out += `        capacitance_farads: ${rustFloat(el.capacitanceFarads)},\n`;
            out += `        initial_voltage: ${rustFloat(el.initialVoltage)},\n`;
            out += `    });\n`;
        } else if (el.type === 'inductor') {
            out += `    nl.push(Element::Inductor {\n`;
            out += `        id: "${el.componentId}".into(),\n`;
            out += `        a: ${el.nodes[0]}, b: ${el.nodes[1]},\n`;
            out += `        inductance_henry: ${rustFloat(el.inductanceHenry)},\n`;
            out += `        saturation_current_a: None,\n`;
            out += `    });\n`;
        } else {
            console.error(`unsupported element type in fixture: ${el.type}`);
            process.exit(1);
        }
    }
    out += '\n';
    out += `    let mut c = compile_netlist(&nl).unwrap();\n`;
    out += `    let mut s = TransientState::new(&c);\n`;
    for (const nodeId of probe_nodes) {
        out += `    let idx_${nodeId} = *c.node_index.get(&${nodeId}).unwrap();\n`;
    }
    out += '\n';

    let prev = 0;
    for (const sample of samples) {
        const stepsToRun = sample.step + 1 - prev;
        out += `    // Run ${stepsToRun} step${stepsToRun === 1 ? '' : 's'} to reach step index ${sample.step}.\n`;
        out += `    for _ in 0..${stepsToRun} {\n`;
        out += `        step(&mut c, &mut s, ${rustFloat(tc.dt)}).unwrap();\n`;
        out += `    }\n`;
        for (const nodeId of probe_nodes) {
            const v = sample.volts[nodeId];
            out += `    assert!((s.node_volts[idx_${nodeId}] - ${rustFloat(v)}).abs() < TOL,\n`;
            out += `        "step ${sample.step}, node ${nodeId}: {} vs ${rustFloat(v)}",\n`;
            out += `        s.node_volts[idx_${nodeId}]);\n`;
        }
        prev = sample.step + 1;
        out += '\n';
    }
    out += `}\n\n`;
}

console.log(out);
