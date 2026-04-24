<script lang="ts">
	import Board from '$lib/components/Board.svelte';
</script>

<main>
	<h1>Virtual Science Fair 65-in-1</h1>
	<Board />
</main>

<style>
	main {
		padding: 1rem;
		display: grid;
		gap: 1rem;
	}

	h1 {
		margin: 0;
		font-size: clamp(1.2rem, 2.5vw, 1.8rem);
	}
</style>
