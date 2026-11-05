import './wasm-node';
import { KIT_COMPONENTS } from '../src/lib';
import { buildCircuitTopology, buildSimulationNetlist } from '../src/lib';
import type { Wire } from '../src/lib';
import { WasmTransientSimulator } from '#lib/sim/transient-wasm';

// RC demo using kit parts:
// BAT9+ (86) -> R1 (1-2) -> C4 (30-31) -> BAT9- (87)
const demoWires: Wire[] = [
	{ id: 'w1', fromTerminal: 86, toTerminal: 1, color: '#e53935' },
	{ id: 'w2', fromTerminal: 2, toTerminal: 30, color: '#1e88e5' },
	{ id: 'w3', fromTerminal: 31, toTerminal: 87, color: '#43a047' }
];

const topology = buildCircuitTopology(demoWires, KIT_COMPONENTS);
const netlist = buildSimulationNetlist(topology, KIT_COMPONENTS);

const dt = 5e-4;
const steps = 20;

console.log('Transient RC demo');
console.log('-----------------');
console.log(`dt: ${dt}s, steps: ${steps}`);
console.log(`ground node: ${netlist.groundNodeId === null ? '(none)' : `N${netlist.groundNodeId}`}`);
console.log('');

const sim = WasmTransientSimulator.fromNetlist(netlist);
if (!sim) {
	console.log('failed to build simulator from netlist');
	process.exit(1);
}

// Capacitor node is terminal 30; its node voltage is the capacitor charging curve
const capNode = topology.terminalToNode[30];
let time = 0;
for (let step = 1; step <= steps; step++) {
	const result = sim.step(dt);
	if (!result.ok) {
		console.log(`step ${step}: failed - ${result.issue ?? 'unknown issue'}`);
		break;
	}
	time += dt;
	console.log(`t=${time.toFixed(4)}s  V(node30)=${sim.nodeVoltage(capNode).toFixed(4)}V`);
}

if (time > 0) {
	console.log('');
	console.log('Final capacitor states:');
	for (const el of netlist.elements) {
		if (el.type !== 'capacitor') continue;
		const v = sim.nodeVoltage(el.nodes[0]) - sim.nodeVoltage(el.nodes[1]);
		console.log(`- ${el.componentId}: ${v.toFixed(6)} V`);
	}
}

sim.dispose();
