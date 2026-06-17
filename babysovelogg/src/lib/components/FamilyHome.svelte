<script lang="ts">
	import type { BabyState, FamilySummary } from '$lib/stores/app.svelte.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import { buildStartSleep, buildEndSleep } from '$lib/sleep-actions.js';
	import SleepButton from './SleepButton.svelte';
	import Arc from './Arc.svelte';
	import { formatTime, formatDurationCompact, formatDuration } from '$lib/utils.js';
	import { getLaneStatus } from '$lib/lane-status.js';
	import { buildArcProps } from '$lib/arc-props.js';
	import { getCombinedStatus } from '$lib/family.js';
	import FamilyHandoff from './FamilyHandoff.svelte';

	type DomainEvent = { type: string; payload: Record<string, unknown> };
	/** A one-tap correction after a bulk action: revert just one child. */
	type Correction = { label: string; events: DomainEvent[] };

	interface Props {
		babies: BabyState[];
		/** Household roll-up: twin-mode gates the "begge" bulk actions; firstWake
		 *  drives the combined status line. */
		family: FamilySummary;
		/** Live clock (ms) for lane elapsed/expected-wake — owned by the dashboard. */
		now: number;
		/** Surface an undo toast (owned by the dashboard). `corrections` adds
		 *  per-child revert chips alongside "Angre" after a bulk action. */
		onUndo: (message: string, undoEvents: DomainEvent[], corrections?: Correction[]) => void;
		/** Open a single child's full detail view. */
		onFocus: (babyId: number) => void;
	}
	let { babies, family, now, onUndo, onFocus }: Props = $props();

	const combined = $derived(getCombinedStatus(babies, family.firstWake, now));

	const isAsleep = (b: BabyState) => !!(b.activeSleep && !b.activeSleep.end_time);
	// A child with a forgotten/stale open sleep (hidden from activeSleep by the
	// server) is neither cleanly asleep nor awake — never bulk-act on them; the
	// stale lane warning prompts resolving it first.
	const isAwake = (b: BabyState) => !!b.baby && !isAsleep(b) && !b.staleActiveSleep;
	const anyAwake = $derived(babies.some(isAwake));
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
			const corrections: Correction[] = [];
			for (const b of babies) {
				if (!isAwake(b) || !b.baby) continue;
				const r = buildStartSleep(
					b.baby.id,
					b.todaySleeps,
					b.ageMonths,
					b.baby.custom_nap_count,
					b.prediction?.napsAllDone ?? undefined,
				);
				events.push(...r.events);
				const revert: DomainEvent = { type: 'sleep.deleted', payload: { sleepDomainId: r.sleepDomainId } };
				undo.push(revert);
				// "Berre den eine sovna" — revert just this child back to awake.
				corrections.push({ label: `${b.baby.name} er vaken`, events: [revert] });
			}
			if (events.length) {
				await sync.sendEvents(events);
				onUndo('Begge sovna', undo, corrections.length > 1 ? corrections : undefined);
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
			const corrections: Correction[] = [];
			for (const b of babies) {
				if (!isAsleep(b) || !b.activeSleep || !b.baby) continue;
				const r = buildEndSleep(b.activeSleep);
				events.push(...r.events);
				const revert: DomainEvent = { type: 'sleep.restarted', payload: { sleepDomainId: b.activeSleep.domain_id } };
				undo.push(revert);
				// "Berre den eine vakna" — keep this child sleeping.
				corrections.push({ label: `${b.baby.name} søv vidare`, events: [revert] });
			}
			if (events.length) {
				await sync.sendEvents(events);
				onUndo('Begge vakna', undo, corrections.length > 1 ? corrections : undefined);
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
				Begge søv.{#if combined.firstWake}{' '}Fyrste venta vakning: {combined.firstWake.name} {combined.firstWake.inMs >= 60_000 ? `om ${formatDuration(combined.firstWake.inMs)}` : 'når som helst'}.{/if}
			{:else if combined.kind === 'both-awake'}
				Begge vakne.
			{:else}
				{combined.asleepName} søv, {combined.awakeName} vaken.
			{/if}
		</p>
	{/if}
	<div class="family-cards">
		{#each babies as b (b.baby?.id)}
			{#if b.baby}
				{@const baby = b.baby}
				{@const status = getLaneStatus(b, now)}
				{@const arc = buildArcProps(b, now)}
				<div class="fam-card" data-testid="baby-lane">
					<div class="fam-card-head">
						<button class="fam-name-btn" onclick={() => onFocus(baby.id)} data-testid="lane-focus">
							<span class="fam-name" data-testid="lane-name">{baby.name}</span>
							<span class="fam-go" aria-hidden="true">›</span>
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

					<button class="fam-arc-wrap" onclick={() => onFocus(baby.id)} aria-label="Opne {baby.name}" data-testid="lane-arc">
						<Arc {...arc} nowMs={now} />
						<span class="fam-arc-center" data-testid="lane-status" class:stale={status.kind === 'stale'}>
							{#if status.kind === 'stale'}
								<span class="fam-arc-main">⚠️ Sjekk vaknetid</span>
							{:else if status.kind === 'asleep'}
								<span class="fam-arc-main">Søv {formatDurationCompact(status.sinceMs)}</span>
								{#if status.expectedWake}<span class="fam-arc-sub">vaknar ~{formatTime(status.expectedWake)}</span>{/if}
							{:else}
								<span class="fam-arc-main">Vaken{#if status.sinceMs}{' '}{formatDurationCompact(status.sinceMs)}{/if}</span>
								{#if status.next}<span class="fam-arc-sub">{status.next.kind === 'nap' ? 'lur' : 'leggetid'} ~{formatTime(status.next.at)}</span>{/if}
							{/if}
						</span>
					</button>
				</div>
			{/if}
		{/each}
	</div>

	{#if family.isTwinMode && (anyAwake || anyAsleep)}
		<div class="family-bulk" data-testid="family-bulk">
			{#if anyAwake}
				<button class="btn btn-primary" data-testid="sleep-both" onclick={sleepBoth} disabled={busy}>
					🌙 Både sove
				</button>
			{/if}
			{#if anyAsleep}
				<button class="btn btn-primary" data-testid="wake-both" onclick={wakeBoth} disabled={busy}>
					☀️ Både vakna
				</button>
			{/if}
		</div>
	{/if}

	<FamilyHandoff {babies} {now} />
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
	.family-cards {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.fam-card {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 16px 16px 20px;
		background: var(--cream);
		border: 1px solid var(--cream-dark);
		border-radius: 20px;
		box-shadow: var(--shadow);
	}
	.fam-card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.fam-name-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		background: none;
		border: none;
		padding: 4px 0;
		font: inherit;
		color: var(--text);
		cursor: pointer;
		flex: 1;
		min-width: 0;
	}
	.fam-name {
		font-size: 1.35rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.fam-go {
		font-size: 1.2rem;
		color: var(--text-light);
		line-height: 1;
	}
	/* The round graph, with the live status floated in its hollow centre —
	   mirrors the single-baby dashboard's arc + timer. */
	.fam-arc-wrap {
		position: relative;
		width: 100%;
		max-width: 300px;
		margin: 0 auto;
		aspect-ratio: 1;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		display: block;
	}
	.fam-arc-center {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		pointer-events: none;
		text-align: center;
	}
	.fam-arc-main {
		font-size: 1.05rem;
		font-weight: 600;
		color: var(--text);
	}
	.fam-arc-sub {
		font-size: 0.8rem;
		color: var(--text-light);
	}
	.fam-arc-center.stale .fam-arc-main {
		color: var(--danger, #c0392b);
	}
	.family-bulk {
		display: flex;
		gap: 8px;
	}
	.family-bulk .btn {
		flex: 1;
	}
</style>
