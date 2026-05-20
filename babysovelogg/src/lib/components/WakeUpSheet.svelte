<script lang="ts">
	import type { SleepLogRow } from '$lib/types.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import { appState } from '$lib/stores/app.svelte.js';
	import { WOKE_OPTIONS, buildWakeUpEvent, getBedtimeSummary } from '$lib/wake-sheet-actions.js';
	import { WAKE_MOODS } from '$lib/constants.js';
	import { formatDuration, formatTime } from '$lib/utils.js';
	import { toggleOffDay, localDateForOffDay } from '$lib/off-day-actions.js';
	import TimeInput from './TimeInput.svelte';

	interface Props {
		sleepDomainId: string;
		sleepSnapshot: SleepLogRow;
		onClose?: () => void;
	}

	let { sleepDomainId, sleepSnapshot, onClose }: Props = $props();

	// Detect trailing pause (active pause = baby never went back to sleep)
	// svelte-ignore state_referenced_locally — intentional: snapshot is immutable once passed
	const trailingPause = sleepSnapshot.pauses?.findLast(p => !p.resume_time) ?? null;
	// svelte-ignore state_referenced_locally
	const trailingPauseIdx = sleepSnapshot.pauses?.findLastIndex(p => !p.resume_time) ?? -1;

	// svelte-ignore state_referenced_locally — intentional: snapshot is immutable once passed
	const defaultWakeTime = trailingPause
		? new Date(trailingPause.pause_time)
		: sleepSnapshot.end_time ? new Date(sleepSnapshot.end_time) : new Date();
	let wakeTime = $state(defaultWakeTime.toTimeString().slice(0, 5));
	let wakeDate = $state(`${defaultWakeTime.getFullYear()}-${String(defaultWakeTime.getMonth() + 1).padStart(2, '0')}-${String(defaultWakeTime.getDate()).padStart(2, '0')}`);

	let wokeBy = $state<string | null>(null);
	let wakeMood = $state<string | null>(null);
	let notes = $state('');
	let busy = $state(false);

	const summary = $derived(getBedtimeSummary(sleepSnapshot));

	// Reactive sleep duration
	const sleepDurationMs = $derived.by(() => {
		const start = new Date(sleepSnapshot.start_time).getTime();
		const end = new Date(`${wakeDate}T${wakeTime}:00`).getTime();
		return Math.max(0, end - start);
	});

	const MAX_NAP_HOURS = 4;
	const isLongNap = $derived(
		sleepSnapshot.type === 'nap' && sleepDurationMs > MAX_NAP_HOURS * 60 * 60 * 1000,
	);

	async function convertToNight() {
		if (busy) return;
		busy = true;
		try {
			await sync.sendEvents([{
				type: 'sleep.updated',
				payload: { sleepDomainId, type: 'night' },
			}]);
			onClose?.();
		} finally {
			busy = false;
		}
	}

	// Did the user change the wake time?
	const wakeTimeChanged = $derived.by(() => {
		const original = defaultWakeTime.toTimeString().slice(0, 5);
		return wakeTime !== original;
	});

	function adjustWakeMinutes(delta: number) {
		const d = new Date(`${wakeDate}T${wakeTime}:00`);
		d.setMinutes(d.getMinutes() + delta);
		wakeDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		wakeTime = d.toTimeString().slice(0, 5);
	}

	function toggleWokeBy(value: string) {
		wokeBy = wokeBy === value ? null : value;
	}

	function toggleWakeMood(value: string) {
		wakeMood = wakeMood === value ? null : value;
	}

	async function save() {
		if (busy) return;
		busy = true;
		try {
			const endTimeIso = wakeTimeChanged
				? new Date(`${wakeDate}T${wakeTime}:00`).toISOString()
				: trailingPause
					? new Date(trailingPause.pause_time).toISOString()
					: null;
			const event = buildWakeUpEvent(sleepDomainId, wokeBy, notes, endTimeIso, wakeMood);
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			// Delete trailing pause (it wasn't real sleep time)
			if (trailingPause && trailingPauseIdx >= 0) {
				events.push({
					type: 'sleep.pause_deleted',
					payload: { sleepDomainId, pauseIndex: trailingPauseIdx },
				});
			}
			if (event) events.push(event);

			if (events.length > 0) {
				const result = await sync.sendEvents(events);
				if (result == null) {
					// Server rejected (4xx/5xx). Keep the sheet open so the parent can
					// retry rather than silently losing the wake event.
					return;
				}
			}
			onClose?.();
		} finally {
			busy = false;
		}
	}

	function handleOverlayClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose?.();
	}

	// Off-day toggle for the day this wake belongs to. For a *night* sleep
	// the wake instant is the morning the parent is now reviewing — that's
	// the right date to flag (sick night → sick morning). For naps we still
	// key on the wake's local-date, which is the same day the nap belongs
	// to in the common case.
	const baby = $derived(appState.state.baby);
	const offDays = $derived(appState.state.offDays);
	const wakeDateForOffDay = $derived.by(() => {
		if (!baby) return null;
		const wakeIso = new Date(`${wakeDate}T${wakeTime}:00`).toISOString();
		return localDateForOffDay(wakeIso, baby.timezone || 'UTC');
	});
	const isOffDay = $derived(
		wakeDateForOffDay != null && offDays.includes(wakeDateForOffDay),
	);
	let offDayBusy = $state(false);
	async function toggleOffDayForWake() {
		if (offDayBusy || !baby || !wakeDateForOffDay) return;
		offDayBusy = true;
		try {
			await toggleOffDay(baby.id, wakeDateForOffDay, isOffDay);
		} finally {
			offDayBusy = false;
		}
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={handleOverlayClick} data-testid="modal-overlay">
	<div class="modal" data-testid="wake-up-sheet">
		<h2>Oppvakning</h2>

		<!-- Compact bedtime summary -->
		{#if summary.hasTags}
			<div class="bedtime-summary" data-testid="bedtime-summary">
				<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: {summary.badges.length > 0 || summary.fallAsleepLabel || summary.notes ? '4px' : '0'}">
					<span style="font-size: 0.75rem; font-weight: 600; color: var(--text-light); text-transform: uppercase; letter-spacing: 0.03em;">Legging</span>
				</div>
				{#if summary.badges.length > 0 || summary.fallAsleepLabel}
					<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
						{#each summary.badges as badge}
							<span class="tag-badge" title={badge.title}>{badge.emoji}</span>
						{/each}
						{#if summary.fallAsleepLabel}
							<span style="color: var(--text-light); font-size: 0.8rem;">⏱️ {summary.fallAsleepLabel}</span>
						{/if}
					</div>
				{/if}
				{#if summary.notes}
					<div style="font-style: italic; font-size: 0.8rem; color: var(--text-light); margin-top: 4px;">
						"{summary.notes}"
					</div>
				{/if}
			</div>
		{/if}

		<!-- Trailing pause notice -->
		{#if trailingPause}
			<div style="background: var(--lavender); padding: 10px 12px; border-radius: var(--radius-sm); margin-bottom: 8px; font-size: 0.8rem; color: var(--text);">
				⏸️ Pausen frå {formatTime(trailingPause.pause_time)} vert fjerna og vaknetida sett dit.
			</div>
		{/if}

		<!-- Sleep duration -->
		<div style="text-align: center; margin: 4px 0 8px; font-size: 1.1rem; font-weight: 600; color: var(--text);" data-testid="sleep-duration">
			Sov {formatDuration(sleepDurationMs)}
		</div>

		{#if isLongNap}
			<div class="long-nap-warning" data-testid="long-nap-warning" style="background: var(--peach); padding: 12px; border-radius: var(--radius-sm); margin-bottom: 12px; color: var(--cream-dark);">
				<p style="margin: 0 0 8px; font-size: 0.85rem; font-weight: 600;">
					⚠️ Denne luren er uvanleg lang
				</p>
				<p style="margin: 0 0 8px; font-size: 0.8rem;">
					Gløymde du å stoppa? Sjekk vaknetida ovanfor, eller gjer om til nattesøvn:
				</p>
				<button class="btn btn-ghost" style="width: 100%; font-size: 0.85rem;" onclick={convertToNight} disabled={busy}>
					🌙 Gjer om til nattesøvn
				</button>
			</div>
		{/if}

		<!-- Wake time -->
		<div class="form-group">
			<span class="form-label">Vaknetid</span>
			<div class="datetime-row">
				<TimeInput bind:value={wakeTime} data-testid="wake-time" />
			</div>
			<div style="display: flex; gap: 6px; margin-top: 6px; justify-content: center;">
				<button class="btn btn-ghost" style="padding: 4px 10px; min-height: 0; font-size: 0.8rem;" onclick={() => adjustWakeMinutes(-5)}>-5 min</button>
				<button class="btn btn-ghost" style="padding: 4px 10px; min-height: 0; font-size: 0.8rem;" onclick={() => adjustWakeMinutes(-1)}>-1 min</button>
				<button class="btn btn-ghost" style="padding: 4px 10px; min-height: 0; font-size: 0.8rem;" onclick={() => adjustWakeMinutes(1)}>+1 min</button>
				<button class="btn btn-ghost" style="padding: 4px 10px; min-height: 0; font-size: 0.8rem;" onclick={() => adjustWakeMinutes(5)}>+5 min</button>
			</div>
		</div>

		<!-- Woke-by -->
		<div class="form-group">
			<span class="form-label">Oppvakning</span>
			<div class="type-pills">
				{#each WOKE_OPTIONS as option}
					<button
						class="type-pill"
						class:active={wokeBy === option.value}
						onclick={() => toggleWokeBy(option.value)}
						data-testid="woke-{option.value}"
					>
						{option.label}
					</button>
				{/each}
			</div>
		</div>

		<!-- Wake mood -->
		<div class="form-group">
			<span class="form-label">Humør etter ~5 min</span>
			<p style="font-size: 0.75rem; color: var(--text-light); margin: 0 0 6px;">
				Ikkje gråten med ein gong — det er berre kommunikasjon!
			</p>
			<div class="tag-pills">
				{#each WAKE_MOODS as m}
					<button
						class="tag-pill"
						class:active={wakeMood === m.value}
						onclick={() => toggleWakeMood(m.value)}
						data-testid="wake-mood-{m.value}"
					>
						<span class="tag-emoji">{m.label}</span>
						<span class="tag-label">{m.title}</span>
					</button>
				{/each}
			</div>
		</div>

		<!-- Notes -->
		<div class="form-group">
			<label for="wake-notes">Notat</label>
			<input
				id="wake-notes"
				type="text"
				placeholder="Valfritt notat..."
				bind:value={notes}
				data-testid="wake-notes"
			/>
		</div>

		<!-- Off-day toggle for this wake's date -->
		<div class="form-group">
			<button
				class="off-day-btn"
				class:active={isOffDay}
				onclick={toggleOffDayForWake}
				disabled={offDayBusy}
				data-testid="off-day-toggle-wake"
				aria-pressed={isOffDay}
				type="button"
			>
				{#if isOffDay}
					✅ Utypisk dag · halden utanfor trenden
				{:else}
					🤒 Utypisk dag (sjuk / reise / o.l.)
				{/if}
			</button>
		</div>

		<!-- Done button -->
		<button class="btn btn-primary" style="width: 100%; margin-top: 8px;" onclick={save} disabled={busy} data-testid="wake-done">
			Ferdig
		</button>
	</div>
</div>
