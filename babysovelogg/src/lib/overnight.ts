import type { SleepLogRow } from "$lib/types.js";

// A night can be logged as several `night` sleeps split by wake-ups (parent
// logs each stretch separately) instead of one sleep + night_wakings. A
// fragment only *continues* the overnight if the awake gap from the previous
// wake is short — a long stretch marks a separate block (an evening bedtime on
// a no-nap day, or an evening false-start) that must not extend the morning.
const SAME_NIGHT_GAP_MS = 3 * 60 * 60 * 1000;

/**
 * The overnight that ended this morning, in chronological order: the fragment
 * that straddled midnight (if any), then the leading post-midnight `night`
 * sleeps, stopping at the first nap, an active (open) sleep, or a long awake
 * gap. The last fragment's `end_time` is the morning wake.
 *
 * Shared by the server (`getBabyState` morning-wake derivation) and the
 * dashboard "I dag" card so both agree on what the night was.
 */
export function collectOvernightFragments(
  priorOvernight: SleepLogRow | null | undefined,
  todaySleeps: SleepLogRow[],
): SleepLogRow[] {
  const fragments: SleepLogRow[] = [];
  let prevWakeMs: number | null = null;
  if (priorOvernight?.end_time) {
    fragments.push(priorOvernight);
    prevWakeMs = new Date(priorOvernight.end_time).getTime();
  }
  const ascending = todaySleeps.toSorted(
    (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
  );
  for (const s of ascending) {
    if (s.type !== "night" || !s.end_time) break;
    const startMs = new Date(s.start_time).getTime();
    if (prevWakeMs != null && startMs - prevWakeMs > SAME_NIGHT_GAP_MS) break;
    fragments.push(s);
    prevWakeMs = new Date(s.end_time).getTime();
  }
  return fragments;
}
