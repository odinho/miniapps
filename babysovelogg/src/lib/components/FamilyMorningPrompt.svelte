<script lang="ts">
	import type { BabyState } from '$lib/stores/app.svelte.js';
	import { sync } from '$lib/stores/sync.svelte.js';
	import { isoToDateInTz } from '$lib/tz.js';
	import { formatTime } from '$lib/utils.js';
	import { babyNeedsMorningWake } from '$lib/family-morning.js';
	import TimeInput from './TimeInput.svelte';

	interface Props {
		babies: BabyState[];
		/** Parent dismissed the prompt for today (no times set). */
		onSkip: () => void;
	}
	let { babies, onSkip }: Props = $props();

	const pending = $derived(babies.filter(babyNeedsMorningWake));
	const logged = $derived(babies.filter((b) => b.baby && !!b.todayWakeUp));

	let masterTime = $state('07:00');
	let perChild = $state(false);
	let times = $state<Record<number, string>>({});
	let busy = $state(false);

	function enablePerChild() {
		const next: Record<number, string> = {};
		for (const b of pending) if (b.baby) next[b.baby.id] = masterTime;
		times = next;
		perChild = true;
	}

	async function save() {
		if (busy) return;
		busy = true;
		try {
			const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
			for (const b of pending) {
				if (!b.baby) continue;
				const time = perChild ? (times[b.baby.id] ?? masterTime) : masterTime;
				if (!/^\d{2}:\d{2}$/.test(time)) continue;
				const date = isoToDateInTz(new Date().toISOString(), b.baby.timezone || 'UTC');
				const candidate = new Date(`${date}T${time}:00`);
				if (Number.isNaN(candidate.getTime())) continue;
				events.push({
					type: 'day.started',
					payload: { babyId: b.baby.id, wakeTime: candidate.toISOString() },
				});
				// A fresh wake also discards an orphaned over-a-day session.
				if (b.staleActiveSleep) {
					events.push({
						type: 'sleep.deleted',
						payload: { sleepDomainId: b.staleActiveSleep.domain_id },
					});
				}
			}
			if (events.length) {
				const result = await sync.sendEvents(events);
				if (result == null) return;
			}
			// State refresh flips `needsWake` false for the saved children, which
			// hides the prompt — no explicit close needed.
		} finally {
			busy = false;
		}
	}
</script>

<div class="morning-prompt family-morning" data-testid="family-morning-prompt">
	<div class="morning-icon">🌅</div>
	<h2>God morgon!</h2>
	<p>{pending.length === 1 && pending[0].baby ? `Når vakna ${pending[0].baby.name}?` : 'Når vakna dei?'}</p>

	{#if !perChild}
		{#if pending.length > 1}
			<p class="fm-who" data-testid="family-morning-who">
				{pending.map((b) => b.baby?.name).filter(Boolean).join(' og ')}
			</p>
		{/if}
		<div class="fm-row">
			<TimeInput bind:value={masterTime} data-testid="family-morning-time" />
		</div>
		{#if pending.length > 1}
			<button class="btn btn-ghost fm-toggle" onclick={enablePerChild}>Ulik tid?</button>
		{/if}
	{:else}
		{#each pending as b, i (b.baby?.id)}
			{#if b.baby}
				<div class="fm-row" data-testid="family-morning-row">
					<span class="fm-name">{b.baby.name}</span>
					<TimeInput bind:value={times[b.baby.id]} data-testid={`family-morning-time-${i + 1}`} />
				</div>
			{/if}
		{/each}
	{/if}

	{#each logged as b (b.baby?.id)}
		{#if b.baby && b.todayWakeUp?.wake_time}
			<div class="fm-row fm-logged" data-testid="family-morning-logged">
				<span class="fm-name">{b.baby.name}</span>
				<span class="fm-logged-time">vakna {formatTime(b.todayWakeUp.wake_time)}</span>
			</div>
		{/if}
	{/each}

	<div class="fm-actions">
		<button class="btn btn-primary" onclick={save} disabled={busy}>Sett vaknetid</button>
		<button class="btn btn-ghost" onclick={onSkip} disabled={busy}>Hopp over</button>
	</div>
</div>

<style>
	.fm-row {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		margin: 6px 0;
	}
	.fm-name {
		min-width: 5em;
		text-align: right;
		font-weight: 600;
	}
	.fm-logged {
		opacity: 0.55;
	}
	.fm-logged-time {
		font-size: 0.9rem;
		color: var(--text-light);
	}
	.fm-who {
		margin: 0 0 4px;
		font-weight: 600;
	}
	.fm-toggle {
		font-size: 0.85rem;
		margin: 0 auto 4px;
	}
	.fm-actions {
		display: flex;
		gap: 8px;
		justify-content: center;
		margin-top: 8px;
	}
</style>
