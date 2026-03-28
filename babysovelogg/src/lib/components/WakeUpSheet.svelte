<script lang="ts">
	import type { SleepLogRow } from '$lib/types.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import { WOKE_OPTIONS, buildWakeUpEvent, getBedtimeSummary } from '$lib/wake-sheet-actions.js';

	interface Props {
		sleepDomainId: string;
		sleepSnapshot: SleepLogRow;
		onClose?: () => void;
	}

	let { sleepDomainId, sleepSnapshot, onClose }: Props = $props();

	// svelte-ignore state_referenced_locally — intentional: snapshot is immutable once passed
	const defaultWakeTime = sleepSnapshot.end_time ? new Date(sleepSnapshot.end_time) : new Date();
	let wakeTime = $state(defaultWakeTime.toTimeString().slice(0, 5));
	let wakeDate = $state(defaultWakeTime.toISOString().slice(0, 10));

	let wokeBy = $state<string | null>(null);
	let notes = $state('');
	let busy = $state(false);

	const summary = $derived(getBedtimeSummary(sleepSnapshot));

	// Did the user change the wake time?
	const wakeTimeChanged = $derived.by(() => {
		const original = defaultWakeTime.toTimeString().slice(0, 5);
		return wakeTime !== original;
	});

	function adjustWakeMinutes(delta: number) {
		const d = new Date(`${wakeDate}T${wakeTime}:00`);
		d.setMinutes(d.getMinutes() + delta);
		wakeDate = d.toISOString().slice(0, 10);
		wakeTime = d.toTimeString().slice(0, 5);
	}

	function toggleWokeBy(value: string) {
		wokeBy = wokeBy === value ? null : value;
	}

	async function save() {
		if (busy) return;
		busy = true;
		try {
			const endTimeIso = wakeTimeChanged
				? new Date(`${wakeDate}T${wakeTime}:00`).toISOString()
				: null;
			const event = buildWakeUpEvent(sleepDomainId, wokeBy, notes, endTimeIso);
			if (event) {
				await sync.sendEvents([event]);
			}
		} finally {
			busy = false;
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

		<!-- Wake time -->
		<div class="form-group">
			<span class="form-label">Vaknetid</span>
			<div class="datetime-row">
				<input type="time" bind:value={wakeTime} data-testid="wake-time" />
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

		<!-- Done button -->
		<button class="btn btn-primary" style="width: 100%; margin-top: 8px;" onclick={save} disabled={busy} data-testid="wake-done">
			Ferdig
		</button>
	</div>
</div>
