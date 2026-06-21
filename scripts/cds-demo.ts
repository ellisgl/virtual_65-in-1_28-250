/**
 * CdS photoresistor (LDR1) — netlist emission verification.
 *
 * Run with: `bun scripts/cds-demo.ts`
 *
 * Connects LDR1's terminals (66, 67) into a simple divider against R1 (100 Ω
 * between terminals 1, 2) tied to the 9 V battery, then sweeps the light
 * level from 0 (dark, 350 MΩ) to 1 (bright, 50 Ω) and prints what the
 * netlist builder emits.  Spot-checks the log-linear interpolation curve
 * and validates the resistor element appears with the expected nodes.
 */
import { KIT_COMPONENTS } from '../src/lib';
import { buildSimulationNetlist, buildCircuitTopology } from '../src/lib';
import type { Wire } from '../src/lib';

// Minimal harness: LDR1 (66-67) in series with R1 (1-2) across BAT9 (86 +, 87 -).
// Wire 66 → 1 (top of LDR1 to top of R1), 87 → 2 (battery -, bottom of R1).
// Battery's + is at terminal 86; we wire LDR1's 67 to it.
const wires: Wire[] = [
	{ id: 'w1', fromTerminal: 86, toTerminal: 67, color: '#e53935', lengthCm: 15 }, // V+ → LDR1 top
	{ id: 'w2', fromTerminal: 66, toTerminal: 1,  color: '#fdd835', lengthCm: 38 }, // LDR1 bottom → R1 top
	{ id: 'w3', fromTerminal: 2,  toTerminal: 87, color: '#43a047', lengthCm: 300 }  // R1 bottom → V-
];

const topology = buildCircuitTopology(wires, KIT_COMPONENTS);

console.log('CdS / LDR1 netlist emission demo');
console.log('---------------------------------');
console.log(`ground node: N${topology.groundNodeId}`);
console.log(`connected nodes: ${topology.connectedNodeIds.join(', ')}\n`);

const positions = [0, 0.25, 0.5, 0.75, 1.0];
console.log('Light-level sweep (log-linear interpolation):');
console.log('  pos    expected R         actual R          unit');
console.log('  ----   ----------------   ----------------  ----');
for (const pos of positions) {
	const netlist = buildSimulationNetlist(topology, KIT_COMPONENTS, {
		valueOverrides: {},
		positionOverrides: { LDR1: pos },
		switchStates: {}
	});

	const ldrElement = netlist.elements.find(
		(e) => e.type === 'resistor' && e.componentId === 'LDR1'
	) as { type: 'resistor'; resistanceOhms: number; nodes: [number, number] } | undefined;

	const darkR = 350_000_000;
	const lightR = 50;
	const expectedR = darkR * Math.pow(lightR / darkR, pos);

	if (!ldrElement) {
		console.log(`  ${pos.toFixed(2)}   ${expectedR.toExponential(3).padEnd(16)}   (MISSING)`);
		continue;
	}

	const actualR = ldrElement.resistanceOhms;
	const ratio = actualR / expectedR;
	const ok = Math.abs(ratio - 1) < 1e-9 ? '✓' : `MISMATCH (ratio=${ratio})`;
	console.log(
		`  ${pos.toFixed(2)}   ` +
		`${expectedR.toExponential(3).padEnd(16)}   ` +
		`${actualR.toExponential(3).padEnd(16)}  Ω  ${ok}`
	);
}

console.log('\nKey sanity checks:');
console.log('  • pos=0   should equal 350 MΩ (full dark)');
console.log('  • pos=1   should equal 50 Ω   (full bright)');
console.log('  • pos=0.5 should equal sqrt(350M × 50) ≈ 132 kΩ (geometric mean)');

// Verify unsupported-handling: missing metadata
console.log('\nNegative test — missing lightResistance metadata:');
const brokenCatalog = KIT_COMPONENTS.map((c) =>
	c.id === 'LDR1' ? { ...c, metadata: { ...c.metadata, lightResistance: undefined as unknown as number } } : c
);
const brokenNetlist = buildSimulationNetlist(topology, brokenCatalog, {
	valueOverrides: {},
	positionOverrides: { LDR1: 0.5 },
	switchStates: {}
});
const unsup = brokenNetlist.unsupported.find((u) => u.componentId === 'LDR1');
if (unsup) {
	console.log(`  ✓ LDR1 reported as unsupported: "${unsup.reason}"`);
} else {
	console.log('  ✗ expected LDR1 in unsupported list but it was missing');
}
