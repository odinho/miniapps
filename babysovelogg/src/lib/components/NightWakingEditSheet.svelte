<script lang="ts">
	import type { NightWakingRow } from '$lib/types.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import { WAKE_MOODS } from '$lib/constants.js';
	import { isoToDateInput, isoToTimeInput, dateTimeToIso } from '$lib/history-utils.js';
	import { formatDuration } from '$lib/utils.js';
	import TimeInput from './TimeInput.svelte';
	import DateInput from './DateInput.svelte';

	interface Props {
		waking: NightWakingRow;
		onClose?: () => void;
		onDeleted?: () => void;
	}

	let { waking, onClose, onDeleted }: Props = $props();

	let startDate = $state('');
	let startTime = $state('');
	let endDate = $state('');
	let endTime = $state('');
	let notes = $state('');
	let selectedMood = $state<string | null>(null);
	let busy = $state(false);
	let confirmDelete = $state(false);
	let initialized = $state(false);

	$effect(() => {
		if (initialized) return;
		startDate = isoToDateInput(waking.start_time);
		startTime = isoToTimeInput(waking.start_time);
		if (waking.end_time) {
			endDate = isoToDateInput(waking.end_time);
			endTime = isoToTimeInput(waking.end_time);
		}
		notes = waking.notes ?? '';
		selectedMood = waking.mood ?? null;
		initialized = true;
	});

	const isOngoing = $derived(!waking.end_time);

	const durationMs = $derived.by(() => {
		if (!startDate || !startTime || !endDate || !endTime) return 0;
		const start = new Date(dateTimeToIso(startDate, startTime)).getTime();
		const end = new Date(dateTimeToIso(endDate, endTime)).getTime();
		return Math.max(0, end - start);
	});

	function toggleMood(value: string) {
		selectedMood = selectedMood === value ? null : value;
	}

	async function save() {
		if (busy) return;
		busy = true;
		try {
			const startIso = dateTimeToIso(startDate, startTime);
			const endIso = endDate && endTime ? dateTimeToIso(endDate, endTime) : null;
			await sync.sendEvents([
				{
					type: 'night_waking.edited',
					payload: {
						wakingDomainId: waking.domain_id,
						startTime: startIso,
						endTime: endIso,
						notes: notes.trim() || null,
						mood: selectedMood,
					},
				},
			]);
			onClose?.();
		} finally {
			busy = false;
		}
	}

	async function doDelete() {
		if (busy) return;
		busy = true;
		try {
			await sync.sendEvents([
				{ type: 'night_waking.deleted', payload: { wakingDomainId: waking.domain_id } },
			]);
		} finally {
			busy = false;
			confirmDelete = false;
			onDeleted?.();
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
	<div class="modal" data-testid="night-waking-edit-sheet">
		<h2>🌙 Nattvaking</h2>

		{#if !isOngoing && durationMs > 0}
			<div style="text-align: center; margin: 4px 0 12px; font-size: 1rem; font-weight: 600; color: var(--text);">
				Varte {formatDuration(durationMs)}
			</div>
		{/if}

		<!-- Start -->
		<div class="form-group">
			<span class="form-label">Vakna</span>
			<div class="datetime-row">
				<DateInput bind:value={startDate} />
				<TimeInput bind:value={startTime} />
			</div>
		</div>

		<!-- End (hidden for ongoing wakings) -->
		{#if !isOngoing}
			<div class="form-group">
				<span class="form-label">Sov att</span>
				<div class="datetime-row">
					<DateInput bind:value={endDate} />
					<TimeInput bind:value={endTime} />
				</div>
			</div>
		{/if}

		<!-- Mood -->
		<div class="form-group">
			<span class="form-label">Humør</span>
			<div class="tag-pills">
				{#each WAKE_MOODS as m}
					<button
						class="tag-pill"
						class:active={selectedMood === m.value}
						onclick={() => toggleMood(m.value)}
						data-testid="waking-mood-{m.value}"
					>
						<span class="tag-emoji">{m.label}</span>
						<span class="tag-label">{m.title}</span>
					</button>
				{/each}
			</div>
		</div>

		<!-- Notes -->
		<div class="form-group">
			<label for="waking-notes">Notat</label>
			<input
				id="waking-notes"
				type="text"
				placeholder="Valfritt notat..."
				bind:value={notes}
				data-testid="waking-notes"
			/>
		</div>

		<!-- Action buttons -->
		<div class="btn-row">
			{#if confirmDelete}
				<button class="btn btn-ghost" onclick={() => (confirmDelete = false)} disabled={busy}>Avbryt</button>
				<button class="btn btn-danger" onclick={doDelete} disabled={busy} data-testid="waking-confirm-delete">Ja, slett</button>
			{:else}
				<button class="btn btn-danger" onclick={() => (confirmDelete = true)} disabled={busy} data-testid="waking-delete">Slett</button>
				<button class="btn btn-primary" onclick={save} disabled={busy} data-testid="waking-save">Lagra</button>
			{/if}
		</div>
	</div>
</div>
