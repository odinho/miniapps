<script lang="ts">
	import type { SleepLogRow, NightWakingRow } from '$lib/types.js';
	import type { Prediction } from '$lib/stores/app.svelte.js';
	import { getTimerMode, getAwakeSince } from '$lib/timer-state.js';
	import { formatDurationLong, formatDuration, formatTime } from '$lib/utils.js';

	interface Props {
		activeSleep: SleepLogRow | null;
		prediction: Prediction | null;
		todayWakeUp: { wake_time: string | null } | null;
		todaySleeps: SleepLogRow[];
		todayNightWakings?: NightWakingRow[];
		targetBedtime?: string | null;
		/** Override internal clock (ms since epoch). Used by the dev playground. */
		nowMs?: number;
		onEditStart?: () => void;
	}

	let { activeSleep, prediction, todayWakeUp, todaySleeps, todayNightWakings = [], targetBedtime = null, nowMs, onEditStart }: Props = $props();

	let _now = $state(Date.now());
	const now = $derived(nowMs !== undefined ? nowMs : _now);

	// Tick every second when sleeping (need precise timer), every 10s otherwise
	$effect(() => {
		if (nowMs !== undefined) return;
		const ms = activeSleep ? 1000 : 10_000;
		const iv = setInterval(() => {
			_now = Date.now();
		}, ms);
		return () => clearInterval(iv);
	});

	const input = $derived({ activeSleep, prediction, todayWakeUp, todaySleeps, todayNightWakings, now });
	const mode = $derived(getTimerMode(input));
	const awakeMs = $derived(getAwakeSince(input));

	// Confidence range for current prediction
	const confidenceLabel = $derived.by(() => {
		if (!prediction?.confidence) return null;
		const conf = prediction.confidence;
		if (mode.kind === 'next-nap' || mode.kind === 'overtime') {
			// Show range for next nap
			const nextRange = conf.napRanges[0]?.startRange;
			if (nextRange && nextRange.sdMinutes > 0) {
				return `±${Math.round(nextRange.sdMinutes)} min`;
			}
		}
		if (mode.kind === 'bedtime' || mode.kind === 'after-bedtime') {
			const br = conf.bedtimeRange;
			if (br && br.sdMinutes > 0) {
				return `±${Math.round(br.sdMinutes)} min`;
			}
		}
		return null;
	});

	const trustLabel = $derived.by(() => {
		if (!prediction?.calibration) return null;
		const trust = prediction.calibration.trust;
		if (trust === 'learned') return 'Tilpassa';
		if (trust === 'partial') return 'Delvis tilpassa';
		return 'Aldersbasert';
	});

	const trustClass = $derived.by(() => {
		if (!prediction?.calibration) return '';
		return `trust-${prediction.calibration.trust}`;
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="arc-center-text" style={onEditStart && mode.kind === 'sleeping' ? 'cursor: pointer;' : ''} onclick={mode.kind === 'sleeping' ? onEditStart : undefined}>
	{#if mode.kind === 'sleeping'}
		<div class="arc-center-label">{mode.label}</div>
		<span class="countdown-value">{formatDurationLong(mode.elapsed)}</span>
		{#if mode.expectedWake && mode.expectedWakeCountdown != null}
			{#if mode.expectedWakeCountdown > 0}
				<div class="arc-sub-label" style="opacity: 0.8;">Vaknar ~{formatTime(mode.expectedWake)} ({formatDuration(mode.expectedWakeCountdown)})</div>
			{:else if mode.expectedWakeCountdown < -60000}
				<div class="arc-sub-label" style="opacity: 0.8; color: var(--peach-dark);">+{formatDuration(Math.abs(mode.expectedWakeCountdown))} over forventa</div>
			{/if}
		{/if}
		{#if mode.cyclePhase}
			<div class="arc-sub-label" style="opacity: 0.7; font-size: 0.7rem; margin-top: 2px;">
				{#if mode.cyclePhase.isLightPhase}
					<span style="color: var(--lavender-dark);">💡 Truleg lett fase no</span>
				{:else}
					<span>~{mode.cyclePhase.minutesToNextLight}m til neste lette fase</span>
				{/if}
			</div>
		{/if}
	{:else if mode.kind === 'deep-night'}
		<div class="arc-center-label">God natt 💤</div>
		{#if mode.wakeCountdown != null && mode.wakeTime}
			<span class="countdown-value">{formatDuration(mode.wakeCountdown)}</span>
			<div class="arc-sub-label">Vaknar {formatTime(mode.wakeTime)}</div>
		{/if}
	{:else if mode.kind === 'next-nap'}
		<div class="arc-center-label">Neste lur</div>
		<span class="countdown-value">{formatDuration(mode.countdown)}</span>
		{#if confidenceLabel}
			<div class="arc-sub-label confidence-range" data-testid="confidence-range">{confidenceLabel}</div>
		{/if}
	{:else if mode.kind === 'overtime'}
		<div class="arc-center-label">Overtid</div>
		<span class="countdown-value" style="color: var(--peach-dark)">+{formatDuration(mode.overtime)}</span>
		{#if confidenceLabel}
			<div class="arc-sub-label confidence-range" data-testid="confidence-range">{confidenceLabel}</div>
		{/if}
	{:else if mode.kind === 'bedtime'}
		<div class="arc-center-label">Leggetid om</div>
		<span class="countdown-value">{formatDuration(mode.countdown)}</span>
		{#if confidenceLabel}
			<div class="arc-sub-label confidence-range" data-testid="confidence-range">{confidenceLabel}</div>
		{/if}
		{#if prediction?.feasible === false}
			<div class="arc-sub-label" style="color: var(--peach-dark); font-size: 0.7rem;">Målet ditt{targetBedtime ? ` (${targetBedtime})` : ''} er ikkje nåeleg i dag</div>
		{/if}
	{:else if mode.kind === 'after-bedtime'}
		<div class="arc-center-label">Etter leggetid</div>
		<span class="countdown-value">{formatTime(mode.bedtime)}</span>
		{#if mode.nextCycleTarget}
			<!-- Cycle-aligned next target. Helps the parent decide whether
			     to put baby down now or wait the few minutes until the next
			     light-phase boundary. -->
			<div class="arc-sub-label" style="opacity: 0.8;">
				💡 Neste søvnsyklus kl. {formatTime(mode.nextCycleTarget)}
				<span style="opacity: 0.7;">({formatDuration(new Date(mode.nextCycleTarget).getTime() - (nowMs ?? Date.now()))} att, ~{mode.cycleMin}m-syklus)</span>
			</div>
		{/if}
	{:else if mode.kind === 'skipped-nap'}
		<div class="arc-center-label">Hoppa over lur</div>
		<span class="countdown-value" style="font-size: 2.2rem;">{formatTime(mode.plannedAt)}</span>
		<div class="arc-sub-label" style="opacity: 0.8;">{formatDuration(mode.plannedAgoMs)} sidan</div>
		{#if mode.postSkipPlan?.kind === 'rescue'}
			<div class="arc-sub-label rescue-tip" data-testid="post-skip-tip">
				💡 Vurder ein kort ekstralur ca. kl. {formatTime(mode.postSkipPlan.recommendedStart)}
				<span style="opacity: 0.75; white-space: nowrap;">— vekk innan {formatTime(mode.postSkipPlan.wakeBy)}</span>
			</div>
		{:else if mode.postSkipPlan?.kind === 'earlier-bedtime'}
			<div class="arc-sub-label rescue-tip" data-testid="post-skip-tip">
				💡 Vurder tidlegare leggetid kl. {formatTime(mode.postSkipPlan.suggestedBedtime)}
				<span style="opacity: 0.7;">({mode.postSkipPlan.minutesEarlier}m før normalt)</span>
			</div>
		{:else if mode.bedtime && mode.bedtimeCountdown != null && mode.bedtimeCountdown > 0}
			<div class="arc-sub-label" style="opacity: 0.7;">Leggetid kl. {formatTime(mode.bedtime)} ({formatDuration(mode.bedtimeCountdown)})</div>
		{/if}
	{:else if mode.kind === 'sleep-window'}
		{#if mode.pressure === 'high'}
			<div class="arc-center-label">Søvnvindauge no</div>
			<span class="countdown-value" style="color: var(--peach-dark)">💤</span>
		{:else if mode.windowStart <= 0}
			<div class="arc-center-label">Søvnvindauge ope</div>
			<span class="countdown-value">{formatDuration(mode.windowEnd)}</span>
			<div class="arc-sub-label">att</div>
		{:else}
			<div class="arc-center-label">Søvnvindauge om</div>
			<span class="countdown-value">{formatDuration(mode.windowStart)}</span>
		{/if}
	{/if}

	{#if mode.kind !== 'sleeping' && mode.kind !== 'deep-night' && mode.kind !== 'idle' && awakeMs != null}
		<div class="arc-sub-label">Vaken {formatDuration(awakeMs)}</div>
	{/if}
	{#if trustLabel && mode.kind !== 'sleeping' && mode.kind !== 'deep-night' && mode.kind !== 'idle'}
		<div class="trust-badge {trustClass}" data-testid="trust-badge">{trustLabel}</div>
	{/if}
</div>
