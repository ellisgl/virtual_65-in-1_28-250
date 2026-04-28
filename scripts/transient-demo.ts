import { KIT_COMPONENTS } from '../src/lib/data/components';
import {
	buildCircuitTopology,
	buildSimulationNetlist,
	initializeTransientState,
	stepTransientNetlist
} from '../src/lib/sim';
import type { Wire } from '../src/lib/types';

// RC demo using kit parts:
// BAT9+ (86) -> R1 (1-2) -> C4 (30-31) -> BAT9- (87)
const demoWires: Wire[] = [
	{ id: 'w1', fromTerminal: 86, toTerminal: 1, color: '#e53935' },
	{ id: 'w2', fromTerminal: 2, toTerminal: 30, color: '#1e88e5' },
	{ id: 'w3', fromTerminal: 31, toTerminal: 87, color: '#43a047' }
];

const topology = buildCircuitTopology(demoWires, KIT_COMPONENTS);
const netlist = buildSimulationNetlist(topology, KIT_COMPONENTS);

let state = initializeTransientState(netlist);
const dt = 5e-4;
const steps = 20;

console.log('Transient RC demo');
console.log('-----------------');
console.log(`dt: ${dt}s, steps: ${steps}`);
console.log(`ground node: ${netlist.groundNodeId === null ? '(none)' : `N${netlist.groundNodeId}`}`);
console.log('');

for (let step = 1; step <= steps; step++) {
	const result = stepTransientNetlist(netlist, state, { dt });
	if (!result.ok) {
		console.log(`step ${step}: failed - ${result.issue?.message ?? 'unknown issue'}`);
		break;
	}
	state = result.state;

	// Capacitor node is terminal 30; its node voltage is the capacitor charging curve
	const capNode = topology.terminalToNode[30];
	const capVoltage = result.nodeVoltages[capNode] ?? 0;
	console.log(`t=${state.time.toFixed(4)}s  V(node30)=${capVoltage.toFixed(4)}V`);
}

if (state.time > 0) {
	console.log('');
	console.log('Final capacitor states:');
	for (const [id, voltage] of Object.entries(state.capacitorVoltages)) {
		console.log(`- ${id}: ${voltage.toFixed(6)} V`);
	}
}

