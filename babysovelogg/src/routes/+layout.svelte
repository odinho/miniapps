<script lang="ts">
	let { children } = $props();
</script>

<svelte:head>
	<title>Babysovelogg</title>
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
</svelte:head>

{@render children()}
