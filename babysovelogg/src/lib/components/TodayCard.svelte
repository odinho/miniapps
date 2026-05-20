<script lang="ts">
	import type { SleepLogRow } from '$lib/types.js';
	import type { SleepDayTotals } from '$lib/engine/stats.js';
	import type { Prediction } from '$lib/stores/app.svelte.js';
	import { formatDuration, formatDurationCompact, formatTime } from '$lib/utils.js';

	interface Props {
		/** The overnight that ended this morning, or null when none logged. */
		priorOvernightSleep: SleepLogRow | null;
		/** Wake-to-wake totals so far today. */
		dayTotals: SleepDayTotals | null;
		/** All of today's sleep rows (used to list completed naps). */
		todaySleeps: SleepLogRow[];
		/** Engine prediction for the rest of the day. */
		prediction: Prediction | null;
		/** Currently-active sleep, if any. Drives the "reset to predicted" framing. */
		activeSleep: SleepLogRow | null;
	}

	let { priorOvernightSleep, dayTotals, todaySleeps, prediction, activeSleep }: Props = $props();

	const fcMs = (min: number): string => formatDurationCompact(min * 60_000);

	const completedNaps = $derived(
		todaySleeps
			.filter((s) => s.type === 'nap' && s.end_time)
			.toSorted((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()),
	);

	const priorNightMin = $derived(dayTotals?.priorNightMinutes ?? 0);
	const totalMin = $derived(dayTotals?.totalMinutes ?? 0);
	const hasMultipleRows = $derived(
		(priorNightMin > 0 ? 1 : 0) + completedNaps.length >= 2,
	);

	// "Neste" line: what the parent should anticipate next.
	const nextLine = $derived.by(() => {
		if (!prediction) return null;
		// During active sleep the Timer center carries elapsed + expected wake;
		// don't duplicate it here.
		if (activeSleep && !activeSleep.end_time) return null;
		if (prediction.napsAllDone && prediction.bedtime) {
			return { label: 'Leggetid', time: prediction.bedtime, kind: 'bedtime' as const };
		}
		if (prediction.nextNap) {
			return { label: 'Neste lur', time: prediction.nextNap, kind: 'nap' as const };
		}
		if (prediction.bedtime) {
			return { label: 'Leggetid', time: prediction.bedtime, kind: 'bedtime' as const };
		}
		return null;
	});

	const showCard = $derived(
		priorNightMin > 0 || completedNaps.length > 0 || nextLine != null,
	);
</script>

{#if showCard}
	<div class="today-card" data-testid="today-card">
		<div class="today-card-title">I dag</div>
		<div class="today-rows">
			{#if priorNightMin > 0 && priorOvernightSleep?.end_time}
				<div class="today-row" data-testid="today-row-night">
					<div class="today-row-head">
						<span class="today-row-label">Natt</span>
						<span class="today-row-value">{fcMs(priorNightMin)}</span>
					</div>
					<div class="today-row-sub">
						{formatTime(priorOvernightSleep.start_time)}–{formatTime(priorOvernightSleep.end_time)}
					</div>
				</div>
			{/if}
			{#each completedNaps as nap, i}
				{@const durMin = Math.round(
					(new Date(nap.end_time!).getTime() - new Date(nap.start_time).getTime()) / 60_000,
				)}
				<div class="today-row" data-testid="today-row-nap-{i}">
					<div class="today-row-head">
						<span class="today-row-label">
							{completedNaps.length === 1 ? 'Lur' : `Lur ${i + 1}`}
						</span>
						<span class="today-row-value">{fcMs(durMin)}</span>
					</div>
					<div class="today-row-sub">
						{formatTime(nap.start_time)}–{formatTime(nap.end_time!)}
					</div>
				</div>
			{/each}
			{#if hasMultipleRows && totalMin > 0}
				<div class="today-row today-row-total" data-testid="today-row-total">
					<div class="today-row-head">
						<span class="today-row-label">I alt så langt</span>
						<span class="today-row-value">{fcMs(totalMin)}</span>
					</div>
				</div>
			{/if}
			{#if nextLine}
				<div class="today-next" data-testid="today-next">
					<span class="today-next-label">{nextLine.label}</span>
					<span class="today-next-value">
						kl. {formatTime(nextLine.time)}
						<span class="today-next-countdown">({formatDuration(new Date(nextLine.time).getTime() - Date.now())})</span>
					</span>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.today-card {
		background: var(--bg-card, rgba(255, 255, 255, 0.06));
		border-radius: 12px;
		padding: 10px 16px 12px;
		margin: 0 16px;
	}

	.today-card-title {
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-light);
	}

	.today-rows {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 8px;
	}

	.today-row {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.today-row-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
	}

	.today-row-label {
		font-size: 0.85rem;
		color: var(--text);
	}

	.today-row-value {
		font-size: 1.05rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}

	.today-row-sub {
		font-size: 0.72rem;
		color: var(--text-light);
		line-height: 1.3;
	}

	.today-row-total {
		border-top: 1px solid var(--lavender-dark, rgba(255, 255, 255, 0.08));
		padding-top: 6px;
		margin-top: 2px;
	}

	.today-row-total .today-row-value {
		font-size: 1.1rem;
	}

	.today-next {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		font-size: 0.85rem;
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px dashed var(--lavender-dark, rgba(255, 255, 255, 0.08));
	}

	.today-next-label {
		color: var(--text-light);
	}

	.today-next-value {
		font-weight: 500;
		font-variant-numeric: tabular-nums;
	}

	.today-next-countdown {
		color: var(--text-light);
		font-weight: 400;
		margin-left: 4px;
	}
</style>
