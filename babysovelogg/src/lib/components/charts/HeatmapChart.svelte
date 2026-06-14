<script lang="ts" module>
	export interface HeatmapCell {
		x: number;
		y: number;
		w: number;
		h: number;
		opacity: number;
	}
</script>

<script lang="ts">
	interface Props {
		width: number;
		height: number;
		cells: HeatmapCell[];
		hourLabels: { x: number; label: string }[];
		dateLabels: { x: number; y: number; label: string }[];
	}
	let { width, height, cells, hourLabels, dateLabels }: Props = $props();
</script>

<svg viewBox="0 0 {width} {height}" width="100%" class="stats-chart" shape-rendering="crispEdges" style="height: {height}px; width: 100%;">
	{#each hourLabels as lbl}
		<text x={lbl.x} y={12} text-anchor="middle" fill="var(--text-light)" font-size="9" font-family="var(--font)" shape-rendering="auto">{lbl.label}</text>
	{/each}
	{#each dateLabels as lbl}
		<text x={lbl.x} y={lbl.y} text-anchor="end" fill="var(--text-light)" font-size="8" font-family="var(--font)" shape-rendering="auto">{lbl.label}</text>
	{/each}
	{#each cells as cell}
		<rect x={cell.x} y={cell.y} width={cell.w} height={cell.h} fill="var(--moon)" opacity={Math.max(0.05, cell.opacity)} />
	{/each}
</svg>
