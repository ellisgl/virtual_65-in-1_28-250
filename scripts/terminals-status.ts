import { KIT_COMPONENTS, KIT_TERMINAL_IDS } from '../src/lib/data/components';
import { TERMINAL_POSITIONS, isTerminalPositionMapped } from '../src/lib/data/terminalPositions';
import type { KitComponent } from '../src/lib/types';

const strictMode = process.argv.includes('--strict');

function getArgValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index === -1) return undefined;
	return process.argv[index + 1];
}

const sectionFilterInput = getArgValue('--section');
const listSectionsOnly = process.argv.includes('--list-sections');

const mappedIds = KIT_TERMINAL_IDS.filter((id) => isTerminalPositionMapped(id));
const unmappedIds = KIT_TERMINAL_IDS.filter((id) => !isTerminalPositionMapped(id));

const percent =
	KIT_TERMINAL_IDS.length === 0 ? 100 : Math.round((mappedIds.length / KIT_TERMINAL_IDS.length) * 100);

function getSectionName(component: KitComponent): string {
	if (component.kind === 'resistor') return 'Resistors';
	if (component.kind === 'potentiometer') return 'Variable Resistor';
	if (component.kind === 'capacitor' || component.kind === 'variable-capacitor') return 'Capacitors';
	if (component.kind === 'inductor' || component.kind === 'antenna') return 'Antenna Section';
	if (component.kind === 'transistor' || component.kind === 'scr' || component.kind === 'diode' || component.kind === 'zener-diode') {
		return 'Solid-State Devices';
	}
	if (component.kind === 'battery') return 'Power Supply';
	if (component.kind === 'speaker') return 'Speaker';
	if (component.kind === 'transformer') return 'Transformer';
	if (component.kind === 'lamp') return 'Signal Lamp';
	if (component.kind === 'relay') return 'Relay';
	return 'Other';
}

const sectionTerminalMap = new Map<string, Set<number>>();

for (const component of KIT_COMPONENTS) {
	const section = getSectionName(component);
	const sectionTerminals = sectionTerminalMap.get(section) ?? new Set<number>();
	for (const terminalId of component.terminals) {
		sectionTerminals.add(terminalId);
	}
	sectionTerminalMap.set(section, sectionTerminals);
}

const knownSections = Array.from(sectionTerminalMap.keys()).sort((a, b) => a.localeCompare(b));

if (listSectionsOnly) {
	console.log('Available sections:');
	for (const section of knownSections) {
		console.log(`- ${section}`);
	}
	process.exit(0);
}

let sectionFilter: string | undefined;
if (sectionFilterInput) {
	sectionFilter = knownSections.find((section) => section.toLowerCase() === sectionFilterInput.toLowerCase());
	if (!sectionFilter) {
		console.error(`Unknown section: ${sectionFilterInput}`);
		console.error('Use --list-sections to see valid section names.');
		process.exit(2);
	}
}

const terminalIdsInScope = sectionFilter
	? Array.from(sectionTerminalMap.get(sectionFilter) ?? []).sort((a, b) => a - b)
	: KIT_TERMINAL_IDS;

const mappedIdsInScope = terminalIdsInScope.filter((id) => isTerminalPositionMapped(id));
const unmappedIdsInScope = terminalIdsInScope.filter((id) => !isTerminalPositionMapped(id));
const percentInScope =
	terminalIdsInScope.length === 0 ? 100 : Math.round((mappedIdsInScope.length / terminalIdsInScope.length) * 100);

if (sectionFilter) {
	console.log(
		`Terminal mapping progress (${sectionFilter}): ${mappedIdsInScope.length}/${terminalIdsInScope.length} (${percentInScope}%)`
	);
} else {
	console.log(`Terminal mapping progress: ${mappedIds.length}/${KIT_TERMINAL_IDS.length} (${percent}%)`);
}

console.log('');

if (sectionFilter) {
	console.log('Section progress:');
	const sectionIds = Array.from(sectionTerminalMap.get(sectionFilter) ?? []).sort((a, b) => a - b);
	const sectionMapped = sectionIds.filter((id) => isTerminalPositionMapped(id));
	const sectionUnmapped = sectionIds.filter((id) => !isTerminalPositionMapped(id));
	const sectionPercent = sectionIds.length === 0 ? 100 : Math.round((sectionMapped.length / sectionIds.length) * 100);
	console.log(`- ${sectionFilter}: ${sectionMapped.length}/${sectionIds.length} (${sectionPercent}%)`);
	if (sectionUnmapped.length > 0) {
		console.log(`  missing: ${sectionUnmapped.join(', ')}`);
	}
} else {
	console.log('Section progress:');
	for (const [section, terminalSet] of sectionTerminalMap.entries()) {
		const sectionIds = Array.from(terminalSet).sort((a, b) => a - b);
		const sectionMapped = sectionIds.filter((id) => isTerminalPositionMapped(id));
		const sectionUnmapped = sectionIds.filter((id) => !isTerminalPositionMapped(id));
		const sectionPercent = sectionIds.length === 0 ? 100 : Math.round((sectionMapped.length / sectionIds.length) * 100);
		console.log(`- ${section}: ${sectionMapped.length}/${sectionIds.length} (${sectionPercent}%)`);
		if (sectionUnmapped.length > 0) {
			console.log(`  missing: ${sectionUnmapped.join(', ')}`);
		}
	}
}

if (unmappedIdsInScope.length > 0) {
	console.log('');
	console.log(sectionFilter ? `Unmapped terminal IDs (${sectionFilter}):` : 'All unmapped terminal IDs:');
	console.log(unmappedIdsInScope.join(', '));
}

const knownTerminalIdSet = new Set(KIT_TERMINAL_IDS);
const unknownPositionIds = Object.keys(TERMINAL_POSITIONS)
	.map((id) => Number(id))
	.filter((id) => !knownTerminalIdSet.has(id));

if (unknownPositionIds.length > 0) {
	console.log('');
	console.log('Terminal position entries not found in kit component terminals:');
	console.log(unknownPositionIds.join(', '));
}

if (strictMode && unmappedIdsInScope.length > 0) {
	process.exit(1);
}
