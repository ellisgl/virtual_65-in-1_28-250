/**
 * P18-Siren diagnostic: traces DC operating points and transient behavior
 * for both KEY open and KEY closed to identify the rumble/silence bug.
 *
 * Run: bun scripts/siren-debug.ts
 */
import { KIT_COMPONENTS } from '../src/lib';
import {
	buildCircuitTopology,
	buildSimulationNetlist,
	solveDcNetlist,
	compileNetlist,
	initializeTransientState,
	stepTransientNetlist
} from '../src/lib';
import type { Wire } from '../src/lib';

// P18-Siren wiring (from Circuits/P18-Siren.txt)
function makeWires(keyOpen: boolean): Wire[] {
	const wires: Wire[] = [
		{ id: 'w1',  fromTerminal: 13, toTerminal: 34, color: 'red' },
		{ id: 'w2',  fromTerminal: 15, toTerminal: 35, color: 'red' },
		{ id: 'w3',  fromTerminal: 16, toTerminal: 18, color: 'red' },
		{ id: 'w4',  fromTerminal: 16, toTerminal: 52, color: 'red' },
		{ id: 'w5',  fromTerminal: 17, toTerminal: 34, color: 'red' },
		{ id: 'w6',  fromTerminal: 26, toTerminal: 52, color: 'red' },
		{ id: 'w7',  fromTerminal: 27, toTerminal: 47, color: 'red' },
		{ id: 'w8',  fromTerminal: 32, toTerminal: 35, color: 'red' },
		{ id: 'w9',  fromTerminal: 33, toTerminal: 47, color: 'red' },
		{ id: 'w10', fromTerminal: 35, toTerminal: 54, color: 'red' },
		{ id: 'w11', fromTerminal: 46, toTerminal: 53, color: 'red' },
		{ id: 'w12', fromTerminal: 32, toTerminal: 87, color: 'red' },
		{ id: 'w13', fromTerminal: 48, toTerminal: 86, color: 'red' },
		{ id: 'w14', fromTerminal: 53, toTerminal: 82, color: 'red' },
		{ id: 'w15', fromTerminal: 83, toTerminal: 14, color: 'red' },
		{ id: 'w16', fromTerminal: 32, toTerminal: 91, color: 'red' },
		{ id: 'w17', fromTerminal: 90, toTerminal: 33, color: 'red' },
	];
	// KEY1 pressed = 82-83 connected
	if (!keyOpen) {
		wires.push({ id: 'wKey', fromTerminal: 82, toTerminal: 83, color: 'blue' });
	}
	return wires;
}

function nodeLabel(topology: ReturnType<typeof buildCircuitTopology>, terminal: number): string {
	const nodeId = topology.terminalToNode[terminal];
	return nodeId !== undefined ? `N${nodeId}` : '?';
}

function runAnalysis(keyLabel: string, keyOpen: boolean) {
	console.log(`\n${'='.repeat(60)}`);
	console.log(`${keyLabel}`);
	console.log('='.repeat(60));

	const wires = makeWires(keyOpen);
	const topology = buildCircuitTopology(wires, KIT_COMPONENTS);

	// Print key node assignments
	console.log('\nNode assignments:');
	console.log(`  GND  (terminals 32,35,54,87,91): ${nodeLabel(topology, 32)}`);
	console.log(`  VCC  (terminals 48,86):           ${nodeLabel(topology, 86)}`);
	console.log(`  NodeA (Q1col/SPK+/C5/C2bot):      ${nodeLabel(topology, 47)}`);
	console.log(`  NodeB (Q1base/Q3col/KEY82):        ${nodeLabel(topology, 46)}`);
	console.log(`  NodeC (KEY83/R7endB):              ${nodeLabel(topology, 14)}`);
	console.log(`  NodeD (R7endA/R9endA/C6top):       ${nodeLabel(topology, 13)}`);
	console.log(`  NodeE (R8endB/R9endB/Q3base/C2top):${nodeLabel(topology, 16)}`);

	const nodeA_id = topology.terminalToNode[47];
	const nodeB_id = topology.terminalToNode[46];
	const nodeC_id = topology.terminalToNode[14];
	const nodeD_id = topology.terminalToNode[13];
	const nodeE_id = topology.terminalToNode[16];
	const vcc_id   = topology.terminalToNode[86];
	const gnd_id   = topology.groundNodeId!;

	const netlist = buildSimulationNetlist(topology, KIT_COMPONENTS, {
		switchStates: keyOpen ? {} : { KEY1: true }
	});

	console.log(`\nNetlist: ${netlist.elements.length} elements, ground=${gnd_id}`);
	if (netlist.unsupported.length > 0) {
		console.log(`  Unsupported: ${netlist.unsupported.map(u => u.componentId).join(', ')}`);
	}
	console.log('  Elements:', netlist.elements.map(e => e.componentId ?? e.type).join(', '));

	// DC solve
	const dc = solveDcNetlist(netlist);
	console.log(`\nDC solve: ok=${dc.ok}`);
	if (!dc.ok) { console.log(`  Issue: ${dc.issue?.message}`); return; }
	if (dc.warnings.length) console.log(`  Warnings: ${dc.warnings.map(w=>w.message).join('; ')}`);

	const vA = dc.nodeVoltages[nodeA_id!] ?? 0;
	const vB = dc.nodeVoltages[nodeB_id!] ?? 0;
	const vC = dc.nodeVoltages[nodeC_id!] ?? 0;
	const vD = dc.nodeVoltages[nodeD_id!] ?? 0;
	const vE = dc.nodeVoltages[nodeE_id!] ?? 0;
	const vCC = dc.nodeVoltages[vcc_id!] ?? 0;

	console.log(`  VCC=${vCC.toFixed(4)}V, GND=0V`);
	console.log(`  NodeA(Q1col)=${vA.toFixed(4)}V`);
	console.log(`  NodeB(Q1base/Q3col)=${vB.toFixed(4)}V  (Vbe_Q1=${(vCC-vB).toFixed(4)}V)`);
	console.log(`  NodeC(KEY2/R7endB)=${vC.toFixed(4)}V`);
	console.log(`  NodeD(C6top)=${vD.toFixed(4)}V`);
	console.log(`  NodeE(Q3base)=${vE.toFixed(4)}V  (Vbe_Q3=${vE.toFixed(4)}V)`);

	// Transient: 200ms simulation, sample speaker every 5ms
	const compiled = compileNetlist(netlist);
	if (!compiled) { console.log('  compileNetlist failed'); return; }

	let state = initializeTransientState(netlist, dc.ok ? dc.nodeVoltages : undefined);
	console.log('\nInitial capacitor voltages (from DC):');
	for (const [id, v] of Object.entries(state.capacitorVoltages)) {
		console.log(`  ${id}: ${v.toFixed(6)}V`);
	}

	// Apply a fixed (not random) startup kick for reproducibility
	const kickedVoltages: Record<string, number> = {};
	for (const [id, v] of Object.entries(state.capacitorVoltages)) {
		kickedVoltages[id] = v + 0.005; // fixed +5mV kick
	}
	state = { ...state, capacitorVoltages: kickedVoltages };

	const DT_INIT = 10e-6;
	const DT_MIN  = 1e-6;
	const DT_MAX  = 0.5e-3;
	let dt = DT_INIT;

	const SIM_DURATION_S = 0.5; // 500ms
	const SAMPLE_EVERY_S = 0.01; // print every 10ms
	let nextPrint = SAMPLE_EVERY_S;
	let simTime = 0;
	let steps = 0;
	let maxSpkV = 0;
	let maxNodeA = 0;

	console.log(`\nTransient run (${SIM_DURATION_S}s simulated, printing every ${SAMPLE_EVERY_S*1000}ms):`);
	console.log(`  time(ms)  NodeA(V)   NodeB(V)   NodeE(V)   SPK(mV)   dt(µs)`);

	while (simTime < SIM_DURATION_S) {
		const stepDt = Math.min(dt, SIM_DURATION_S - simTime);
		const result = stepTransientNetlist(netlist, state, { dt: stepDt, gear: 2 }, compiled);
		if (!result.ok) {
			console.log(`  FAILED at t=${simTime.toFixed(4)}s: ${result.issue?.message}`);
			break;
		}
		state = result.state;
		simTime += stepDt;
		steps++;

		const rA = result.nodeVoltages[nodeA_id!] ?? 0;
		const rB = result.nodeVoltages[nodeB_id!] ?? 0;
		const rE = result.nodeVoltages[nodeE_id!] ?? 0;

		// Speaker voltage = NodeA (SPK1 terminal 90 = NodeA, terminal 91 = GND)
		const spkV = rA; // voltage across speaker

		if (Math.abs(rA) > maxNodeA) maxNodeA = Math.abs(rA);
		if (Math.abs(spkV) > maxSpkV) maxSpkV = Math.abs(spkV);

		if (simTime >= nextPrint) {
			console.log(`  ${(simTime*1000).toFixed(1).padStart(8)}ms  ${rA.toFixed(4)}V  ${rB.toFixed(4)}V  ${rE.toFixed(4)}V  ${(spkV*1000).toFixed(2).padStart(8)}mV  ${(dt*1e6).toFixed(0)}µs`);
			nextPrint += SAMPLE_EVERY_S;
		}

		if (result.recommendedDt !== undefined) {
			dt = Math.max(DT_MIN, Math.min(DT_MAX, result.recommendedDt));
		}
	}

	console.log(`\nSummary: ${steps} steps, maxNodeA=${maxNodeA.toFixed(6)}V, maxSpkV=${(maxSpkV*1000).toFixed(3)}mV`);
}

runAnalysis('KEY OPEN (should be silent)', true);
runAnalysis('KEY CLOSED (should produce siren)', false);
