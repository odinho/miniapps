<script lang="ts">
	let state = $state<Record<string, unknown> | null>(null);
	let error = $state<string | null>(null);

	async function loadState() {
		try {
			const res = await fetch('/api/state');
			state = await res.json();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	$effect(() => {
		loadState();
	});
</script>

<main>
	<h1>Babysovelogg</h1>

	{#if error}
		<p class="error">Feil: {error}</p>
	{:else if state === null}
		<p>Laster...</p>
	{:else}
		<pre>{JSON.stringify(state, null, 2)}</pre>
	{/if}
</main>

<style>
	main {
		padding: 1rem;
		font-family: system-ui, sans-serif;
	}
	.error {
		color: red;
	}
</style>
