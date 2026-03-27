/** Timezone utilities for consistent day-boundary calculations.
 *  All timestamps in the DB are ISO UTC strings. The baby's stored IANA timezone
 *  is used to determine what "today" means locally. */

/** Convert a UTC ISO string to a YYYY-MM-DD date in the given IANA timezone. */
export function isoToDateInTz(iso: string, tz: string): string {
	return new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
}

/** Get today's date (YYYY-MM-DD) and the UTC ISO string for midnight in the given timezone.
 *  midnightIso is suitable for SQL `>=` comparisons against UTC timestamps. */
export function todayInTz(tz: string): { dateStr: string; midnightIso: string } {
	const now = new Date();
	const dateStr = now.toLocaleDateString("en-CA", { timeZone: tz });
	const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
	const localStr = now.toLocaleString("en-US", { timeZone: tz });
	const offsetMs = new Date(localStr).getTime() - new Date(utcStr).getTime();
	const midnightIso = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - offsetMs).toISOString();
	return { dateStr, midnightIso };
}
