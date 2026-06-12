<script lang="ts">
	import { sync } from '$lib/stores/sync.svelte.js';
	import { appState } from '$lib/stores/app.svelte.js';
	import { MOODS, METHODS, FALL_ASLEEP_BUCKETS } from '$lib/constants.js';
	import { formatTime } from '$lib/utils.js';
	import {
		nudgeTime,
		shouldShowDiaperNudge,
		collectTagSheetEvents,
	} from '$lib/tag-sheet-actions.js';
	import { toggleOffDay, localDateForOffDay } from '$lib/off-day-actions.js';

	interface Props {
		sleepDomainId: string;
		startTime: string;
		lastDiaperTime: string | null;
		pottyMode?: boolean;
		trackDiaper?: boolean;
		/** The baby this sheet acts on. Required in multi-child focus mode so the
		 *  off-day toggle hits the right child; falls back to the primary alias. */
		baby?: import('$lib/types.js').Baby | null;
		offDays?: string[];
		onClose?: () => void;
		onOpenDiaper?: () => void;
	}

	let { sleepDomainId, startTime, lastDiaperTime, pottyMode = false, trackDiaper = false, baby, offDays, onClose, onOpenDiaper }: Props =
		$props();

	let mood = $state<string | null>(null);
	let method = $state<string | null>(null);
	let fallAsleepTime = $state<string | null>(null);
	let onsetNote = $state('');
	let notes = $state('');
	// svelte-ignore state_referenced_locally — intentional: local copy of initial prop
	let adjustedStartTime = $state(startTime);
	let showDatePicker = $state(false);
	let busy = $state(false);

	const displayTime = $derived(formatTime(adjustedStartTime));
	const showDiaperNudge = $derived(trackDiaper && shouldShowDiaperNudge(lastDiaperTime));

	const latencyFeedback = $derived.by(() => {
		if (!fallAsleepTime) return null;
		switch (fallAsleepTime) {
			case '<5':
				return { text: 'Raskt innsovning', color: 'var(--lavender)' };
			case '5-20':
				return { text: 'Normal innsovning', color: 'var(--lavender)' };
			case '20+':
				return { text: 'Lang innsovning — babyen var truleg ikkje trøytt nok', color: 'var(--peach)' };
			default:
				return null;
		}
	});

	// Show onset note when something went wrong (upset/fighting mood or long latency)
	const showOnsetNote = $derived(
		mood === 'upset' || mood === 'fighting' || fallAsleepTime === '20+',
	);

	// Clear onset note text when conditions no longer apply (prevents stale data)
	$effect(() => {
		if (!showOnsetNote) onsetNote = '';
	});

	function toggleMood(value: string) {
		mood = mood === value ? null : value;
	}

	function toggleMethod(value: string) {
		method = method === value ? null : value;
	}

	function toggleFallAsleep(value: string) {
		fallAsleepTime = fallAsleepTime === value ? null : value;
	}

	function handleNudge(minutes: number) {
		adjustedStartTime = nudgeTime(adjustedStartTime, minutes);
	}

	function handleDateTimeChange(e: Event) {
		const input = e.target as HTMLInputElement;
		if (!input.value) return;
		adjustedStartTime = new Date(input.value).toISOString();
	}

	async function save() {
		if (busy) return;
		busy = true;
		try {
			const events = collectTagSheetEvents(
				sleepDomainId,
				startTime,
				adjustedStartTime,
				mood,
				method,
				fallAsleepTime,
				notes,
				onsetNote,
			);
			if (events.length > 0) {
				await sync.sendEvents(events);
			}
		} finally {
			busy = false;
			onClose?.();
		}
	}

	function handleOverlayClick(e: MouseEvent) {
		if (e.target === e.currentTarget) save();
	}

	function handleDiaperClick() {
		save();
		onOpenDiaper?.();
	}

	/** Convert ISO to local datetime-local input value */
	function toDatetimeLocal(iso: string): string {
		const d = new Date(iso);
		return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
	}

	// Off-day toggle for the day this sleep starts on. The parent landing
	// in this sheet just put the baby down — natural moment to flag a
	// known-atypical day. Re-derives if the start time gets nudged across
	// midnight (rare; defensive).
	// Use the passed-in (focused) baby/off-days, falling back to the primary
	// alias for single-baby callers. Reading the alias directly would mark the
	// WRONG child's day off in multi-child focus mode.
	const offDayBaby = $derived(baby ?? appState.state.baby);
	const offDayList = $derived(offDays ?? appState.state.offDays);
	const sleepDateForOffDay = $derived.by(() => {
		if (!offDayBaby) return null;
		return localDateForOffDay(adjustedStartTime, offDayBaby.timezone || 'UTC');
	});
	const isOffDay = $derived(
		sleepDateForOffDay != null && offDayList.includes(sleepDateForOffDay),
	);
	let offDayBusy = $state(false);
	async function toggleOffDayForSleep() {
		if (offDayBusy || !offDayBaby || !sleepDateForOffDay) return;
		offDayBusy = true;
		try {
			await toggleOffDay(offDayBaby.id, sleepDateForOffDay, isOffDay);
		} finally {
			offDayBusy = false;
		}
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={handleOverlayClick} data-testid="modal-overlay">
	<div class="modal" data-testid="tag-sheet">
		<h2>Korleis gjekk legginga?</h2>

		<!-- Start time adjustment -->
		<div class="form-group">
			<span class="form-label">Starttid</span>
			<div class="wake-time-row">
				<span class="wake-time-display">{displayTime}</span>
				<button class="btn btn-ghost nudge-btn" onclick={() => handleNudge(1)}>-1 min</button>
				<button class="btn btn-ghost nudge-btn" onclick={() => handleNudge(5)}>-5 min</button>
				<button class="edit-start-link" onclick={() => (showDatePicker = !showDatePicker)}>
					endra
				</button>
			</div>
			{#if showDatePicker}
				<div class="datetime-row">
					<input
						type="datetime-local"
						value={toDatetimeLocal(adjustedStartTime)}
						onchange={handleDateTimeChange}
					/>
				</div>
			{/if}
		</div>

		<!-- Mood -->
		<div class="form-group">
			<span class="form-label">Humør ved legging</span>
			<div class="tag-pills">
				{#each MOODS as m}
					<button
						class="tag-pill"
						class:active={mood === m.value}
						onclick={() => toggleMood(m.value)}
						data-testid="mood-{m.value}"
					>
						<span class="tag-emoji">{m.label}</span>
						<span class="tag-label">{m.title}</span>
					</button>
				{/each}
			</div>
		</div>

		<!-- Method -->
		<div class="form-group">
			<span class="form-label">Metode</span>
			<div class="tag-pills">
				{#each METHODS as m}
					<button
						class="tag-pill"
						class:active={method === m.value}
						onclick={() => toggleMethod(m.value)}
						data-testid="method-{m.value}"
					>
						<span class="tag-emoji">{m.label}</span>
						<span class="tag-label">{m.title}</span>
					</button>
				{/each}
			</div>
		</div>

		<!-- Fall asleep time -->
		<div class="form-group">
			<span class="form-label">Innsovningstid</span>
			<div class="type-pills">
				{#each FALL_ASLEEP_BUCKETS as bucket}
					<button
						class="type-pill"
						class:active={fallAsleepTime === bucket.value}
						onclick={() => toggleFallAsleep(bucket.value)}
						data-testid="fall-asleep-{bucket.value}"
					>
						{bucket.label}
					</button>
				{/each}
			</div>
			{#if latencyFeedback}
				<p class="latency-feedback" style="background: {latencyFeedback.color};" data-testid="latency-feedback">
					{latencyFeedback.text}
				</p>
			{/if}
		</div>

		<!-- Onset note (conditional — shown when mood or latency indicates difficulty) -->
		{#if showOnsetNote}
			<div class="form-group" data-testid="onset-note-group">
				<label for="onset-note">Kva skjedde?</label>
				<input
					id="onset-note"
					type="text"
					placeholder="T.d. vondt i magen, svolten, uroleg..."
					bind:value={onsetNote}
					data-testid="onset-note"
				/>
			</div>
		{/if}

		<!-- Notes -->
		<div class="form-group">
			<label for="tag-notes">Notat</label>
			<input
				id="tag-notes"
				type="text"
				placeholder="Valfritt notat..."
				bind:value={notes}
				data-testid="tag-notes"
			/>
		</div>

		<!-- Off-day toggle for the day this sleep starts on -->
		<div class="form-group">
			<button
				class="off-day-btn"
				class:active={isOffDay}
				onclick={toggleOffDayForSleep}
				disabled={offDayBusy}
				data-testid="off-day-toggle-tag"
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

		<!-- Diaper nudge -->
		{#if showDiaperNudge}
			<div class="form-group" data-testid="diaper-nudge">
				<p style="background: var(--lavender); padding: 12px; border-radius: var(--radius-sm); font-size: 0.9rem;">
					{pottyMode ? '🚽 Ikkje vore på do dei siste 2 timane' : '🧷 Inga bleie dei siste 2 timane'}
				</p>
				<button class="btn btn-ghost" onclick={handleDiaperClick} data-testid="diaper-nudge-btn">
					{pottyMode ? 'Logg do' : 'Logg bleie'}
				</button>
			</div>
		{/if}

		<!-- Done button -->
		<button class="btn btn-primary" style="width: 100%; margin-top: 8px;" onclick={save} disabled={busy} data-testid="tag-done">
			Ferdig
		</button>
	</div>
</div>
