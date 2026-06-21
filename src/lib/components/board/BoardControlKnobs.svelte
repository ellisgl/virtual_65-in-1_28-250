<script lang="ts">
	/**
	 * The board's rotary controls (variable capacitor VC1, potentiometer VR1),
	 * positioned over their footprints in the board artwork (board.svg
	 * coordinates).  Pure layout/config wrapper — the actual knob interaction
	 * and rendering live in VariableKnob.svelte; value changes flow back to
	 * Board.svelte via each config's onChange.
	 */
	import VariableKnob from '$lib/components/VariableKnob.svelte';

	interface CapacitorKnobConfig {
		x: number;
		y: number;
		radius: number;
		value: number;
		min: number;
		max: number;
		startAngle: number;
		endAngle: number;
		label: string;
		onChange: (value: number) => void;
	}

	interface ResistorKnobConfig {
		x: number;
		y: number;
		radius: number;
		value: number;
		min: number;
		max: number;
		startAngle: number;
		endAngle: number;
		tickCount: number;
		variant: 'round' | 'chickenhead';
		label: string;
		onChange: (value: number) => void;
	}

	interface Props {
		capacitor?: CapacitorKnobConfig;
		resistor?: ResistorKnobConfig;
	}

	let { capacitor, resistor }: Props = $props();
</script>

{#if capacitor}
	<VariableKnob
		x={capacitor.x}
		y={capacitor.y}
		radius={capacitor.radius}
		value={capacitor.value}
		min={capacitor.min}
		max={capacitor.max}
		startAngle={capacitor.startAngle}
		endAngle={capacitor.endAngle}
		label={capacitor.label}
		onChange={capacitor.onChange}
	/>
{/if}

{#if resistor}
	<VariableKnob
		x={resistor.x}
		y={resistor.y}
		radius={resistor.radius}
		value={resistor.value}
		min={resistor.min}
		max={resistor.max}
		startAngle={resistor.startAngle}
		endAngle={resistor.endAngle}
		tickCount={resistor.tickCount}
		variant={resistor.variant}
		label={resistor.label}
		onChange={resistor.onChange}
	/>
{/if}

