<script lang="ts">
	import type { SleepLogRow, DiaperLogRow, NightWakingRow } from '$lib/types.js';
	import { formatTime, formatDuration } from '$lib/utils.js';
	import EditSleepModal from '$lib/components/EditSleepModal.svelte';
	import EditDiaperModal from '$lib/components/EditDiaperModal.svelte';
	import ManualSleepModal from '$lib/components/ManualSleepModal.svelte';
	import NightWakingEditSheet from '$lib/components/NightWakingEditSheet.svelte';
	import { appState } from '$lib/stores/app.svelte.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import { toggleOffDay } from '$lib/off-day-actions.js';
	import {
		type HistoryEntry,
		fetchHistory,
		mergeEntries,
		groupByDate,
		getDateLabel,
		formatSleepDuration,
		formatSleepTimes,
		getSleepIcon,
		getSleepTypeLabel,
		getSleepBadges,
		getFallAsleepLabel,
		getWokeByLabel,
		getWakeMoodEmoji,
		getDiaperIcon,
		getDiaperMeta,
		getDiaperCategoryLabel,
		isPottyEntry,
	} from '$lib/history-utils.js';

	let entries = $state<HistoryEntry[]>([]);
	let loading = $state(true);

	let editingSleep = $state<SleepLogRow | null>(null);
	let editingDiaper = $state<DiaperLogRow | null>(null);
	let editingNightWaking = $state<NightWakingRow | null>(null);
	let showManualSleep = $state(false);

	const baby = $derived(appState.state.baby);
	const offDays = $derived(appState.state.offDays);

	const grouped = $derived(groupByDate(entries));

	let offDayBusyFor = $state<string | null>(null);
	async function handleToggleOffDay(date: string) {
		if (!baby || offDayBusyFor === date) return;
		offDayBusyFor = date;
		try {
			await toggleOffDay(baby.id, date, offDays.includes(date));
		} finally {
			offDayBusyFor = null;
		}
	}

	async function load() {
		loading = true;
		try {
			const data = await fetchHistory();
			entries = mergeEntries(data.sleeps, data.diapers, data.nightWakings);
		} finally {
			loading = false;
		}
	}

	function openSleepEdit(entry: SleepLogRow & { _kind: 'sleep'; _sortTime: string }) {
		editingSleep = entry;
	}

	function openDiaperEdit(entry: DiaperLogRow & { _kind: 'diaper'; _sortTime: string }) {
		editingDiaper = entry;
	}

	function openNightWakingEdit(entry: NightWakingRow & { _kind: 'night_waking'; _sortTime: string }) {
		editingNightWaking = entry;
	}

	function closeSleepEdit() {
		editingSleep = null;
		load();
	}

	function closeDiaperEdit() {
		editingDiaper = null;
		load();
	}

	function closeNightWakingEdit() {
		editingNightWaking = null;
		load();
	}

	function closeManualSleep() {
		showManualSleep = false;
		load();
	}

	$effect(() => {
		load();
	});
</script>

<div class="view">
	<div style="display: flex; justify-content: space-between; align-items: center;">
		<h2 class="history-header">Logg</h2>
		{#if baby}
			<button
				class="btn btn-ghost"
				style="font-size: 0.85rem; padding: 8px 12px; min-height: 0;"
				data-testid="add-sleep-btn"
				onclick={() => (showManualSleep = true)}
			>
				+ Legg til søvn
			</button>
		{/if}
	</div>

	{#if loading}
		<div class="history-empty">
			<div style="font-size: 1.2rem; color: var(--text-light);">Lastar…</div>
		</div>
	{:else if entries.length === 0}
		<div class="history-empty">
			<div style="font-size: 3rem; margin-bottom: 16px;">📋</div>
			<div>Ingen oppføringar enno</div>
			<div style="font-size: 0.9rem; margin-top: 8px;">
				Trykk på søvnknappen på heimeskjermen for å starta
			</div>
		</div>
	{:else}
		<div class="sleep-log">
			{#each [...grouped] as [date, dayEntries]}
				{@const dayIsOff = offDays.includes(date)}
				<button
					class="history-day-header"
					class:off={dayIsOff}
					onclick={() => handleToggleOffDay(date)}
					disabled={offDayBusyFor === date || !baby}
					data-testid="history-day-header"
					aria-pressed={dayIsOff}
					type="button"
				>
					<span>{getDateLabel(date)}</span>
					{#if dayIsOff}
						<span class="history-day-flag">🤒 Utypisk dag</span>
					{:else}
						<span class="history-day-flag-hint">Marker som utypisk</span>
					{/if}
				</button>

				{#each dayEntries as entry}
					{#if entry._kind === 'sleep'}
						{@const badges = getSleepBadges(entry)}
						{@const fallAsleep = getFallAsleepLabel(entry.fall_asleep_time)}
						{@const wokeBy = getWokeByLabel(entry.woke_by)}
						{@const wakeMoodEmoji = getWakeMoodEmoji(entry.wake_mood)}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="sleep-log-item" onclick={() => openSleepEdit(entry)}>
							<span class="log-icon">{getSleepIcon(entry.type)}</span>
							<div class="log-info">
								<div class="log-times">{formatSleepTimes(entry)}</div>
								<div class="log-meta">
									{getSleepTypeLabel(entry.type)}
									{#if badges.length > 0}
										<span class="tag-badges">
											{#each badges as badge}
												<span class="tag-badge" title={badge.title}>{badge.emoji}</span>
											{/each}
										</span>
									{/if}
									{#if fallAsleep}
										 · ⏱️ {fallAsleep}
									{/if}
									{#if wokeBy}
										 · {wokeBy}
									{/if}
									{#if wakeMoodEmoji}
										 · {wakeMoodEmoji}
									{/if}
								</div>
								{#if entry.notes}
									<div class="log-meta" style="font-style: italic;">{entry.notes}</div>
								{/if}
								{#if entry.onset_note}
									<div class="log-meta" style="font-style: italic;">Legging: {entry.onset_note}</div>
								{/if}
								{#if entry.wake_notes}
									<div class="log-meta" style="font-style: italic;">Oppvakning: {entry.wake_notes}</div>
								{/if}
							</div>
							<span class="log-duration">{formatSleepDuration(entry)}</span>
						</div>
					{:else if entry._kind === 'diaper'}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="sleep-log-item diaper-log-item" onclick={() => openDiaperEdit(entry)}>
							<span class="log-icon">{getDiaperIcon(entry.type)}</span>
							<div class="log-info">
								<div class="log-times">{formatTime(entry.time)}</div>
								<div class="log-meta">{getDiaperMeta(entry)}</div>
								{#if entry.note}
									<div class="log-meta" style="font-style: italic;">{entry.note}</div>
								{/if}
							</div>
							<span class="log-duration">{getDiaperCategoryLabel(entry.type)}</span>
						</div>
					{:else if entry._kind === 'night_waking'}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="sleep-log-item night-waking-log-item" onclick={() => openNightWakingEdit(entry)} data-testid="night-waking-row">
							<span class="log-icon">🌙</span>
							<div class="log-info">
								<div class="log-times">
									{formatTime(entry.start_time)}{entry.end_time ? `–${formatTime(entry.end_time)}` : ' (pågår)'}
								</div>
								<div class="log-meta">
									Nattvaking
									{#if entry.mood}
										· {entry.mood}
									{/if}
								</div>
								{#if entry.notes}
									<div class="log-meta" style="font-style: italic;">{entry.notes}</div>
								{/if}
							</div>
							<span class="log-duration">
								{#if entry.end_time}
									{formatDuration(new Date(entry.end_time).getTime() - new Date(entry.start_time).getTime())}
								{/if}
							</span>
						</div>
					{/if}
				{/each}
			{/each}
		</div>
	{/if}
</div>

<!-- Edit modals -->
{#if editingSleep}
	<EditSleepModal
		entry={editingSleep}
		onClose={closeSleepEdit}
		onDeleted={closeSleepEdit}
	/>
{/if}

{#if editingDiaper}
	<EditDiaperModal
		entry={editingDiaper}
		onClose={closeDiaperEdit}
		onDeleted={closeDiaperEdit}
	/>
{/if}

{#if editingNightWaking}
	<NightWakingEditSheet
		waking={editingNightWaking}
		onClose={closeNightWakingEdit}
		onDeleted={closeNightWakingEdit}
	/>
{/if}

{#if showManualSleep && baby}
	<ManualSleepModal
		babyId={baby.id}
		onClose={closeManualSleep}
	/>
{/if}

<style>
	.history-day-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		width: 100%;
		font-size: 0.8rem;
		color: var(--text-light);
		padding: 12px 8px 6px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		background: none;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-family: inherit;
		text-align: left;
	}

	.history-day-header:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.03);
	}

	.history-day-header:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.history-day-header.off {
		color: var(--peach-dark, #d97757);
	}

	.history-day-flag {
		font-size: 0.7rem;
		text-transform: none;
		letter-spacing: 0;
		font-weight: 500;
	}

	/* Hint only visible on hover/focus — keeps the list visually quiet
	   when nothing is flagged, but discoverable when the parent looks. */
	.history-day-flag-hint {
		font-size: 0.7rem;
		text-transform: none;
		letter-spacing: 0;
		font-weight: 400;
		opacity: 0;
		transition: opacity 120ms ease;
	}

	.history-day-header:hover .history-day-flag-hint,
	.history-day-header:focus-visible .history-day-flag-hint {
		opacity: 0.6;
	}
</style>
