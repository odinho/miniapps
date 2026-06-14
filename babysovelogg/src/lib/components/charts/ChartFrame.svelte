<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** Title shown in the fullscreen overlay. */
		title: string;
		/** Rotate the fullscreen view to landscape (wide charts like the gantt
		 *  read better upright on a phone). */
		landscape?: boolean;
		/** Extra inline style on the wrapper (e.g. overflow for scrollable charts). */
		wrapStyle?: string;
		/** Tapping the chart opens it fullscreen — the page owns the single overlay. */
		onExpand: (svgHtml: string, title: string, landscape: boolean) => void;
		children: Snippet;
	}
	let { title, landscape = true, wrapStyle = '', onExpand, children }: Props = $props();

	function expand(e: MouseEvent) {
		const svg = (e.currentTarget as HTMLElement).querySelector('svg');
		if (svg) onExpand(svg.outerHTML, title, landscape);
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="stats-chart-wrap" style={wrapStyle} onclick={expand}>
	{@render children()}
</div>

<style>
	.stats-chart-wrap {
		cursor: pointer;
	}
</style>
