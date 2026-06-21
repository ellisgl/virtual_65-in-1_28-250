<script lang="ts">
	import Board from '$lib/components/Board.svelte';
</script>

<main>
	<Board />
</main>

<style>
	main {
		padding: 0 1rem 1rem;
		display: grid;
		gap: 1rem;
		/* Without these, the SVG's intrinsic mm-width (~1651 px at 96 dpi)
		   causes the grid to overflow the viewport instead of scaling. */
		box-sizing: border-box;
		max-width: 100%;
		overflow-x: hidden;
	}
</style>
