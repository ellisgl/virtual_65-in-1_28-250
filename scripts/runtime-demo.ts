import { KIT_COMPONENTS } from '../src/lib';
import { buildSimulationNetlist, buildCircuitTopology, solveDcNetlist } from '../src/lib';
import type { Wire } from '../src/lib';

const demoWires: Wire[] = [
	{ id: 'w1', fromTerminal: 86, toTerminal: 1, color: '#e53935' },
	{ id: 'w2', fromTerminal: 2, toTerminal: 68, color: '#1e88e5' },
	{ id: 'w3', fromTerminal: 69, toTerminal: 87, color: '#43a047' },
	{ id: 'w4', fromTerminal: 3, toTerminal: 11, color: '#fdd835' }
];

const topology = buildCircuitTopology(demoWires, KIT_COMPONENTS);
const netlist = buildSimulationNetlist(topology, KIT_COMPONENTS);
const dc = solveDcNetlist(netlist);

console.log('Runtime netlist demo');
console.log('-------------------');
console.log(`wires: ${demoWires.length}`);
console.log(`connected nodes: ${topology.connectedNodeIds.join(', ') || '(none)'}`);
console.log(`ground node: ${netlist.groundNodeId === null ? '(none)' : `N${netlist.groundNodeId}`}`);
console.log(`compiled elements: ${netlist.elements.length}`);
console.log(`unsupported components: ${netlist.unsupported.length}`);
console.log(`dc status: ${dc.ok ? 'solved' : `failed (${dc.issue?.code ?? 'unknown'})`}`);
console.log('');

for (const element of netlist.elements) {
	if (element.type === 'resistor') {
		console.log(
			`${element.componentId}: resistor N${element.nodes[0]}-N${element.nodes[1]} ${element.resistanceOhms} ohm`
		);
	} else if (element.type === 'capacitor') {
		console.log(
			`${element.componentId}: capacitor N${element.nodes[0]}-N${element.nodes[1]} ${element.capacitanceFarads} F`
		);
	} else if (
		'polarity' in element &&
		'baseNode' in element &&
		'collectorNode' in element &&
		'emitterNode' in element
	) {
		console.log(
			`${element.componentId}: transistor ${element.polarity} B:N${element.baseNode} C:N${element.collectorNode} E:N${element.emitterNode}`
		);
	} else if ('coilPositiveNode' in element && 'coilNegativeNode' in element && 'commonNode' in element) {
		console.log(
			`${element.componentId}: relay coil N${element.coilPositiveNode}-N${element.coilNegativeNode}, COM:N${element.commonNode} NC:N${element.normallyClosedNode} NO:N${element.normallyOpenNode}`
		);
	} else {
		console.log(
			`${element.componentId}: voltage source N${element.positiveNode}-N${element.negativeNode} ${element.voltage} V`
		);
	}
}

if (netlist.unsupported.length > 0) {
	console.log('');
	console.log('Unsupported:');
	for (const item of netlist.unsupported.slice(0, 10)) {
		console.log(`- ${item.componentId} (${item.kind}): ${item.reason}`);
	}
	if (netlist.unsupported.length > 10) {
		console.log(`... and ${netlist.unsupported.length - 10} more`);
	}
}

console.log('');
if (dc.ok) {
	console.log('Node voltages:');
	for (const [nodeId, voltage] of Object.entries(dc.nodeVoltages).sort(
		([a], [b]) => Number(a) - Number(b)
	)) {
		console.log(`- N${nodeId}: ${voltage.toFixed(6)} V`);
	}

	console.log('');
	console.log('Source currents:');
	const sourceEntries = Object.entries(dc.sourceCurrents);
	if (sourceEntries.length === 0) {
		console.log('- (none)');
	} else {
		for (const [id, current] of sourceEntries) {
			console.log(`- ${id}: ${current.toFixed(6)} A`);
		}
	}
} else {
	console.log(`DC solve issue: ${dc.issue?.message ?? 'unknown issue'}`);
}

if (dc.warnings.length > 0) {
	console.log('');
	console.log('Warnings:');
	for (const warning of dc.warnings) {
		console.log(`- ${warning.code}: ${warning.message}`);
	}
}

