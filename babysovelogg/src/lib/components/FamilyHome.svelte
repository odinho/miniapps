<script lang="ts">
	import type { BabyState, FamilySummary } from '$lib/stores/app.svelte.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import { buildStartSleep, buildEndSleep } from '$lib/sleep-actions.js';
	import SleepButton from './SleepButton.svelte';
	import { formatTime, formatDurationCompact, formatDuration } from '$lib/utils.js';
	import { getLaneStatus } from '$lib/lane-status.js';
	import { getCombinedStatus } from '$lib/family.js';

	type DomainEvent = { type: string; payload: Record<string, unknown> };

	interface Props {
		babies: BabyState[];
		/** Household roll-up: twin-mode gates the "begge" bulk actions; firstWake
		 *  drives the combined status line. */
		family: FamilySummary;
		/** Live clock (ms) for lane elapsed/expected-wake — owned by the dashboard. */
		now: number;
		/** Surface an undo toast (owned by the dashboard). */
		onUndo: (message: string, undoEvents: DomainEvent[]) => void;
		/** Open a single child's full detail view. */
		onFocus: (babyId: number) => void;
	}
	let { babies, family, now, onUndo, onFocus }: Props = $props();

	const combined = $derived(getCombinedStatus(babies, family.firstWake, now));

	const isAsleep = (b: BabyState) => !!(b.activeSleep && !b.activeSleep.end_time);
	const anyAwake = $derived(babies.some((b) => b.baby && !isAsleep(b)));
	const anyAsleep = $derived(babies.some((b) => isAsleep(b)));

	let busy = $state(false);

	// Bulk "begge": fan out to one normal sleep event per applicable baby — two
	// independent rows, never a coupled one. Undo reverses every event it sent.
	async function sleepBoth() {
		if (busy) return;
		busy = true;
		try {
			const events: DomainEvent[] = [];
			const undo: DomainEvent[] = [];
			for (const b of babies) {
				if (!b.baby || isAsleep(b)) continue;
				const r = buildStartSleep(
					b.baby.id,
					b.todaySleeps,
					b.ageMonths,
					b.baby.custom_nap_count,
					b.prediction?.napsAllDone ?? undefined,
				);
				events.push(...r.events);
				undo.push({ type: 'sleep.deleted', payload: { sleepDomainId: r.sleepDomainId } });
			}
			if (events.length) {
				await sync.sendEvents(events);
				onUndo('Sove begge', undo);
			}
		} finally {
			busy = false;
		}
	}

	async function wakeBoth() {
		if (busy) return;
		busy = true;
		try {
			const events: DomainEvent[] = [];
			const undo: DomainEvent[] = [];
			for (const b of babies) {
				if (!isAsleep(b) || !b.activeSleep) continue;
				const r = buildEndSleep(b.activeSleep);
				events.push(...r.events);
				undo.push({ type: 'sleep.restarted', payload: { sleepDomainId: b.activeSleep.domain_id } });
			}
			if (events.length) {
				await sync.sendEvents(events);
				onUndo('Vakne begge', undo);
			}
		} finally {
			busy = false;
		}
	}
</script>

<div class="family-home" data-testid="family-home">
	{#if combined}
		<p class="family-status" data-testid="combined-status">
			{#if combined.kind === 'both-asleep'}
				Begge søv.{#if combined.firstWake} Fyrste venta vakning: {combined.firstWake.name} {combined.firstWake.inMs >= 60_000 ? `om ${formatDuration(combined.firstWake.inMs)}` : 'når som helst'}.{/if}
			{:else if combined.kind === 'both-awake'}
				Begge vakne.
			{:else}
				{combined.asleepName} søv, {combined.awakeName} vaken.
			{/if}
		</p>
	{/if}
	<div class="family-lanes">
		{#each babies as b (b.baby?.id)}
			{#if b.baby}
				{@const baby = b.baby}
				{@const status = getLaneStatus(b, now)}
				<div class="lane" data-testid="baby-lane">
					<button class="lane-info" onclick={() => onFocus(baby.id)} data-testid="lane-focus">
						<span class="lane-name" data-testid="lane-name">{baby.name}</span>
						<span
							class="lane-status"
							class:lane-status-stale={status.kind === 'stale'}
							data-testid="lane-status"
						>
							{#if status.kind === 'stale'}
								⚠️ Sjekk vaknetid
							{:else if status.kind === 'asleep'}
								Søv {formatDurationCompact(status.sinceMs)}{#if status.expectedWake} · vaknar ~{formatTime(status.expectedWake)}{/if}
							{:else}
								Vaken{#if status.sinceMs} {formatDurationCompact(status.sinceMs)}{/if}{#if status.next} · {status.next.kind === 'nap' ? 'lur' : 'leggetid'} ~{formatTime(status.next.at)}{/if}
							{/if}
						</span>
					</button>
					<SleepButton
						activeSleep={b.activeSleep}
						todaySleeps={b.todaySleeps}
						ageMonths={b.ageMonths}
						{baby}
						napsAllDone={b.prediction?.napsAllDone && b.prediction?.postSkipPlan?.kind !== 'rescue'}
						wakeCapActive={!!(
							b.activeSleep &&
							!b.activeSleep.end_time &&
							b.activeSleep.type === 'nap' &&
							(b.prediction?.napBudget || b.prediction?.rescueNap)
						)}
						onSleepStarted={(id) =>
							onUndo('Søvn starta', [{ type: 'sleep.deleted', payload: { sleepDomainId: id } }])}
						onSleepEnded={(id) =>
							onUndo('Søvn avslutta', [{ type: 'sleep.restarted', payload: { sleepDomainId: id } }])}
					/>
				</div>
			{/if}
		{/each}
	</div>

	{#if family.isTwinMode && (anyAwake || anyAsleep)}
		<div class="family-bulk" data-testid="family-bulk">
			{#if anyAwake}
				<button class="btn btn-primary" data-testid="sleep-both" onclick={sleepBoth} disabled={busy}>
					🌙 Sove begge
				</button>
			{/if}
			{#if anyAsleep}
				<button class="btn btn-primary" data-testid="wake-both" onclick={wakeBoth} disabled={busy}>
					☀️ Vakne begge
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.family-home {
		display: flex;
		flex-direction: column;
		gap: 16px;
		margin-top: 16px;
	}
	.family-status {
		margin: 0;
		text-align: center;
		font-size: 0.95rem;
		color: var(--text);
	}
	.family-lanes {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.lane {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 16px;
		background: var(--cream);
		border: 1px solid var(--cream-dark);
		border-radius: 16px;
	}
	.lane-info {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		text-align: left;
		cursor: pointer;
		flex: 1;
	}
	.lane-name {
		font-size: 1.25rem;
		font-weight: 600;
	}
	.lane-status {
		font-size: 0.85rem;
		color: var(--text-light);
	}
	.lane-status-stale {
		color: var(--danger, #c0392b);
		font-weight: 600;
	}
	.family-bulk {
		display: flex;
		gap: 8px;
	}
	.family-bulk .btn {
		flex: 1;
	}
</style>
