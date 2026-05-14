/**
 * Off-day toggle wiring shared by the home page, WakeUpSheet, TagSheet,
 * and the history view. Every surface lets the parent flag a date as
 * "utypisk" (sick / travel / DST / growth spurt) so the trend engine
 * excludes it. The contract:
 *
 *   - `date` is a local YYYY-MM-DD in the baby's timezone.
 *   - `isOffDay` is the current flag state — caller passes it from the
 *     latest server snapshot so the toggle inverts the right thing.
 *   - The function fires a single event and resolves when sync round-
 *     trips the response. Callers can await it (e.g. to disable the
 *     button while busy).
 */

import { sync } from "$lib/stores/sync.svelte.js";

export async function toggleOffDay(
  babyId: number,
  date: string,
  isOffDay: boolean,
  reason: string | null = null,
): Promise<void> {
  if (isOffDay) {
    await sync.sendEvents([{ type: "day.unmarked_off", payload: { babyId, date } }]);
  } else {
    await sync.sendEvents([{ type: "day.marked_off", payload: { babyId, date, reason } }]);
  }
}

/**
 * Local YYYY-MM-DD for an ISO timestamp in the baby's tz. Centralised so
 * every off-day surface keys against the same date string the server
 * stored in `day_start.date`.
 */
export function localDateForOffDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(iso));
}
