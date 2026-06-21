/**
 * Solar cell (SOLAR1) — netlist emission verification.
 *
 * Run with: `bun scripts/solar-demo.ts`
 */
import { KIT_COMPONENTS } from '../src/lib';
import { buildSimulationNetlist, buildCircuitTopology } from '../src/lib';
import type { Wire } from '../src/lib';

// Minimal harness: SOLAR1 (64 +, 65 -) wired to R1 (1, 2).
const wires: Wire[] = [
	{ id: 'w1', fromTerminal: 64, toTerminal: 1, color: '#e53935', lengthCm: 15 }, 
	{ id: 'w2', fromTerminal: 65, toTerminal: 2, color: '#1e88e5', lengthCm: 25 },
    { id: 'w3', fromTerminal: 2,  toTerminal: 87, color: '#43a047', lengthCm: 300 } // Ground R1 bottom via BAT9 -
];

const topology = buildCircuitTopology(wires, KIT_COMPONENTS);

console.log('Solar Cell netlist emission demo');
console.log('---------------------------------');
console.log(`ground node: N${topology.groundNodeId}`);
console.log(`connected nodes: ${topology.connectedNodeIds.join(', ')}\n`);

const positions = [0, 0.25, 0.5, 0.75, 1.0];
console.log('Light-level sweep (linear voltage):');
console.log('  pos    expected V         actual V          unit');
console.log('  ----   ----------------   ----------------  ----');
for (const pos of positions) {
	const netlist = buildSimulationNetlist(topology, KIT_COMPONENTS, {
		valueOverrides: {},
		positionOverrides: { SOLAR1: pos },
		switchStates: {}
	});

	const solarElement = netlist.elements.find(
		(e) => e.type === 'voltage-source' && e.componentId === 'SOLAR1'
	) as { type: 'voltage-source'; voltage: number; positiveNode: number; negativeNode: number } | undefined;

	const maxV = 0.5;
	const expectedV = maxV * pos;

	if (!solarElement) {
		console.log(`  ${pos.toFixed(2)}   ${expectedV.toFixed(3).padEnd(16)}   (MISSING)`);
		continue;
	}

	const actualV = solarElement.voltage;
	const diff = Math.abs(actualV - expectedV);
	const ok = diff < 1e-9 ? '✓' : `MISMATCH (diff=${diff})`;
	console.log(
		`  ${pos.toFixed(2)}   ` +
		`${expectedV.toFixed(3).padEnd(16)}   ` +
		`${actualV.toFixed(3).padEnd(16)}  V  ${ok}`
	);
    
    // Check polarity
    const posNode = topology.terminalToNode[64];
    const negNode = topology.terminalToNode[65];
    if (solarElement.positiveNode === posNode && solarElement.negativeNode === negNode) {
        // ok
    } else {
        console.log(`    ✗ Polarirty mismatch: expected P=N${posNode} N=N${negNode}, got P=N${solarElement.positiveNode} N=N${solarElement.negativeNode}`);
    }
}
