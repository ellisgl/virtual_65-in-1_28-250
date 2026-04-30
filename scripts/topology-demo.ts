import { KIT_COMPONENTS } from '../src/lib';
import { buildCircuitTopology } from '../src/lib';
import type { Wire } from '../src/lib';

const demoWires: Wire[] = [
	{ id: 'w1', fromTerminal: 86, toTerminal: 1, color: '#e53935' },
	{ id: 'w2', fromTerminal: 2, toTerminal: 68, color: '#1e88e5' },
	{ id: 'w3', fromTerminal: 69, toTerminal: 87, color: '#43a047' },
	{ id: 'w4', fromTerminal: 3, toTerminal: 11, color: '#fdd835' }
];

const topology = buildCircuitTopology(demoWires, KIT_COMPONENTS);

console.log('Demo topology');
console.log('-------------');
console.log(`wires: ${topology.wireCount}`);
console.log(`nodes: ${topology.nodes.length}`);
console.log(`connected nodes: ${topology.connectedNodeIds.join(', ') || '(none)'}`);
console.log(`ground node: ${topology.groundNodeId === null ? '(none)' : `N${topology.groundNodeId}`}`);
console.log('');

for (const node of topology.nodes) {
	if (!topology.connectedNodeIds.includes(node.nodeId)) continue;
	console.log(`N${node.nodeId}: ${node.terminals.join(', ')}`);
}

