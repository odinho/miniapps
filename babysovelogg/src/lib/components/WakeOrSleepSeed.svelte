<script lang="ts">
	import DateInput from '$lib/components/DateInput.svelte';
	import TimeInput from '$lib/components/TimeInput.svelte';
	import { untrack } from 'svelte';
	import { isoToDateInTz } from '$lib/tz.js';
	import type { SeedChoice } from '$lib/settings-utils.js';

	interface Props {
		name: string;
		timezone: string;
		busy: boolean;
		canAddAnother: boolean;
		onSeed: (seed: SeedChoice) => void;
		onSeedAndAdd: (seed: SeedChoice) => void;
		onSkip: () => void;
	}

	let { name, timezone, busy, canAddAnother, onSeed, onSeedAndAdd, onSkip }: Props = $props();

	// Defaults are seeded once at mount. The parent remounts this component per
	// child (the `{#if seedBabyId}` flips off between additions), so capturing
	// the prop's initial value here is correct — no reactive re-read needed.
	const tz = untrack(() => timezone || 'UTC');
	const nowIso = new Date().toISOString();
	// Default by the local hour: daytime → they're awake (record wake time);
	// evening/night → they're already down (record bedtime). Uses getHours()
	// (not a tz helper) to match the rest of the app's day/night gating and stay
	// controllable from the test harness.
	const startHour = new Date().getHours();
	const initialMode: 'wake' | 'sleep' = startHour >= 5 && startHour < 18 ? 'wake' : 'sleep';
	let mode = $state<'wake' | 'sleep'>(initialMode);
	let date = $state(isoToDateInTz(nowIso, tz));
	let time = $state(initialMode === 'wake' ? '07:00' : '19:00');

	function setMode(next: 'wake' | 'sleep') {
		if (next === mode) return;
		mode = next;
		// Nudge the time toward a sensible default for the new question, but only
		// if the parent hasn't moved it off the other default yet.
		if (next === 'wake' && time === '19:00') time = '07:00';
		if (next === 'sleep' && time === '07:00') time = '19:00';
	}

	const choice = $derived<SeedChoice>({ kind: mode, date, time });
</script>

<div class="morning-prompt" data-testid="seed-step">
	<div class="morning-icon">{mode === 'wake' ? '🌅' : '🌙'}</div>
	<h2 data-testid="seed-question">
		{#if mode === 'wake'}
			Når vakna {name} i dag?
		{:else}
			Når sovna {name} i kveld?
		{/if}
	</h2>
	<p>Eit omtrentleg klokkeslett er nok — det hjelper oss å koma i gang.</p>

	<div class="type-pills" style="margin-bottom: 16px;">
		<button
			class="type-pill"
			class:active={mode === 'wake'}
			onclick={() => setMode('wake')}
			data-testid="seed-toggle-wake"
		>
			☀️ Vaken
		</button>
		<button
			class="type-pill"
			class:active={mode === 'sleep'}
			onclick={() => setMode('sleep')}
			data-testid="seed-toggle-sleep"
		>
			😴 Søv
		</button>
	</div>

	<div style="display: flex; gap: 8px; justify-content: center; margin-bottom: 8px;">
		<DateInput bind:value={date} data-testid="seed-date" />
		<TimeInput bind:value={time} data-testid="seed-time" />
	</div>

	<div class="seed-actions">
		<button class="btn btn-primary" onclick={() => onSeed(choice)} disabled={busy} data-testid="seed-primary">
			Kom i gang ✨
		</button>
		{#if canAddAnother}
			<button
				class="btn btn-ghost"
				onclick={() => onSeedAndAdd(choice)}
				disabled={busy}
				data-testid="seed-add-another"
			>
				+ Legg til eit barn til
			</button>
		{/if}
		<button class="seed-skip" onclick={onSkip} disabled={busy} data-testid="seed-skip">
			Hopp over
		</button>
	</div>
</div>

<style>
	.seed-actions {
		margin-top: 24px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	/* Skip is an escape hatch, not a primary path — keep it a quiet text link
	   under the real actions, not a third competing button. */
	.seed-skip {
		align-self: center;
		margin-top: 2px;
		background: none;
		border: none;
		padding: 4px;
		font: inherit;
		font-size: 0.8rem;
		color: var(--text-light);
		cursor: pointer;
	}

	.seed-skip:hover {
		text-decoration: underline;
	}

	.seed-skip:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
