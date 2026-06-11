<script lang="ts">
	/**
	 * Renders the SPDT relay's arm in either the energized ("on") or
	 * de-energized ("off") position, overlaid on the static board SVG.
	 *
	 * The static board.svg has both `g123` (Switch_Off) and `g1` (Switch_On)
	 * groups set to `display:none` so the underlying image draws no arm —
	 * this overlay is the single source of truth for the relay's visual
	 * state.
	 *
	 * The transform chain below replicates the chain in the static
	 * SVG:
	 *
	 *   use129 (translate)
	 *     → g124 / SPDT_Relay (scale and translate)
	 *       → g123 / g1 inner group (matrix(0, 1, 1, 0, …) — a swap)
	 *         → the actual path
	 *
	 * Keeping the chain identical ensures the rendered switch arm aligns
	 * pixel-perfectly with the rest of the relay symbol still drawn by the
	 * underlying board image (the coil, the NC contact, the connector
	 * pads).
	 *
	 * Path data is verbatim from board.svg.  If the artwork in the SVG is
	 * ever re-exported and the path coordinates change, the same coords
	 * need to be mirrored here.
	 */
	interface Props {
		energized: boolean;
	}

	let { energized }: Props = $props();

	// Path data lifted verbatim from board.svg's g123 (Switch_Off) and
	// g1 (Switch_On) so the rendered arm aligns with the rest of the
	// relay symbol drawn by the static image.
	const OFF_PATH = 'm 13211.293,211.39765 -70.232,13.74313 h -52.675 l -0.517,90.88053';
	const ON_PATH  = 'm 13211.293,241.13026 -70.232,-15.98948 h -52.675 l -0.517,90.88053';
</script>

<!--
  Transform chain replicates board.svg's use129 → g124 → g123/g1.
  Stroke width is 1.86842 in the inner coord system; after the
  0.26760598 scale of g124 that comes out to ~0.50 in screen units,
  matching the rest of the relay symbol.
-->
<g
	class="relay-state-overlay"
	transform="translate(367.58782)"
	aria-label="Relay RL1 state"
>
	<g transform="matrix(0.26760598,0,0,0.26760598,-3537.2782,28.928094)">
		<g transform="matrix(0,1,1,0,12869.366,-12897.368)">
			<path
				d={energized ? ON_PATH : OFF_PATH}
				fill="none"
				stroke="#000"
				stroke-width="1.86842"
				stroke-opacity="0.98"
			/>
		</g>
	</g>
</g>

<style>
	.relay-state-overlay {
		pointer-events: none;
	}
</style>
