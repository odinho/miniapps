<script lang="ts">
	import type { DiaperLogRow } from '$lib/types.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import { MOODS, METHODS, FALL_ASLEEP_BUCKETS } from '$lib/constants.js';
	import { formatTime } from '$lib/utils.js';
	import {
		nudgeTime,
		shouldShowDiaperNudge,
		collectTagSheetEvents,
	} from '$lib/tag-sheet-actions.js';

	interface Props {
		sleepDomainId: string;
		startTime: string;
		diapers: DiaperLogRow[];
		pottyMode?: boolean;
		onClose?: () => void;
		onOpenDiaper?: () => void;
	}

	let { sleepDomainId, startTime, diapers, pottyMode = false, onClose, onOpenDiaper }: Props =
		$props();

	let mood = $state<string | null>(null);
	let method = $state<string | null>(null);
	let fallAsleepTime = $state<string | null>(null);
	let notes = $state('');
	// svelte-ignore state_referenced_locally — intentional: local copy of initial prop
	let adjustedStartTime = $state(startTime);
	let showDatePicker = $state(false);
	let busy = $state(false);

	const displayTime = $derived(formatTime(adjustedStartTime));
	const showDiaperNudge = $derived(shouldShowDiaperNudge(diapers));

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
		</div>

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
