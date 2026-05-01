<script lang="ts">
	import { GROUND_TERMINAL_IDS } from '$lib/sim';
	import { formatCapacitance, formatPotPosition } from '$lib/components/board/helpers';
	import type { CircuitTopology, DcSolution, SimulationNetlist, TransientState } from '$lib/types';

	interface Props {
		topology: CircuitTopology;
		netlist: SimulationNetlist;
		dc: DcSolution;
		transientState: TransientState;
		variableCapacitance: number;
		variableResistancePosition: number;
		hasVariableCapacitor: boolean;
		hasVariableResistor: boolean;
		lampPowerWatts: number;
		lampPowerRatio: number;
		lampGlowOpacity: number;
		lampPowerWattsActive: number;
		lampPowerWattsDc: number;
	}

	let {
		topology,
		netlist,
		dc,
		transientState,
		variableCapacitance,
		variableResistancePosition,
		hasVariableCapacitor,
		hasVariableResistor,
		lampPowerWatts,
		lampPowerRatio,
		lampGlowOpacity,
		lampPowerWattsActive,
		lampPowerWattsDc
	}: Props = $props();

</script>

<details class="topology-panel">
	<summary>Topology debug ({topology.nodes.length} total nodes)</summary>
	<div class="topology-grid">
		<p class="node-line"><strong>Ground config</strong></p>
		<p class="node-line">terminals: {GROUND_TERMINAL_IDS.join(', ')}</p>
		<p class="node-line">
			active ground node:
			{#if topology.groundNodeId !== null}
				N{topology.groundNodeId}
			{:else}
				(none)
			{/if}
		</p>

		{#each topology.nodes as node (node.nodeId)}
			<p class="node-line">
				<strong>N{node.nodeId}</strong>: {node.terminals.join(', ')}
				{#if topology.connectedNodeIds.includes(node.nodeId)}
					<span class="connected">connected</span>
				{/if}
			</p>
		{/each}
	</div>
</details>

<details class="topology-panel">
	<summary>Netlist debug ({netlist.elements.length} compiled / {netlist.unsupported.length} unsupported)</summary>
	<div class="topology-grid">
		{#if netlist.elements.length === 0}
			<p class="node-line">No compiled elements yet.</p>
		{/if}
		{#each netlist.elements as element}
			<p class="node-line">
				{#if element.type === 'resistor'}
					<strong>{element.componentId}</strong>: R N{element.nodes[0]}-N{element.nodes[1]} = {element.resistanceOhms} ohm
				{:else if element.type === 'capacitor'}
					<strong>{element.componentId}</strong>: C N{element.nodes[0]}-N{element.nodes[1]} = {element.capacitanceFarads} F
				{:else if element.type === 'transistor'}
					<strong>{element.componentId}</strong>: Q {element.polarity} B:N{element.baseNode} C:N{element.collectorNode} E:N{element.emitterNode}
				{:else if element.type === 'relay'}
					<strong>{element.componentId}</strong>: RL coil N{element.coilPositiveNode}-N{element.coilNegativeNode}, COM:N{element.commonNode} NC:N{element.normallyClosedNode} NO:N{element.normallyOpenNode}
				{:else if element.type === 'transformer'}
					<strong>{element.componentId}</strong>: XFMR P:N{element.primaryNodeA}-N{element.primaryNodeB} S:N{element.secondaryNodeA}-N{element.secondaryNodeB} n={element.turnsRatio}
				{:else if element.type === 'inductor'}
					<strong>{element.componentId}</strong>: L N{element.nodes[0]}-N{element.nodes[1]} = {element.inductanceHenry * 1000} mH
				{:else}
					<strong>{element.componentId}</strong>: V N{element.positiveNode}-N{element.negativeNode} = {element.voltage} V
				{/if}
			</p>
		{/each}
		{#if netlist.unsupported.length > 0}
			<p class="node-line"><strong>Unsupported:</strong></p>
			{#each netlist.unsupported as item}
				<p class="node-line">- {item.componentId} ({item.kind}): {item.reason}</p>
			{/each}
		{/if}
	</div>
</details>

<details class="topology-panel">
	<summary>DC solve debug</summary>
	<div class="topology-grid">
		{#if dc.ok}
			<p class="node-line"><strong>Node voltages</strong></p>
			{#each Object.entries(dc.nodeVoltages).sort(([a], [b]) => Number(a) - Number(b)) as [nodeId, voltage]}
				<p class="node-line">N{nodeId}: {voltage.toFixed(4)} V</p>
			{/each}
			<p class="node-line"><strong>Source currents</strong></p>
			{#if Object.keys(dc.sourceCurrents).length === 0}
				<p class="node-line">(none)</p>
			{:else}
				{#each Object.entries(dc.sourceCurrents) as [id, current]}
					<p class="node-line">{id}: {current.toFixed(6)} A</p>
				{/each}
			{/if}
		{:else}
			<p class="node-line">{dc.issue?.message ?? 'No DC result'}</p>
		{/if}

		{#if dc.warnings.length > 0}
			<p class="node-line"><strong>Warnings</strong></p>
			{#each dc.warnings as warning}
				<p class="node-line">- {warning.code}: {warning.message}</p>
			{/each}
		{/if}
	</div>
</details>

<details class="topology-panel">
	<summary>Capacitor state debug</summary>
	<div class="topology-grid">
		{#if Object.keys(transientState.capacitorVoltages).length === 0}
			<p class="node-line">No capacitor state tracked yet.</p>
		{:else}
			{#each Object.entries(transientState.capacitorVoltages).sort(([a], [b]) => a.localeCompare(b)) as [id, voltage]}
				<p class="node-line">{id}: {voltage.toFixed(6)} V</p>
			{/each}
		{/if}
		{#if hasVariableCapacitor}
			<p class="node-line">VC1 setting: {formatCapacitance(variableCapacitance)}</p>
		{/if}
		{#if hasVariableResistor}
			<p class="node-line">VR1 setting: {formatPotPosition(variableResistancePosition)}</p>
		{/if}
		<p class="node-line">
			Lamp power: {lampPowerWatts.toFixed(4)} W ({(lampPowerRatio * 100).toFixed(1)}% nominal), opacity {lampGlowOpacity.toFixed(2)}
		</p>
		<p class="node-line">
			Lamp power sources - active: {lampPowerWattsActive.toFixed(4)} W, dc: {lampPowerWattsDc.toFixed(4)} W
		</p>
	</div>
</details>

<style>
	.topology-panel {
		max-width: 1100px;
		border: 1px solid #2c2c2c;
		border-radius: 8px;
		padding: 0.5rem 0.75rem;
		background: #171717;
	}

	.topology-panel summary {
		cursor: pointer;
		font-size: 0.9rem;
		color: #ddd;
	}

	.topology-grid {
		display: grid;
		gap: 0.25rem;
		margin-top: 0.5rem;
		max-height: 12rem;
		overflow: auto;
	}

	.node-line {
		margin: 0;
		font-size: 0.82rem;
		color: #cfcfcf;
	}

	.connected {
		margin-left: 0.45rem;
		font-size: 0.75rem;
		color: #7bd389;
	}
</style>

