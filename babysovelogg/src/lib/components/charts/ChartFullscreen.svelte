<script lang="ts">
	interface Props {
		/** Cloned chart SVG markup, or null when nothing is open. */
		svg: string | null;
		title: string;
		landscape: boolean;
		onClose: () => void;
	}
	let { svg, title, landscape, onClose }: Props = $props();
</script>

{#if svg}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="chart-fullscreen-overlay {landscape ? 'landscape' : ''}"
		onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
		onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}
		tabindex="-1"
	>
		<div class="chart-fullscreen-header">
			<span>{title}</span>
			<button class="chart-fullscreen-close" onclick={onClose}>✕</button>
		</div>
		<div class="chart-fullscreen-body" onclick={onClose}>
			{@html svg}
		</div>
	</div>
{/if}

<style>
	.chart-fullscreen-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: var(--cream);
		z-index: 1000;
		display: flex;
		flex-direction: column;
		padding: 12px 16px;
	}

	.chart-fullscreen-overlay.landscape {
		width: 100vh;
		height: 100vw;
		right: auto;
		bottom: auto;
		transform: rotate(90deg);
		transform-origin: top left;
		translate: 100vw 0;
	}

	.chart-fullscreen-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-weight: 600;
		font-size: 0.9rem;
		margin-bottom: 8px;
		flex-shrink: 0;
	}

	.chart-fullscreen-close {
		background: var(--lavender);
		border: none;
		border-radius: 50%;
		width: 32px;
		height: 32px;
		font-size: 1rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text);
	}

	.chart-fullscreen-body {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: auto;
	}

	.chart-fullscreen-body :global(svg) {
		width: 100%;
		height: auto;
		max-height: 100%;
	}
</style>
