<script lang="ts">
	import type { Prediction } from '$lib/stores/app.svelte.js';
	import { formatDuration } from '$lib/utils.js';
	import { getGuidanceText, assessNormality } from '$lib/engine/guidance.js';
	import { calculateAgeMonths } from '$lib/engine/schedule.js';

	interface Props {
		prediction: Prediction;
		ageMonths: number;
		birthdate?: string;
	}

	let { prediction, ageMonths, birthdate }: Props = $props();

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

	const trendDetail = $derived.by(() => {
		const d = prediction.longestStretchDetail;
		if (!d || d.priorWeekAvg === 0) return null;
		const diff = d.currentWeekAvg - d.priorWeekAvg;
		if (Math.abs(diff) < 5) return null;
		const sign = diff > 0 ? '+' : '';
		return `${sign}${formatDuration(Math.abs(diff) * 60_000)} sidan førre veke`;
	});

	const normsRange = $derived.by(() => {
		if (!prediction.ageNorms) return null;
		const n = prediction.ageNorms.totalSleepHours;
		return `${n.min}–${n.max}t`;
	});

	const meanEpisodeDuration = $derived(
		prediction.rolling?.meanEpisodeDuration
			? formatDuration(prediction.rolling.meanEpisodeDuration * 60_000)
			: null,
	);

	// Age in weeks for guidance text
	const ageWeeks = $derived.by(() => {
		if (!birthdate) return ageMonths * 4.33;
		const birth = new Date(birthdate);
		const now = new Date();
		return Math.max(0, Math.floor((now.getTime() - birth.getTime()) / (7 * 24 * 60 * 60 * 1000)));
	});

	const guidance = $derived(getGuidanceText(Math.round(ageWeeks)));

	const normalityText = $derived.by(() => {
		if (prediction.totalSleep24h == null || prediction.longestStretch == null) return null;
		return assessNormality(prediction.totalSleep24h, prediction.longestStretch, Math.round(ageWeeks));
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
			{#if trendDetail}
				<div class="context-row-sub">
					{trendDetail}
				</div>
			{/if}
		{/if}

		{#if prediction.rolling && prediction.rolling.episodeCount > 0}
			<div class="context-row">
				<span class="context-label">Søvnepisodar</span>
				<span class="context-value">{prediction.rolling.episodeCount} siste 24t</span>
			</div>
		{/if}

		{#if meanEpisodeDuration}
			<div class="context-row">
				<span class="context-label">Snitt per økt</span>
				<span class="context-value">{meanEpisodeDuration}</span>
			</div>
		{/if}
	</div>

	{#if normalityText}
		<div class="normality" data-testid="normality-text">
			{normalityText}
		</div>
	{/if}

	<div class="guidance" data-testid="guidance-text">
		<p class="guidance-phase">{guidance.phaseDescription}</p>
		<p class="guidance-look">{guidance.lookFor}</p>
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

	.context-row-sub {
		font-size: 0.8rem;
		color: var(--text-light);
		text-align: right;
		margin-top: -4px;
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

	.normality {
		margin-top: 10px;
		padding: 8px 0;
		border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
		font-size: 0.85rem;
		color: var(--text);
	}

	.guidance {
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
	}

	.guidance p {
		margin: 0 0 4px 0;
		font-size: 0.8rem;
		color: var(--text-light);
		line-height: 1.4;
	}

	.guidance-phase {
		font-style: italic;
	}

	.guidance-look {
		margin-bottom: 0 !important;
	}
</style>
