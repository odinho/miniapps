<script lang="ts">
	import type { SleepLogRow } from '$lib/types.js';
	import type { Prediction } from '$lib/stores/app.svelte.js';
	import { getTimerMode, getAwakeSince } from '$lib/timer-state.js';
	import { formatDurationLong, formatDuration, formatTime } from '$lib/utils.js';

	interface Props {
		activeSleep: SleepLogRow | null;
		prediction: Prediction | null;
		todayWakeUp: { wake_time: string } | null;
		todaySleeps: SleepLogRow[];
		onEditStart?: () => void;
	}

	let { activeSleep, prediction, todayWakeUp, todaySleeps, onEditStart }: Props = $props();

	let now = $state(Date.now());

	// Tick every second when sleeping (need precise timer), every 10s otherwise
	$effect(() => {
		const ms = activeSleep ? 1000 : 10_000;
		const iv = setInterval(() => {
			now = Date.now();
		}, ms);
		return () => clearInterval(iv);
	});

	const input = $derived({ activeSleep, prediction, todayWakeUp, todaySleeps, now });
	const mode = $derived(getTimerMode(input));
	const awakeMs = $derived(getAwakeSince(input));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="arc-center-text" style={onEditStart && mode.kind === 'sleeping' ? 'cursor: pointer;' : ''} onclick={mode.kind === 'sleeping' ? onEditStart : undefined}>
	{#if mode.kind === 'sleeping'}
		<div class="arc-center-label">{mode.label}</div>
		<span class="countdown-value">{formatDurationLong(mode.elapsed)}</span>
		{#if activeSleep?.type === 'nap' && prediction?.bedtime}
			<div class="arc-sub-label">Leggetid ~{formatTime(prediction.bedtime)}</div>
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
	{:else if mode.kind === 'overtime'}
		<div class="arc-center-label">Overtid</div>
		<span class="countdown-value" style="color: var(--peach-dark)">+{formatDuration(mode.overtime)}</span>
	{:else if mode.kind === 'bedtime'}
		<div class="arc-center-label">Leggetid om</div>
		<span class="countdown-value">{formatDuration(mode.countdown)}</span>
		<div class="arc-sub-label">{formatTime(mode.bedtime)}</div>
	{:else if mode.kind === 'after-bedtime'}
		<div class="arc-center-label">Etter leggetid</div>
		<span class="countdown-value">{formatTime(mode.bedtime)}</span>
	{/if}

	{#if mode.kind !== 'sleeping' && mode.kind !== 'deep-night' && mode.kind !== 'idle' && awakeMs != null}
		<div class="arc-sub-label">Vaken {formatDuration(awakeMs)}</div>
	{/if}
</div>
