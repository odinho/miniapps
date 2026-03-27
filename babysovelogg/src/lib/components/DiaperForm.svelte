<script lang="ts">
	import { sync } from '$lib/stores/sync.svelte.js';
	import {
		DIAPER_TYPES,
		DIAPER_AMOUNTS,
		POTTY_RESULTS,
		POTTY_DIAPER_STATUSES,
		shouldHideDiaperStatus,
		buildDiaperEvent,
		buildPottyEvent,
		isValidTime,
	} from '$lib/diaper-form-actions.js';

	interface Props {
		babyId: number;
		pottyMode?: boolean;
		onClose?: () => void;
	}

	let { babyId, pottyMode = false, onClose }: Props = $props();

	let selectedType = $state('wet');
	let selectedAmount = $state('middels');
	let selectedPottyResult = $state('potty_wet');
	let selectedDiaperStatus = $state('dry');
	let time = $state(new Date().toISOString());
	let notes = $state('');
	let busy = $state(false);

	const hideDiaperStatus = $derived(shouldHideDiaperStatus(selectedPottyResult));

	/** Convert ISO to local datetime-local input value */
	function toDatetimeLocal(iso: string): string {
		const d = new Date(iso);
		return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
	}

	function handleTimeChange(e: Event) {
		const input = e.target as HTMLInputElement;
		if (!input.value) return;
		time = new Date(input.value).toISOString();
	}

	async function save() {
		if (busy) return;
		if (!isValidTime(time)) return;
		busy = true;
		try {
			const event = pottyMode
				? buildPottyEvent(babyId, time, selectedPottyResult, selectedDiaperStatus, notes)
				: buildDiaperEvent(babyId, time, selectedType, selectedAmount, notes);
			await sync.sendEvents([event]);
		} finally {
			busy = false;
			onClose?.();
		}
	}

	function cancel() {
		onClose?.();
	}

	function handleOverlayClick(e: MouseEvent) {
		if (e.target === e.currentTarget) cancel();
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={handleOverlayClick} data-testid="modal-overlay">
	<div class="modal" data-testid="diaper-form">
		<h2>{pottyMode ? 'Logg dobesøk' : 'Logg bleie'}</h2>

		{#if pottyMode}
			<!-- Potty result -->
			<div class="form-group">
				<label>Resultat</label>
				<div class="type-pills diaper-type-pills">
					{#each POTTY_RESULTS as r}
						<button
							class="type-pill"
							class:active={selectedPottyResult === r.value}
							onclick={() => (selectedPottyResult = r.value)}
							data-potty={r.value}
						>
							{r.label}
						</button>
					{/each}
				</div>
			</div>

			<!-- Diaper status (hidden when diaper_only) -->
			{#if !hideDiaperStatus}
				<div class="form-group">
					<label>Bleie</label>
					<div class="type-pills">
						{#each POTTY_DIAPER_STATUSES as s}
							<button
								class="type-pill"
								class:active={selectedDiaperStatus === s.value}
								onclick={() => (selectedDiaperStatus = s.value)}
								data-testid="diaper-status-{s.value}"
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
				<label>Type</label>
				<div class="type-pills diaper-type-pills">
					{#each DIAPER_TYPES as t}
						<button
							class="type-pill"
							class:active={selectedType === t.value}
							onclick={() => (selectedType = t.value)}
							data-diaper-type={t.value}
						>
							{t.label}
						</button>
					{/each}
				</div>
			</div>

			<!-- Amount -->
			<div class="form-group">
				<label>Mengd</label>
				<div class="type-pills">
					{#each DIAPER_AMOUNTS as a}
						<button
							class="type-pill"
							class:active={selectedAmount === a.value}
							onclick={() => (selectedAmount = a.value)}
							data-testid="amount-{a.value}"
						>
							{a.label}
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Time -->
		<div class="form-group">
			<label>Tid</label>
			<input
				type="datetime-local"
				value={toDatetimeLocal(time)}
				onchange={handleTimeChange}
				data-testid="diaper-time"
			/>
		</div>

		<!-- Notes -->
		<div class="form-group">
			<label>Notat</label>
			<input
				type="text"
				placeholder="Valfritt notat..."
				bind:value={notes}
				data-testid="diaper-notes"
			/>
		</div>

		<!-- Buttons -->
		<div class="btn-row">
			<button class="btn btn-ghost" onclick={cancel}>Avbryt</button>
			<button class="btn btn-primary" onclick={save} disabled={busy} data-testid="diaper-save">
				Lagra
			</button>
		</div>
	</div>
</div>
