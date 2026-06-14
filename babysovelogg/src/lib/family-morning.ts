import type { BabyState } from "$lib/stores/app.svelte.js";

/**
 * A child still needs today's wake time when none is recorded, no sleeps have
 * been logged yet, and no session is open. Keyed on `wake_time` (not the row
 * object): a marker-only off-day `day_start` exposes a non-null `todayWakeUp`
 * with `wake_time: null` (see state.ts derivation), and that child genuinely
 * hasn't logged a wake yet. Shared by the family morning prompt and its page
 * gate so both agree on who to prompt for.
 */
export function babyNeedsMorningWake(b: BabyState): boolean {
  return (
    !!b.baby &&
    !b.todayWakeUp?.wake_time &&
    b.todaySleeps.length === 0 &&
    !(b.activeSleep && !b.activeSleep.end_time)
  );
}
