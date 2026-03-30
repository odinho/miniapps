/** Timezone utilities for consistent day-boundary calculations.
 *  All timestamps in the DB are ISO UTC strings. The baby's stored IANA timezone
 *  is used to determine what "today" means locally. */

/** Convert a UTC ISO string to a YYYY-MM-DD date in the given IANA timezone. */
export function isoToDateInTz(iso: string, tz: string): string {
	return new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
}

/** Get the fractional hour (e.g. 18.5 = 18:30) of a Date in a given IANA timezone. */
export function getHourInTz(date: Date, tz: string): number {
	const h = parseInt(date.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
	const m = parseInt(date.toLocaleString("en-US", { timeZone: tz, minute: "numeric" }));
	return h + m / 60;
}

/** Set a Date to a specific local hour in the given IANA timezone, preserving the date. */
export function setHourInTz(date: Date, hour: number, minute: number, tz: string): Date {
	const dateStr = date.toLocaleDateString("en-CA", { timeZone: tz });
	// Treat the target time as UTC, then subtract the TZ offset to get the real UTC instant.
	// Same pattern as todayInTz for midnight.
	const asUtc = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
	const utcRef = asUtc.toLocaleString("en-US", { timeZone: "UTC" });
	const localRef = asUtc.toLocaleString("en-US", { timeZone: tz });
	const offsetMs = new Date(localRef).getTime() - new Date(utcRef).getTime();
	return new Date(asUtc.getTime() - offsetMs);
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
