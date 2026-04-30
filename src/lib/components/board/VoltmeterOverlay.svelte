<script lang="ts">
	interface Props {
		needleAngle: number;
	}

	const METER_DIAL_CENTER = { x: 250.5, y: 162 };
	const METER_OFFSET_X = 0;
	const METER_OFFSET_Y = -5;
	const METER_SCALE = 1.5;

	let { needleAngle }: Props = $props();
</script>

<g
	class="voltmeter-dial"
	aria-hidden="true"
	transform={`translate(${METER_OFFSET_X} ${METER_OFFSET_Y}) translate(${METER_DIAL_CENTER.x} ${METER_DIAL_CENTER.y}) scale(${METER_SCALE}) translate(${-METER_DIAL_CENTER.x} ${-METER_DIAL_CENTER.y})`}
>
	<rect x="236" y="146" width="29" height="25" rx="1.7" class="voltmeter-body" />
	<rect x="238" y="148" width="25" height="15" rx="0.7" class="voltmeter-window" />
	<path d="M 241 160 A 9.5 9.5 0 0 1 260 160" class="voltmeter-scale" />
	<line x1="241" y1="160" x2="242" y2="158" class="voltmeter-tick" />
	<line x1="250.5" y1="150.5" x2="250.5" y2="152.9" class="voltmeter-tick" />
	<line x1="260" y1="160" x2="259" y2="158" class="voltmeter-tick" />
	<text x="240.1" y="154.2" class="voltmeter-label voltmeter-label-mid">0</text>
	<text x="250.5" y="148.9" class="voltmeter-label voltmeter-label-mid">5</text>
	<text x="260.9" y="154.2" class="voltmeter-label voltmeter-label-mid">10</text>
	<line
		x1={METER_DIAL_CENTER.x}
		y1={METER_DIAL_CENTER.y}
		x2={METER_DIAL_CENTER.x}
		y2={METER_DIAL_CENTER.y - 8.7}
		class="voltmeter-needle"
		transform={`rotate(${needleAngle} ${METER_DIAL_CENTER.x} ${METER_DIAL_CENTER.y})`}
	/>
	<circle cx={METER_DIAL_CENTER.x} cy={METER_DIAL_CENTER.y} r="1.2" class="voltmeter-hub" />
	<circle cx={METER_DIAL_CENTER.x} cy={METER_DIAL_CENTER.y} r="0.4" class="voltmeter-screw" />
</g>

<style>
	.voltmeter-dial {
		pointer-events: none;
	}

	.voltmeter-body {
		fill: #d7d7d7;
		stroke: #8f8f8f;
		stroke-width: 0.45;
	}

	.voltmeter-window {
		fill: #f7f7f4;
		stroke: #b8b8b8;
		stroke-width: 0.25;
	}

	.voltmeter-scale {
		fill: none;
		stroke: #222;
		stroke-width: 0.35;
	}

	.voltmeter-tick {
		stroke: #222;
		stroke-width: 0.3;
		stroke-linecap: round;
	}

	.voltmeter-label {
		font-size: 2.2px;
		fill: #111;
		font-weight: 600;
		font-family: sans-serif;
	}

	.voltmeter-label-mid {
		text-anchor: middle;
	}

	.voltmeter-needle {
		stroke: #111;
		stroke-width: 0.55;
		stroke-linecap: round;
	}

	.voltmeter-hub {
		fill: #b5952f;
		stroke: #6a5320;
		stroke-width: 0.2;
	}

	.voltmeter-screw {
		fill: #6a5320;
	}
</style>

