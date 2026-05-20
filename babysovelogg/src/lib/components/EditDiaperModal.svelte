<script lang="ts">
	import type { DiaperLogRow } from '$lib/types.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import {
		isPottyEntry,
		DIAPER_EDIT_TYPES,
		DIAPER_EDIT_AMOUNTS,
		POTTY_EDIT_RESULTS,
		POTTY_EDIT_STATUSES,
		buildDiaperUpdateEvent,
		buildDiaperDeleteEvent,
		isoToDateInput,
		isoToTimeInput,
		dateTimeToIso,
	} from '$lib/history-utils.js';
	import TimeInput from './TimeInput.svelte';
	import DateInput from './DateInput.svelte';

	interface Props {
		entry: DiaperLogRow;
		onClose?: () => void;
		onDeleted?: () => void;
	}

	let { entry, onClose, onDeleted }: Props = $props();

	const isPotty = $derived(isPottyEntry(entry.type));

	let selectedType = $state('');
	let selectedAmount = $state('');
	let notes = $state('');
	let timeDate = $state('');
	let timeHM = $state('');
	let busy = $state(false);
	let confirmDelete = $state(false);
	let initialized = $state(false);

	// Initialize form fields from entry on first mount only.
	$effect(() => {
		if (!initialized) {
			selectedType = entry.type;
			selectedAmount = entry.amount || (isPottyEntry(entry.type) ? 'dry' : 'middels');
			notes = entry.note || '';
			timeDate = isoToDateInput(entry.time);
			timeHM = isoToTimeInput(entry.time);
			initialized = true;
		}
	});

	async function save() {
		if (busy) return;
		busy = true;
		try {
			const newTime = dateTimeToIso(timeDate, timeHM);
			const timeChanged = newTime !== entry.time;
			// `diaper_only` potty entries don't carry an amount (the UI hides the
			// pills), so we explicitly null it out instead of letting a stale
			// `selectedAmount` from a prior type stick.
			const amount = selectedType === 'diaper_only' ? null : selectedAmount;
			const event = buildDiaperUpdateEvent({
				diaperDomainId: entry.domain_id,
				type: selectedType,
				amount,
				// Empty trim → null so the projection clears the stored note.
				note: notes.trim() || null,
				time: timeChanged ? newTime : undefined,
			});
			const result = await sync.sendEvents([event]);
			if (result == null) return;
			onClose?.();
		} finally {
			busy = false;
		}
	}

	async function doDelete() {
		if (busy) return;
		busy = true;
		try {
			await sync.sendEvents([buildDiaperDeleteEvent(entry.domain_id)]);
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
	<div class="modal" data-testid="edit-diaper-modal">
		<h2>{isPotty ? 'Dobesøk' : 'Bleiedetaljar'}</h2>

		{#if isPotty}
			<!-- Potty result -->
			<div class="form-group">
				<span class="form-label">Resultat</span>
				<div class="type-pills diaper-type-pills">
					{#each POTTY_EDIT_RESULTS as r}
						<button
							class="type-pill"
							class:active={selectedType === r.value}
							data-potty={r.value}
							onclick={() => (selectedType = r.value)}
						>
							{r.label}
						</button>
					{/each}
				</div>
			</div>

			<!-- Diaper status -->
			{#if selectedType !== 'diaper_only'}
				<div class="form-group">
					<span class="form-label">Bleie</span>
					<div class="type-pills">
						{#each POTTY_EDIT_STATUSES as s}
							<button
								class="type-pill"
								class:active={selectedAmount === s.value}
								onclick={() => (selectedAmount = s.value)}
							>
								{s.label}
							</button>
						{/each}
					</div>
				</div>
			{/if}
		{:else}
			<!-- Diaper type -->
			<div class="form-group">
				<span class="form-label">Type</span>
				<div class="type-pills diaper-type-pills">
					{#each DIAPER_EDIT_TYPES as t}
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

			<!-- Amount -->
			<div class="form-group">
				<span class="form-label">Mengd</span>
				<div class="type-pills">
					{#each DIAPER_EDIT_AMOUNTS as a}
						<button
							class="type-pill"
							class:active={selectedAmount === a.value}
							onclick={() => (selectedAmount = a.value)}
						>
							{a.label}
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Notes -->
		<div class="form-group">
			<label for="edit-diaper-notes">Notat</label>
			<input id="edit-diaper-notes" type="text" placeholder="Valfritt notat..." bind:value={notes} />
		</div>

		<!-- Time editing -->
		<div class="form-group">
			<span class="form-label">Tid</span>
			<div class="datetime-row">
				<DateInput bind:value={timeDate} />
				<TimeInput bind:value={timeHM} />
			</div>
		</div>

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
			<p style="margin-bottom: 16px;">
				{isPotty ? 'Sletta dette dobesøket?' : 'Sletta denne bleieoppføringa?'} Dette kan ikkje angrast.
			</p>
			<div class="btn-row">
				<button class="btn btn-ghost" onclick={() => (confirmDelete = false)}>Avbryt</button>
				<button class="btn btn-danger" onclick={doDelete} disabled={busy}>Slett</button>
			</div>
		</div>
	</div>
{/if}
