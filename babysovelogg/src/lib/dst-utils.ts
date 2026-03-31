/** DST (Daylight Saving Time) detection utilities.
 *
 *  Uses the Intl API to detect UTC offset changes in a given IANA timezone,
 *  without hard-coding any transition rules.
 */

export interface DstTransition {
	/** The Date when the transition happens (local midnight of the transition day). */
	date: Date;
	/** 'spring-forward' = clocks move ahead (lose an hour), 'fall-back' = clocks move back (gain an hour). */
	direction: 'spring-forward' | 'fall-back';
	/** Absolute offset change in minutes (always positive — e.g. 60). */
	offsetChangeMinutes: number;
}

/** Get the UTC offset in minutes for a given IANA timezone at a specific instant. */
function getUtcOffsetMinutes(date: Date, tz: string): number {
	// Format as locale parts and reconstruct a UTC-interpreted date,
	// then compare with the original to find the offset.
	const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
	const localStr = date.toLocaleString('en-US', { timeZone: tz });
	return (new Date(localStr).getTime() - new Date(utcStr).getTime()) / 60_000;
}

/**
 * Find the next DST transition within `daysAhead` days from the given reference date.
 * Scans day-by-day looking for a UTC offset change.
 */
export function getNextDstTransition(
	tz: string,
	now: Date = new Date(),
	daysAhead: number = 90,
): DstTransition | null {
	const currentOffset = getUtcOffsetMinutes(now, tz);

	for (let i = 1; i <= daysAhead; i++) {
		const day = new Date(now.getTime() + i * 86_400_000);
		const dayOffset = getUtcOffsetMinutes(day, tz);

		if (dayOffset !== currentOffset) {
			const change = dayOffset - currentOffset;
			// Construct midnight local for the transition day
			const dateStr = day.toLocaleDateString('en-CA', { timeZone: tz });
			const midnight = new Date(`${dateStr}T00:00:00`);

			return {
				date: midnight,
				direction: change > 0 ? 'spring-forward' : 'fall-back',
				offsetChangeMinutes: Math.abs(change),
			};
		}
	}

	return null;
}

/**
 * Returns the most recent past DST transition (within `daysBack` days).
 * Useful for "yesterday's bedtime adjusted for DST" calculations.
 */
export function getRecentDstTransition(
	tz: string,
	now: Date = new Date(),
	daysBack: number = 3,
): DstTransition | null {
	const currentOffset = getUtcOffsetMinutes(now, tz);

	for (let i = 1; i <= daysBack; i++) {
		const day = new Date(now.getTime() - i * 86_400_000);
		const dayOffset = getUtcOffsetMinutes(day, tz);

		if (dayOffset !== currentOffset) {
			const change = currentOffset - dayOffset;
			// The transition happened on 'now - (i-1) days' (the first day with the new offset)
			const transDay = new Date(now.getTime() - (i - 1) * 86_400_000);
			const dateStr = transDay.toLocaleDateString('en-CA', { timeZone: tz });
			const midnight = new Date(`${dateStr}T00:00:00`);

			return {
				date: midnight,
				direction: change > 0 ? 'spring-forward' : 'fall-back',
				offsetChangeMinutes: Math.abs(change),
			};
		}
	}

	return null;
}

/**
 * Check if a DST transition is "nearby" (within `rangeDays` in either direction).
 * Returns the transition info if found, null otherwise.
 */
export function getNearbyDstTransition(
	tz: string,
	now: Date = new Date(),
	rangeDays: number = 3,
): DstTransition | null {
	return getNextDstTransition(tz, now, rangeDays) ?? getRecentDstTransition(tz, now, rangeDays);
}

/**
 * Given a time string "HH:MM" that was the bedtime yesterday,
 * return the DST-adjusted equivalent for today.
 *
 * E.g. if yesterday was CET and today is CEST (spring forward),
 * "18:20" yesterday means "19:20" today in wall-clock terms
 * (same solar instant is one hour later on the clock).
 *
 * Returns null if there's no recent DST transition.
 */
export function getDstAdjustedTime(
	time: string,
	tz: string,
	now: Date = new Date(),
): string | null {
	const recent = getRecentDstTransition(tz, now, 3);
	if (!recent) return null;

	const [h, m] = time.split(':').map(Number);
	const totalMinutes = h * 60 + m;

	// Spring forward: clocks jump ahead, so yesterday's 18:20 = today's 19:20
	// Fall back: clocks jump back, so yesterday's 18:20 = today's 17:20
	const adjusted =
		recent.direction === 'spring-forward'
			? totalMinutes + recent.offsetChangeMinutes
			: totalMinutes - recent.offsetChangeMinutes;

	const clampedH = Math.floor(Math.max(0, Math.min(adjusted, 23 * 60 + 59)) / 60);
	const clampedM = Math.max(0, Math.min(adjusted, 23 * 60 + 59)) % 60;

	return `${String(clampedH).padStart(2, '0')}:${String(clampedM).padStart(2, '0')}`;
}

const NN_WEEKDAYS = ['sundag', 'måndag', 'tysdag', 'onsdag', 'torsdag', 'fredag', 'laurdag'];
const NN_MONTHS = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];

/** Format a Date as "sundag 29. mars" in Nynorsk style.
 *  Uses manual lookup instead of toLocaleDateString because nn-NO
 *  locale data is missing in Bun's SSR runtime. */
export function formatDstDate(date: Date): string {
	return `${NN_WEEKDAYS[date.getDay()]} ${date.getDate()}. ${NN_MONTHS[date.getMonth()]}`;
}
