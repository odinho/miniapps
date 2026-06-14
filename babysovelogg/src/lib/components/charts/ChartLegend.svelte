<script lang="ts">
	import type { LegendItem } from '$lib/charts/types.js';

	interface Props {
		items: LegendItem[];
	}
	let { items }: Props = $props();
</script>

<!-- Uses the global .stats-legend / .stats-legend-item / .stats-dot styles
     (app.css). In twin overlay the items are child-coloured first, sleep-type
     second — the component just renders whatever items it's given. -->
<div class="stats-legend">
	{#each items as item}
		<span class="stats-legend-item">
			<span class="stats-dot" style="background: var({item.colorVar})"></span> {item.label}
		</span>
	{/each}
</div>
