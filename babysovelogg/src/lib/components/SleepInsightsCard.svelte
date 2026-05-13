<script lang="ts">
	import type { LearnedSchedule } from '$lib/stores/app.svelte.js';
	import type { CalibrationReport } from '$lib/engine/calibration.js';
	import { formatDuration } from '$lib/utils.js';

	interface Props {
		schedule: LearnedSchedule;
		calibration: CalibrationReport | null;
		/**
		 * Blended 7d/30d trend total (minutes). Shown alongside the
		 * learned-typical total when it differs meaningfully — otherwise the
		 * overview keeps advertising the stale `learnedSchedule` total even
		 * when the engine is recommending a cap.
		 */
		dailyTrendTotalMin?: number | null;
	}

	let { schedule, calibration, dailyTrendTotalMin = null }: Props = $props();
	let collapsed = $state(true);

	const napDurLabel = $derived(formatDuration(schedule.napDurationMin * 60_000));
	const nightDurLabel = $derived(formatDuration(schedule.nightDurationMin * 60_000));
	const wwLabel = $derived(formatDuration(schedule.wakeWindowMin * 60_000));
	const bedtimeWWLabel = $derived(formatDuration(schedule.bedtimeWakeWindowMin * 60_000));
	const totalSleepMin = $derived(
		schedule.napDurationMin * schedule.expectedNapCount + schedule.nightDurationMin,
	);
	const totalSleepLabel = $derived(
		`${(totalSleepMin / 60).toFixed(1)}t`,
	);
	const trendTotalLabel = $derived(
		dailyTrendTotalMin != null ? `${(dailyTrendTotalMin / 60).toFixed(1)}t` : null,
	);
	/** Show the trend row when it diverges from the learned total by more
	 *  than 30 min — otherwise the two are essentially the same and the
	 *  extra row just adds noise. */
	const showTrendRow = $derived(
		dailyTrendTotalMin != null && Math.abs(totalSleepMin - dailyTrendTotalMin) > 30,
	);
	const trustLabel = $derived.by(() => {
		if (!calibration) return null;
		if (calibration.trust === 'learned') return 'Tilpassa';
		if (calibration.trust === 'partial') return 'Delvis tilpassa';
		return 'Aldersbasert';
	});
</script>

<div class="insights-card" data-testid="sleep-insights-card">
	<button class="insights-title" onclick={() => (collapsed = !collapsed)} aria-expanded={!collapsed}>
		<span>Søvnoversikt</span>
		<span class="insights-chevron">{collapsed ? '▼' : '▲'}</span>
	</button>

	{#if !collapsed}
	<div class="insights-rows">
		<div class="insights-row">
			<span class="insights-label">Forventa lur</span>
			<span class="insights-value">{napDurLabel}</span>
		</div>
		<div class="insights-row">
			<span class="insights-label">Vakenvindauge</span>
			<span class="insights-value">{wwLabel}</span>
		</div>
		<div class="insights-row">
			<span class="insights-label">Før leggetid</span>
			<span class="insights-value">{bedtimeWWLabel}</span>
		</div>
		<div class="insights-row">
			<span class="insights-label">Nattesøvn</span>
			<span class="insights-value">{nightDurLabel}</span>
		</div>
		<div class="insights-row">
			<span class="insights-label">Søvnsyklus</span>
			<span class="insights-value">~{schedule.sleepCycleMin}m</span>
		</div>
		<div class="insights-row">
			<span class="insights-label">Forventa totalt</span>
			<span class="insights-value">{totalSleepLabel}
				<span class="insights-detail">({schedule.expectedNapCount} {schedule.expectedNapCount === 1 ? 'lur' : 'lurar'})</span>
			</span>
		</div>
		{#if showTrendRow}
			<div class="insights-row insights-trend-row">
				<span class="insights-label">Trendmål (7d/30d)</span>
				<span class="insights-value">{trendTotalLabel}</span>
			</div>
		{/if}
		{#if trustLabel}
			<div class="insights-trust">{trustLabel} · {calibration?.daysWithData ?? 0} dagar med data</div>
		{/if}
	</div>
	{:else}
	<div class="insights-collapsed-summary">
		Lur {napDurLabel} · Natt {nightDurLabel} · Totalt {totalSleepLabel}
	</div>
	{/if}
</div>

<style>
	.insights-card {
		background: var(--bg-card, rgba(255, 255, 255, 0.06));
		border-radius: 12px;
		padding: 10px 16px;
		margin: 0 16px;
	}

	.insights-title {
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-light);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		width: 100%;
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-family: inherit;
	}

	.insights-chevron {
		font-size: 0.7rem;
		opacity: 0.6;
	}

	.insights-rows {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 8px;
	}

	.insights-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: 0.85rem;
	}

	.insights-label {
		color: var(--text-light);
	}

	.insights-value {
		font-weight: 500;
	}

	.insights-detail {
		font-size: 0.75rem;
		color: var(--text-light);
		font-weight: 400;
	}

	.insights-trend-row {
		border-top: 1px solid var(--lavender-dark, rgba(255, 255, 255, 0.08));
		padding-top: 4px;
		margin-top: 2px;
	}

	.insights-trust {
		font-size: 0.75rem;
		color: var(--text-light);
		margin-top: 4px;
		text-align: right;
	}

	.insights-collapsed-summary {
		font-size: 0.8rem;
		color: var(--text-light);
		margin-top: 4px;
	}
</style>
