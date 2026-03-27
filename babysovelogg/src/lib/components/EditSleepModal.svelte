<script lang="ts">
	import type { SleepLogRow } from '$lib/types.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import { MOODS, METHODS, FALL_ASLEEP_BUCKETS } from '$lib/constants.js';
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

	let startDate = $state(isoToDateInput(entry.start_time));
	let startTime = $state(isoToTimeInput(entry.start_time));
	let endDate = $state(entry.end_time ? isoToDateInput(entry.end_time) : '');
	let endTime = $state(entry.end_time ? isoToTimeInput(entry.end_time) : '');
	let selectedType = $state(entry.type);
	let selectedMood = $state<string | null>(entry.mood || null);
	let selectedMethod = $state<string | null>(entry.method || null);
	let selectedFallAsleep = $state<string | null>(entry.fall_asleep_time || null);
	let notes = $state(entry.notes || '');
	let busy = $state(false);
	let confirmDelete = $state(false);

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
			<label>Type</label>
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
			<label>Start</label>
			<div class="datetime-row">
				<input type="date" bind:value={startDate} />
				<input type="time" bind:value={startTime} />
			</div>
		</div>

		<!-- End -->
		<div class="form-group">
			<label>Slutt</label>
			<div class="datetime-row">
				<input type="date" bind:value={endDate} />
				<input type="time" bind:value={endTime} />
			</div>
		</div>

		<!-- Mood -->
		<div class="form-group">
			<label>Humør ved legging</label>
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
			<label>Metode</label>
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
			<label>Innsovningstid</label>
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
			<label>Notat</label>
			<input type="text" placeholder="Valfritt notat..." bind:value={notes} />
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
			<p style="margin-bottom: 16px;">Sletta denne søvnoppføringa? Dette kan ikkje angrast.</p>
			<div class="btn-row">
				<button class="btn btn-ghost" onclick={() => (confirmDelete = false)}>Avbryt</button>
				<button class="btn btn-danger" onclick={doDelete} disabled={busy}>Slett</button>
			</div>
		</div>
	</div>
{/if}
