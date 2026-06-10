<script lang="ts">
	import type { SleepLogRow, Baby } from '$lib/types.js';
	import { tick } from 'svelte';
	import { sync } from '$lib/stores/sync.svelte.js';
	import { buildStartSleep, buildEndSleep } from '$lib/sleep-actions.js';

	interface Props {
		activeSleep: SleepLogRow | null;
		todaySleeps: SleepLogRow[];
		ageMonths: number;
		baby: Baby;
		napsAllDone?: boolean;
		/** True when the engine is showing a wake-by cap (napBudget / rescue)
		 *  for the active nap — ending then is a cap-respect wake. */
		wakeCapActive?: boolean;
		onSleepStarted?: (sleepDomainId: string, startTime: string) => void;
		onSleepEnded?: (domainId: string, sleepSnapshot: SleepLogRow, endTime: string) => void;
	}

	let { activeSleep, todaySleeps, ageMonths, baby, napsAllDone, wakeCapActive, onSleepStarted, onSleepEnded }: Props =
		$props();

	const isSleeping = $derived(!!activeSleep && !activeSleep.end_time);

	let busy = $state(false);

	async function handleToggle() {
		if (busy) return;
		busy = true;
		try {
			if (isSleeping && activeSleep) {
				const domainId = activeSleep.domain_id;
				const result = buildEndSleep(activeSleep, wakeCapActive && activeSleep.type === 'nap');
				await sync.sendEvents(result.events);
				await tick();
				onSleepEnded?.(domainId, result.sleepSnapshot, result.endTime);
			} else {
				const result = buildStartSleep(
					baby.id,
					todaySleeps,
					ageMonths,
					baby.custom_nap_count,
					napsAllDone,
				);
				await sync.sendEvents(result.events);
				await tick();
				onSleepStarted?.(result.sleepDomainId, result.startTime);
			}
		} finally {
			busy = false;
		}
	}
</script>

<button
	class="sleep-button {isSleeping ? 'sleeping' : 'awake'}"
	data-testid="sleep-button"
	onclick={handleToggle}
	disabled={busy}
>
	<span class="icon">{isSleeping ? '☀️' : '🌙'}</span>
	<span class="label">{isSleeping ? 'Vakne' : 'Sove'}</span>
</button>
