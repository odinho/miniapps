<script lang="ts" module>
	/** A sleep block on the 24h timeline. `colorVar` overrides the type-default
	 *  fill (twin overlay sets one colour per child); single-baby leaves it unset
	 *  and falls back to nap/night colours. */
	export interface TimelineBlockRender {
		x: number;
		w: number;
		y: number;
		type: 'nap' | 'night';
		colorVar?: string;
		/** Block height; defaults to the full single-baby row height. Twin lanes
		 *  set a shorter height so two children share a date row. */
		h?: number;
	}
	export interface TimelineRowRender {
		date: string;
		dateLabel: string;
		y: number;
		blocks: TimelineBlockRender[];
	}
</script>

<script lang="ts">
	import { GANTT } from '$lib/charts/scales.js';

	interface Props {
		rows: TimelineRowRender[];
		hourLabels: { x: number; label: string }[];
		height: number;
	}
	let { rows, hourLabels, height }: Props = $props();

	const blockFill = (b: TimelineBlockRender) =>
		b.colorVar ? `var(${b.colorVar})` : b.type === 'nap' ? 'var(--peach-dark)' : 'var(--moon)';
</script>

<svg viewBox="0 0 {GANTT.W} {height}" width="100%" class="stats-chart" shape-rendering="crispEdges">
	{#each hourLabels as lbl}
		<text x={lbl.x} y={14} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)" shape-rendering="auto">{lbl.label}</text>
	{/each}
	{#each rows as row}
		<text x={GANTT.PAD_L - 4} y={row.y + GANTT.ROW_H / 2 + 3} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)" shape-rendering="auto">{row.dateLabel}</text>
		<rect x={GANTT.PAD_L} y={row.y} width={GANTT.W - GANTT.PAD_L - GANTT.PAD_R} height={GANTT.ROW_H - 2} fill="var(--cream-dark)" opacity="0.3" />
		{#each row.blocks as block}
			<rect x={block.x} y={block.y} width={block.w} height={block.h ?? GANTT.ROW_H - 6} fill={blockFill(block)} />
		{/each}
	{/each}
</svg>
