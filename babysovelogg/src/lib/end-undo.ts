import type { SleepLogRow } from '$lib/types.js';

/**
 * Window during which a parent can undo the End of a nap and have it
 * resume as an active sleep. Stage 1 of the pause-UX redesign — see
 * `docs/pause-redesign-2026-05-22.md`.
 */
export const END_UNDO_WINDOW_MS = 15 * 60_000;

/**
 * True iff the just-ended nap is still eligible for an in-sheet undo
 * affordance: type=nap, end_time within the window from `now`, and no
 * later sleep has been started. The "no later sleep" check guards
 * against undoing into the middle of the next sleep — a state the
 * engine has no good interpretation for.
 *
 * `now` is injectable for tests; defaults to the wall clock.
 */
export function isWithinEndUndoWindow(
	sleepSnapshot: Pick<SleepLogRow, 'domain_id' | 'type' | 'end_time'>,
	todaySleeps: Pick<SleepLogRow, 'domain_id' | 'start_time'>[],
	now: number = Date.now(),
): boolean {
	if (sleepSnapshot.type !== 'nap') return false;
	if (!sleepSnapshot.end_time) return false;
	const endMs = new Date(sleepSnapshot.end_time).getTime();
	if (now - endMs >= END_UNDO_WINDOW_MS) return false;
	if (now - endMs < 0) return false;
	const hasLater = todaySleeps.some(
		(s) =>
			s.domain_id !== sleepSnapshot.domain_id &&
			new Date(s.start_time).getTime() > endMs,
	);
	return !hasLater;
}
