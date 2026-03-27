<script lang="ts">
	import type { SleepLogRow, DiaperLogRow } from '$lib/types.js';
	import { formatTime } from '$lib/utils.js';
	import EditSleepModal from '$lib/components/EditSleepModal.svelte';
	import EditDiaperModal from '$lib/components/EditDiaperModal.svelte';
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
		getPauseSummary,
		getSleepBadges,
		getFallAsleepLabel,
		getWokeByLabel,
		getDiaperIcon,
		getDiaperMeta,
		getDiaperCategoryLabel,
		isPottyEntry,
	} from '$lib/history-utils.js';

	let entries = $state<HistoryEntry[]>([]);
	let loading = $state(true);

	let editingSleep = $state<SleepLogRow | null>(null);
	let editingDiaper = $state<DiaperLogRow | null>(null);

	const grouped = $derived(groupByDate(entries));

	async function load() {
		loading = true;
		try {
			const data = await fetchHistory();
			entries = mergeEntries(data.sleeps, data.diapers, data.wakeups);
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

	function closeSleepEdit() {
		editingSleep = null;
		load();
	}

	function closeDiaperEdit() {
		editingDiaper = null;
		load();
	}

	$effect(() => {
		load();
	});
</script>

<div class="view">
	<div style="display: flex; justify-content: space-between; align-items: center;">
		<h2 class="history-header">Logg</h2>
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
				<div style="font-size: 0.8rem; color: var(--text-light); padding: 8px 4px 4px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;">
					{getDateLabel(date)}
				</div>

				{#each dayEntries as entry}
					{#if entry._kind === 'sleep'}
						{@const pauseInfo = getPauseSummary(entry)}
						{@const badges = getSleepBadges(entry)}
						{@const fallAsleep = getFallAsleepLabel(entry.fall_asleep_time)}
						{@const wokeBy = getWokeByLabel(entry.woke_by)}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="sleep-log-item" onclick={() => openSleepEdit(entry)}>
							<span class="log-icon">{getSleepIcon(entry.type)}</span>
							<div class="log-info">
								<div class="log-times">{formatSleepTimes(entry)}</div>
								<div class="log-meta">
									{getSleepTypeLabel(entry.type)}
									{#if pauseInfo}
										 · {pauseInfo.count} pause{pauseInfo.count > 1 ? 'r' : ''} ({pauseInfo.totalMinutes}m)
									{/if}
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
								</div>
								{#if entry.notes}
									<div class="log-meta" style="font-style: italic;">{entry.notes}</div>
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
					{:else if entry._kind === 'wakeup'}
						<div class="sleep-log-item wakeup-log-item">
							<span class="log-icon">☀️</span>
							<div class="log-info">
								<div class="log-times">{formatTime(entry.wake_time)}</div>
								<div class="log-meta">Vakna</div>
							</div>
							<span class="log-duration">Morgon</span>
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
