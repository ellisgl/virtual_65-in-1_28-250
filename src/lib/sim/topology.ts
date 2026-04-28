import type { CircuitNode, CircuitTopology, KitComponent, Wire } from '$lib/types';
import { GROUND_TERMINAL_IDS } from '$lib/sim/config';

class UnionFind {
	private parent = new Map<number, number>();

	add(value: number) {
		if (!this.parent.has(value)) {
			this.parent.set(value, value);
		}
	}

	find(value: number): number {
		const parent = this.parent.get(value);
		if (parent === undefined) {
			this.parent.set(value, value);
			return value;
		}
		if (parent === value) return value;
		const root = this.find(parent);
		this.parent.set(value, root);
		return root;
	}

	union(a: number, b: number) {
		const rootA = this.find(a);
		const rootB = this.find(b);
		if (rootA === rootB) return;
		if (rootA < rootB) {
			this.parent.set(rootB, rootA);
		} else {
			this.parent.set(rootA, rootB);
		}
	}
}

function getGroundTerminal(allTerminals: Set<number>): number | null {
	for (const terminalId of GROUND_TERMINAL_IDS) {
		if (allTerminals.has(terminalId)) return terminalId;
	}
	return null;
}

export function buildCircuitTopology(wires: Wire[], components: KitComponent[]): CircuitTopology {
	const uf = new UnionFind();
	const allTerminals = new Set<number>();

	for (const component of components) {
		for (const terminal of component.terminals) {
			allTerminals.add(terminal);
			uf.add(terminal);
		}
	}

	for (const wire of wires) {
		if (!allTerminals.has(wire.fromTerminal) || !allTerminals.has(wire.toTerminal)) continue;
		uf.union(wire.fromTerminal, wire.toTerminal);
	}

	const existingGrounds = GROUND_TERMINAL_IDS.filter((terminalId) => allTerminals.has(terminalId));
	if (existingGrounds.length > 1) {
		const firstGround = existingGrounds[0];
		for (let idx = 1; idx < existingGrounds.length; idx++) {
			uf.union(firstGround, existingGrounds[idx]);
		}
	}

	const groups = new Map<number, number[]>();
	for (const terminal of allTerminals) {
		const root = uf.find(terminal);
		const group = groups.get(root) ?? [];
		group.push(terminal);
		groups.set(root, group);
	}

	const groupEntries = Array.from(groups.values())
		.map((terminals) => terminals.sort((a, b) => a - b))
		.sort((a, b) => a[0] - b[0]);

	const terminalToNode: Record<number, number> = {};
	const nodes: CircuitNode[] = groupEntries.map((terminals, nodeId) => {
		for (const terminal of terminals) {
			terminalToNode[terminal] = nodeId;
		}
		return { nodeId, terminals };
	});

	const connectedNodeIdSet = new Set<number>();
	for (const wire of wires) {
		const nodeA = terminalToNode[wire.fromTerminal];
		const nodeB = terminalToNode[wire.toTerminal];
		if (nodeA !== undefined) connectedNodeIdSet.add(nodeA);
		if (nodeB !== undefined) connectedNodeIdSet.add(nodeB);
	}

	const componentBindings = components.map((component) => ({
		componentId: component.id,
		componentKind: component.kind,
		terminals: component.terminals,
		nodeIds: component.terminals.map((terminal) => terminalToNode[terminal])
	}));

	const groundTerminal = getGroundTerminal(allTerminals);
	const groundNodeId = groundTerminal === null ? null : (terminalToNode[groundTerminal] ?? null);

	return {
		nodes,
		terminalToNode,
		componentBindings,
		connectedNodeIds: Array.from(connectedNodeIdSet).sort((a, b) => a - b),
		groundNodeId,
		wireCount: wires.length
	};
}

