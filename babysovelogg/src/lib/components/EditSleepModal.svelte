<script lang="ts">
	import type { SleepLogRow } from '$lib/types.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import { MOODS, METHODS, FALL_ASLEEP_BUCKETS } from '$lib/constants.js';
	import { formatTime, formatDuration } from '$lib/utils.js';
	import {
		SLEEP_TYPES,
		buildSleepUpdateEvent,
		buildSleepDeleteEvent,
		isoToDateInput,
		isoToTimeInput,
		dateTimeToIso,
	} from '$lib/history-utils.js';

	interface Props {
		entry: SleepLogRow;
		onClose?: () => void;
		onDeleted?: () => void;
	}

	let { entry, onClose, onDeleted }: Props = $props();

	let startDate = $state('');
	let startTime = $state('');
	let endDate = $state('');
	let endTime = $state('');
	let selectedType = $state('nap');
	let selectedMood = $state<string | null>(null);
	let selectedMethod = $state<string | null>(null);
	let selectedFallAsleep = $state<string | null>(null);
	let notes = $state('');
	let busy = $state(false);
	let confirmDelete = $state(false);

	// Sync form fields when entry prop changes (e.g. SSE update while modal is open)
	$effect(() => {
		startDate = isoToDateInput(entry.start_time);
		startTime = isoToTimeInput(entry.start_time);
		endDate = entry.end_time ? isoToDateInput(entry.end_time) : '';
		endTime = entry.end_time ? isoToTimeInput(entry.end_time) : '';
		selectedType = entry.type;
		selectedMood = entry.mood || null;
		selectedMethod = entry.method || null;
		selectedFallAsleep = entry.fall_asleep_time || null;
		notes = entry.notes || '';
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

	async function save() {
		if (busy) return;
		busy = true;
		try {
			const event = buildSleepUpdateEvent({
				sleepDomainId: entry.domain_id,
				startTime: dateTimeToIso(startDate, startTime),
				endTime: endDate && endTime ? dateTimeToIso(endDate, endTime) : undefined,
				type: selectedType,
				mood: selectedMood,
				method: selectedMethod,
				fallAsleepTime: selectedFallAsleep,
				notes: notes.trim() || undefined,
			});
			await sync.sendEvents([event]);
		} finally {
			busy = false;
			onClose?.();
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

	let confirmPauseDelete = $state<number | null>(null);

	async function deletePause(index: number) {
		if (busy) return;
		busy = true;
		try {
			await sync.sendEvents([{
				type: 'sleep.pause_deleted',
				payload: { sleepDomainId: entry.domain_id, pauseIndex: index },
			}]);
		} finally {
			busy = false;
			confirmPauseDelete = null;
			onClose?.();
		}
	}

	function handleOverlayClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose?.();
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={handleOverlayClick} data-testid="modal-overlay">
	<div class="modal" data-testid="edit-sleep-modal">
		<h2>Endra søvn</h2>

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
				<input type="date" bind:value={startDate} />
				<input type="time" bind:value={startTime} />
			</div>
		</div>

		<!-- End -->
		<div class="form-group">
			<span class="form-label">Slutt</span>
			<div class="datetime-row">
				<input type="date" bind:value={endDate} />
				<input type="time" bind:value={endTime} />
			</div>
		</div>

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

		<!-- Notes -->
		<div class="form-group">
			<label for="edit-sleep-notes">Notat</label>
			<input id="edit-sleep-notes" type="text" placeholder="Valfritt notat..." bind:value={notes} />
		</div>

		<!-- Pauses -->
		{#if entry.pauses && entry.pauses.length > 0}
			<div class="form-group">
				<span class="form-label">Pausar</span>
				<div style="display: flex; flex-direction: column; gap: 6px;">
					{#each entry.pauses as pause, i}
						<div style="display: flex; align-items: center; justify-content: space-between; background: var(--white); border-radius: var(--radius-sm); padding: 8px 12px; font-size: 0.85rem;">
							<span>
								⏸️ {formatTime(pause.pause_time)}{pause.resume_time ? ` – ${formatTime(pause.resume_time)}` : ' (pågår)'}
								{#if pause.resume_time}
									<span style="color: var(--text-light); margin-left: 4px;">
										({formatDuration(new Date(pause.resume_time).getTime() - new Date(pause.pause_time).getTime())})
									</span>
								{/if}
							</span>
							{#if confirmPauseDelete === i}
								<span style="display: flex; gap: 4px;">
									<button class="btn btn-ghost" style="padding: 4px 8px; min-height: 0; font-size: 0.75rem;" onclick={() => (confirmPauseDelete = null)}>Nei</button>
									<button class="btn btn-danger" style="padding: 4px 8px; min-height: 0; font-size: 0.75rem;" onclick={() => deletePause(i)} disabled={busy}>Ja, slett</button>
								</span>
							{:else}
								<button
									class="btn btn-ghost"
									style="padding: 4px 8px; min-height: 0; font-size: 0.75rem; color: var(--danger-dark);"
									onclick={() => (confirmPauseDelete = i)}
								>
									Slett
								</button>
							{/if}
						</div>
					{/each}
				</div>
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
