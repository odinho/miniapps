<script lang="ts">
	import type { SleepLogRow } from '$lib/types.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import { appState } from '$lib/stores/app.svelte.js';
	import { MOODS, METHODS, FALL_ASLEEP_BUCKETS, WAKE_MOODS } from '$lib/constants.js';
	import {
		SLEEP_TYPES,
		buildSleepUpdateEvent,
		buildSleepDeleteEvent,
		isoToDateInput,
		isoToTimeInput,
		dateTimeToIso,
		isEndAtOrBeforeStart,
	} from '$lib/history-utils.js';
	import { isWithinEndUndoWindow } from '$lib/end-undo.js';
	import TimeInput from './TimeInput.svelte';
	import DateInput from './DateInput.svelte';

	interface Props {
		entry: SleepLogRow;
		onClose?: () => void;
		onDeleted?: () => void;
		/** Open the night-waking creator for this night (night entries only). */
		onAddWaking?: () => void;
	}

	let { entry, onClose, onDeleted, onAddWaking }: Props = $props();

	let error = $state('');

	let startDate = $state('');
	let startTime = $state('');
	let endDate = $state('');
	let endTime = $state('');
	let selectedType = $state('nap');
	let selectedMood = $state<string | null>(null);
	let selectedMethod = $state<string | null>(null);
	let selectedFallAsleep = $state<string | null>(null);
	let onsetNote = $state('');
	let selectedWakeMood = $state<string | null>(null);
	let notes = $state('');
	let busy = $state(false);
	let confirmDelete = $state(false);
	let initialized = $state(false);

	// svelte-ignore state_referenced_locally — intentional: entry is immutable once passed
	const isOngoing = !entry.end_time;

	// Initialize form fields from entry on first mount only.
	// SSE updates should NOT reset the form while the user is editing.
	$effect(() => {
		if (!initialized) {
			startDate = isoToDateInput(entry.start_time);
			startTime = isoToTimeInput(entry.start_time);
			if (entry.end_time) {
				endDate = isoToDateInput(entry.end_time);
				endTime = isoToTimeInput(entry.end_time);
			} else {
				endDate = '';
				endTime = '';
			}
			selectedType = entry.type;
			selectedMood = entry.mood || null;
			selectedMethod = entry.method || null;
			selectedFallAsleep = entry.fall_asleep_time || null;
			onsetNote = entry.onset_note || '';
			selectedWakeMood = entry.wake_mood || null;
			notes = entry.notes || '';
			initialized = true;
		}
	});

	function toggleMood(value: string) {
		selectedMood = selectedMood === value ? null : value;
	}

	function toggleMethod(value: string) {
		selectedMethod = selectedMethod === value ? null : value;
	}

	function toggleFallAsleep(value: string) {
		selectedFallAsleep = selectedFallAsleep === value ? null : value;
	}

	function toggleWakeMood(value: string) {
		selectedWakeMood = selectedWakeMood === value ? null : value;
	}

	async function save() {
		if (busy) return;
		error = '';
		const startIso = dateTimeToIso(startDate, startTime);
		const endIso = endDate && endTime ? dateTimeToIso(endDate, endTime) : null;
		if (isEndAtOrBeforeStart(startIso, endIso)) {
			error = 'Slutt-tid må vera etter start-tid — sjekk datoen.';
			return;
		}
		busy = true;
		try {
			const event = buildSleepUpdateEvent({
				sleepDomainId: entry.domain_id,
				startTime: startIso,
				endTime: endIso ?? undefined,
				type: selectedType,
				mood: selectedMood,
				method: selectedMethod,
				fallAsleepTime: selectedFallAsleep,
				onsetNote: onsetNote.trim() || undefined,
				wakeMood: selectedWakeMood,
				notes: notes.trim() || undefined,
			});
			await sync.sendEvents([event]);
			onClose?.();
		} finally {
			busy = false;
		}
	}

	async function doDelete() {
		if (busy) return;
		busy = true;
		try {
			await sync.sendEvents([buildSleepDeleteEvent(entry.domain_id)]);
		} finally {
			busy = false;
			confirmDelete = false;
			onDeleted?.();
		}
	}

	// "Angre slutt" — undo End within 15 min, only when no later sleep
	// exists. Reuses the existing `sleep.restarted` event. Resolve the right
	// child's sleeps from the entry itself (not the primary alias) so the
	// "later sleep" check is correct in a focused/second-baby view.
	const focusedSleeps = $derived(
		appState.state.babies.find((b) => b.baby?.id === entry.baby_id)?.todaySleeps
		?? appState.state.todaySleeps,
	);
	const canUndoEnd = $derived(isWithinEndUndoWindow(entry, focusedSleeps));

	async function undoEnd() {
		if (busy) return;
		busy = true;
		try {
			await sync.sendEvents([
				{ type: 'sleep.restarted', payload: { sleepDomainId: entry.domain_id } },
			]);
			onClose?.();
		} finally {
			busy = false;
		}
	}

	function handleOverlayClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose?.();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose?.();
	}
</script>

<svelte:window onkeydown={handleKeydown} />
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={handleOverlayClick} data-testid="modal-overlay">
	<div class="modal" data-testid="edit-sleep-modal">
		<h2>Endra søvn</h2>

		<!-- Angre slutt — undo the End and reopen the nap (only when within
		     the undo window and no later sleep has been started). -->
		{#if canUndoEnd}
			<button
				class="btn btn-ghost"
				style="width: 100%; background: var(--peach); color: var(--text); font-weight: 600; margin-bottom: 12px;"
				onclick={undoEnd}
				disabled={busy}
				data-testid="undo-end-btn"
				type="button"
			>
				↩️ Angre slutt — søv vidare
			</button>
		{/if}

		<!-- Type -->
		<div class="form-group">
			<span class="form-label">Type</span>
			<div class="type-pills">
				{#each SLEEP_TYPES as t}
					<button
						class="type-pill"
						class:active={selectedType === t.value}
						onclick={() => (selectedType = t.value)}
					>
						{t.label}
					</button>
				{/each}
			</div>
		</div>

		<!-- Start -->
		<div class="form-group">
			<span class="form-label">Start</span>
			<div class="datetime-row">
				<DateInput bind:value={startDate} />
				<TimeInput bind:value={startTime} />
			</div>
		</div>

		<!-- End (hidden for ongoing sleeps — end via wake-up flow) -->
		{#if !isOngoing}
			<div class="form-group">
				<span class="form-label">Slutt</span>
				<div class="datetime-row">
					<DateInput bind:value={endDate} />
					<TimeInput bind:value={endTime} />
				</div>
			</div>
		{/if}

		<!-- Add a night waking after the fact (night sleeps only) -->
		{#if entry.type === 'night' && !isOngoing && onAddWaking}
			<div class="form-group">
				<button
					type="button"
					class="btn btn-ghost"
					style="width: 100%;"
					onclick={() => onAddWaking?.()}
					data-testid="add-night-waking"
				>
					🌙 Legg til nattvaking
				</button>
			</div>
		{/if}

		<!-- Mood -->
		<div class="form-group">
			<span class="form-label">Humør ved legging</span>
			<div class="tag-pills">
				{#each MOODS as m}
					<button
						class="tag-pill"
						class:active={selectedMood === m.value}
						onclick={() => toggleMood(m.value)}
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
						class:active={selectedMethod === m.value}
						onclick={() => toggleMethod(m.value)}
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
				{#each FALL_ASLEEP_BUCKETS as b}
					<button
						class="type-pill"
						class:active={selectedFallAsleep === b.value}
						onclick={() => toggleFallAsleep(b.value)}
					>
						{b.label}
					</button>
				{/each}
			</div>
		</div>

		<!-- Onset note -->
		<div class="form-group">
			<label for="edit-onset-note">Kva skjedde ved legging?</label>
			<input id="edit-onset-note" type="text" placeholder="T.d. vondt i magen, svolten..." bind:value={onsetNote} />
		</div>

		<!-- Wake mood -->
		{#if entry.end_time}
			<div class="form-group">
				<span class="form-label">Humør ved oppvakning</span>
				<div class="tag-pills">
					{#each WAKE_MOODS as m}
						<button
							class="tag-pill"
							class:active={selectedWakeMood === m.value}
							onclick={() => toggleWakeMood(m.value)}
						>
							<span class="tag-emoji">{m.label}</span>
							<span class="tag-label">{m.title}</span>
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Notes -->
		<div class="form-group">
			<label for="edit-sleep-notes">Notat</label>
			<input id="edit-sleep-notes" type="text" placeholder="Valfritt notat..." bind:value={notes} />
		</div>

		{#if error}
			<div style="color: var(--danger-dark); font-size: 0.85rem; margin-bottom: 8px;" data-testid="edit-sleep-error">
				{error}
			</div>
		{/if}

		<!-- Action buttons -->
		<div class="btn-row">
			<button class="btn btn-danger" onclick={() => (confirmDelete = true)} disabled={busy}>Slett</button>
			<button class="btn btn-primary" onclick={save} disabled={busy}>Lagra</button>
		</div>

		<!-- Event log link -->
		{#if entry.domain_id}
			<a
				href="/events?domainId={entry.domain_id}"
				class="btn btn-ghost"
				style="width: 100%; font-size: 0.8rem; margin-top: 8px; text-align: center;"
			>
				Hendingslogg
			</a>
		{/if}

		<div style="text-align: center; margin-top: 12px;">
			<button class="btn btn-ghost" onclick={() => onClose?.()}>Avbryt</button>
		</div>
	</div>
</div>

<!-- Delete confirmation -->
{#if confirmDelete}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-overlay" onclick={() => (confirmDelete = false)} data-testid="confirm-overlay" style="z-index: 1001;">
		<div class="modal" data-testid="confirm-delete" style="max-width: 320px;">
			<p style="margin-bottom: 16px;">Sletta denne søvnoppføringa? Dette kan ikkje angrast.</p>
			<div class="btn-row">
				<button class="btn btn-ghost" onclick={() => (confirmDelete = false)}>Avbryt</button>
				<button class="btn btn-danger" onclick={doDelete} disabled={busy}>Slett</button>
			</div>
		</div>
	</div>
{/if}
