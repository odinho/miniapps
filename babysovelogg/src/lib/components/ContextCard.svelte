<script lang="ts">
	import type { Prediction } from '$lib/stores/app.svelte.js';
	import { formatDuration } from '$lib/utils.js';

	interface Props {
		prediction: Prediction;
		ageMonths: number;
	}

	let { prediction, ageMonths }: Props = $props();

	const totalSleepHours = $derived(
		prediction.totalSleep24h != null ? (prediction.totalSleep24h / 60).toFixed(1) : null,
	);

	const longestStretchFormatted = $derived(
		prediction.longestStretch != null ? formatDuration(prediction.longestStretch * 60_000) : null,
	);

	const trendIcon = $derived.by(() => {
		if (prediction.longestStretchTrend === 'growing') return '↑';
		if (prediction.longestStretchTrend === 'shrinking') return '↓';
		return '→';
	});

	const normsRange = $derived.by(() => {
		if (!prediction.ageNorms) return null;
		const n = prediction.ageNorms.totalSleepHours;
		return `${n.min}–${n.max}t`;
	});
</script>

<div class="context-card" data-testid="context-card">
	<div class="context-card-title">
		{#if prediction.strategy === 'newborn_guidance'}
			Siste døgn
		{:else}
			Søvnoversikt
		{/if}
	</div>

	<div class="context-rows">
		{#if totalSleepHours}
			<div class="context-row">
				<span class="context-label">Søvn siste 24t</span>
				<span class="context-value">
					{totalSleepHours}t
					{#if normsRange}
						<span class="context-norm">({normsRange} typisk)</span>
					{/if}
				</span>
			</div>
		{/if}

		{#if longestStretchFormatted}
			<div class="context-row">
				<span class="context-label">Lengste strekkje</span>
				<span class="context-value">
					{longestStretchFormatted}
					<span class="context-trend">{trendIcon}</span>
				</span>
			</div>
		{/if}

		{#if prediction.rolling && prediction.rolling.episodeCount > 0}
			<div class="context-row">
				<span class="context-label">Søvnepisodar</span>
				<span class="context-value">{prediction.rolling.episodeCount} siste 24t</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.context-card {
		background: var(--bg-card, rgba(255, 255, 255, 0.06));
		border-radius: 12px;
		padding: 12px 16px;
		margin: 0 16px;
	}

	.context-card-title {
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-light);
		margin-bottom: 8px;
	}

	.context-rows {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.context-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: 0.9rem;
	}

	.context-label {
		color: var(--text-light);
	}

	.context-value {
		font-weight: 500;
	}

	.context-norm {
		font-size: 0.8rem;
		color: var(--text-light);
		font-weight: 400;
	}

	.context-trend {
		font-size: 0.85rem;
		margin-left: 2px;
	}
</style>
