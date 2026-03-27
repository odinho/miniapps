<script lang="ts">
	import { sync } from '$lib/stores/sync.svelte.js';
	import { generateSleepId } from '$lib/identity.js';
	import { SLEEP_TYPES, isoToDateInput, isoToTimeInput, dateTimeToIso } from '$lib/history-utils.js';

	interface Props {
		babyId: number;
		onClose?: () => void;
	}

	let { babyId, onClose }: Props = $props();

	// Default to yesterday's evening for night, today's morning for nap
	const now = new Date();
	const todayStr = isoToDateInput(now.toISOString());

	let selectedType = $state('nap');
	let startDate = $state(todayStr);
	let startTime = $state('09:00');
	let endDate = $state(todayStr);
	let endTime = $state('10:00');
	let busy = $state(false);
	let error = $state('');

	async function save() {
		if (busy) return;
		error = '';

		const startIso = dateTimeToIso(startDate, startTime);
		const endIso = dateTimeToIso(endDate, endTime);

		if (new Date(endIso) <= new Date(startIso)) {
			error = 'Slutt-tid må vera etter start-tid';
			return;
		}

		busy = true;
		try {
			const event = {
				type: 'sleep.manual',
				payload: {
					babyId,
					startTime: startIso,
					endTime: endIso,
					type: selectedType,
					sleepDomainId: generateSleepId(),
				},
			};
			await sync.sendEvents([event]);
			onClose?.();
		} catch {
			error = 'Klarte ikkje lagra';
		} finally {
			busy = false;
		}
	}

	function handleOverlayClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose?.();
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={handleOverlayClick} data-testid="manual-sleep-overlay">
	<div class="modal" data-testid="manual-sleep-modal">
		<h2>Legg til søvn</h2>

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

		{#if error}
			<div style="color: var(--danger-dark); font-size: 0.85rem; margin-bottom: 8px;">
				{error}
			</div>
		{/if}

		<!-- Action buttons -->
		<div class="btn-row">
			<button class="btn btn-ghost" onclick={() => onClose?.()}>Avbryt</button>
			<button class="btn btn-primary" onclick={save} disabled={busy}>
				{busy ? 'Lagrar...' : 'Legg til'}
			</button>
		</div>
	</div>
</div>
