<script lang="ts" module>
	/** One rendered series — already projected to an SVG path (charts/paths.ts).
	 *  Style fields map straight to SVG attrs; absent ones are omitted so a line
	 *  (fill 'none') and an area (fill set) render exactly as before. N series
	 *  overlay by passing more entries (twins use one per child). */
	export interface TsSeries {
		path: string;
		fill?: string;
		stroke?: string;
		strokeWidth?: number;
		strokeDasharray?: string;
		strokeLinecap?: string;
		strokeLinejoin?: string;
		opacity?: number;
	}
	export interface TsBand {
		path: string;
		fill: string;
		opacity?: number;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { TS_CHART } from '$lib/charts/scales.js';

	interface Props {
		gridLines: number[];
		yTicks: { y: number; label: string }[];
		xLabels: { x: number; label: string }[];
		/** Translucent reference regions (e.g. age-norm band), drawn under the series. */
		bands?: TsBand[];
		series: TsSeries[];
		/** Chart-specific marks drawn under / over the series (avg lines, dots). */
		underlay?: Snippet;
		overlay?: Snippet;
	}
	let { gridLines, yTicks, xLabels, bands = [], series, underlay, overlay }: Props = $props();
</script>

<svg viewBox="0 0 {TS_CHART.W} {TS_CHART.H}" width="100%" class="stats-chart">
	{#each gridLines as y}
		<line x1={TS_CHART.PAD_L} x2={TS_CHART.W - TS_CHART.PAD_R} y1={y} y2={y} stroke="var(--cream-dark)" stroke-width="1" />
	{/each}
	{#each yTicks as tick}
		<text x={TS_CHART.PAD_L - 4} y={tick.y + 4} text-anchor="end" fill="var(--text-light)" font-size="10" font-family="var(--font)">{tick.label}</text>
	{/each}
	{#each bands as b}
		<path d={b.path} fill={b.fill} opacity={b.opacity} />
	{/each}
	{@render underlay?.()}
	{#each series as s}
		<path
			d={s.path}
			fill={s.fill ?? 'none'}
			stroke={s.stroke}
			stroke-width={s.strokeWidth}
			stroke-dasharray={s.strokeDasharray}
			stroke-linecap={s.strokeLinecap as 'inherit' | 'round' | 'butt' | 'square' | undefined}
			stroke-linejoin={s.strokeLinejoin as 'inherit' | 'round' | 'arcs' | 'miter-clip' | 'miter' | 'bevel' | undefined}
			opacity={s.opacity}
		/>
	{/each}
	{@render overlay?.()}
	{#each xLabels as lbl}
		<text x={lbl.x} y={TS_CHART.H - 6} text-anchor="middle" fill="var(--text-light)" font-size="10" font-family="var(--font)">{lbl.label}</text>
	{/each}
</svg>
