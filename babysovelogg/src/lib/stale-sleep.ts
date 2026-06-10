/**
 * Staleness classification for an open (not-yet-ended) sleep.
 *
 * A sleep row whose `end_time` is null is "active". Normally that means the
 * baby is asleep right now. But if the parent forgot to tap wake, the row
 * stays open and the timer counts up forever (the 466:34:51 report). No real
 * single sleep — night or nap, any age — lasts a full day, so once an open
 * sleep crosses 24h it's almost certainly an abandoned session, not a real
 * one. We surface that instead of treating it as a live active sleep.
 *
 *   - `stale`     (≥24h): we've gone clearly over a day. The session is
 *                 invalid; the UI stops the runaway timer and prompts the
 *                 parent to set the real wake time or discard it.
 *   - `abandoned` (≥48h): no meaningful recovery left. The UI additionally
 *                 forces the "when did they wake" morning onboarding so the
 *                 day can start fresh.
 */

export const STALE_ACTIVE_SLEEP_MS = 24 * 60 * 60 * 1000;
export const ABANDONED_ACTIVE_SLEEP_MS = 48 * 60 * 60 * 1000;

export type StaleStatus = "stale" | "abandoned";

/**
 * Classify an open sleep by how long it has been running.
 * Returns null for a fresh open sleep, a closed sleep, or no sleep — only
 * a genuinely over-a-day open session yields a status.
 */
export function classifyActiveSleep(
  sleep: { start_time: string; end_time: string | null } | null | undefined,
  now: number,
): StaleStatus | null {
  if (!sleep || sleep.end_time) return null;
  const elapsed = now - new Date(sleep.start_time).getTime();
  if (elapsed >= ABANDONED_ACTIVE_SLEEP_MS) return "abandoned";
  if (elapsed >= STALE_ACTIVE_SLEEP_MS) return "stale";
  return null;
}
