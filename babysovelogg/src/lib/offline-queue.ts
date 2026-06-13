/**
 * Offline event queue — localStorage-backed queue with optimistic state updates.
 * Pure module (no Svelte runes), fully unit-testable.
 */

import type { AppState, BabyState } from "./stores/app.svelte.js";
import type { SleepLogRow, DayStartRow } from "./types.js";
import type { AppEventType } from "./server/schemas.js";
import { isoToDateInTz } from "./tz.js";

const QUEUE_KEY = "babysovelogg_event_queue";
const STATE_CACHE_KEY = "babysovelogg_cached_state";

export interface QueuedEvent {
	type: string;
	payload: Record<string, unknown>;
	clientId: string;
	clientEventId: string;
	timestamp: string;
}

// --- Queue persistence ---

export function getQueue(): QueuedEvent[] {
	try {
		return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
	} catch {
		return [];
	}
}

export function saveQueue(queue: QueuedEvent[]): boolean {
	try {
		localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
		return true;
	} catch {
		return false;
	}
}

export function clearQueue(): void {
	localStorage.setItem(QUEUE_KEY, "[]");
}

export function enqueue(event: QueuedEvent): boolean {
	const queue = getQueue();
	queue.push(event);
	return saveQueue(queue);
}

export function getPendingCount(): number {
	return getQueue().length;
}

export function hasPendingEvents(): boolean {
	return getPendingCount() > 0;
}

// --- State caching ---

export function cacheState(state: AppState): void {
	try {
		localStorage.setItem(STATE_CACHE_KEY, JSON.stringify(state));
	} catch {
		// quota exceeded — silently ignore
	}
}

export function getCachedState(): AppState | null {
	try {
		return JSON.parse(localStorage.getItem(STATE_CACHE_KEY) || "null");
	} catch {
		return null;
	}
}

// --- Optimistic state updates ---

/**
 * Apply a single event optimistically to local state so the UI reflects
 * offline changes. Routes the event into the correct baby's slice — by
 * `payload.babyId`, else by the slice that owns the event's domain_id, else
 * the primary (newest) baby — so logging on one twin never lands on the
 * other. The top-level alias is re-derived from the primary slice afterward,
 * keeping single-baby surfaces in sync without double-bookkeeping.
 */
export function applyOptimisticEvent(
	state: AppState,
	type: string,
	payload: Record<string, unknown>,
): AppState {
	// JSON round-trip rather than structuredClone: the caller often passes a
	// Svelte 5 `$state` proxy, and structuredClone throws on those because
	// the proxy's internal hooks aren't structured-clone-serializable. JSON
	// is sufficient because AppState is plain JSON-safe data (no Date,
	// Map, etc).
	const full: AppState = JSON.parse(JSON.stringify(state));
	let babies: BabyState[] = Array.isArray(full.babies) ? full.babies : [];
	// Legacy cache / older server without a babies[] array: treat the flat
	// top-level as the single slice so optimistic updates still work offline.
	if (babies.length === 0) {
		if (!full.baby) return { ...full, babies: [] };
		const { babies: _omit, ...slice } = full;
		babies = [slice];
	}

	const idx = findSliceIndex(babies, payload);
	babies[idx] = applyEventToSlice(babies[idx], type, payload);
	const primary = babies[babies.length - 1];
	// `family` is household-level — carry it through unchanged (the flat alias
	// is rebuilt from `primary`, which is a per-baby slice without it).
	return { ...primary, babies, family: full.family };
}

/** Which baby slice an event belongs to (see applyOptimisticEvent). */
function findSliceIndex(babies: BabyState[], payload: Record<string, unknown>): number {
	const last = babies.length - 1;
	if (payload.babyId != null) {
		const i = babies.findIndex((b) => b.baby?.id === payload.babyId);
		return i >= 0 ? i : last;
	}
	// Events that carry only a domain_id (sleep.ended/updated/…,
	// night_waking.*): find the slice that owns that entity.
	const domainId = (payload.sleepDomainId ?? payload.wakingDomainId) as string | undefined;
	if (domainId) {
		const i = babies.findIndex(
			(b) =>
				b.activeSleep?.domain_id === domainId ||
				b.staleActiveSleep?.domain_id === domainId ||
				b.todaySleeps.some((s) => s.domain_id === domainId) ||
				b.todayNightWakings.some((w) => w.domain_id === domainId),
		);
		return i >= 0 ? i : last;
	}
	return last;
}

/** Apply one event to a single baby's slice (mutates and returns the slice;
 *  the caller has already cloned). */
function applyEventToSlice(
	s: BabyState,
	type: string,
	payload: Record<string, unknown>,
): BabyState {
	// Defensive default: pre-redesign cached state in localStorage may lack
	// todayNightWakings. Without this, the night_waking.* cases below would
	// throw on `s.todayNightWakings.map(...)` etc.
	if (!Array.isArray(s.todayNightWakings)) s.todayNightWakings = [];

	// `type` is narrowed to AppEventType inside the switch so the `never`
	// branch at the bottom rejects adding a new event type in schemas.ts
	// without an explicit case here (use `: break;` for deliberate no-ops).
	const evt = type as AppEventType;
	switch (evt) {
		case "sleep.started": {
			s.activeSleep = {
				id: 0,
				baby_id: (payload.babyId as number) || s.baby?.id || 0,
				start_time: payload.startTime as string,
				end_time: null,
				type: (payload.type as string) || "nap",
				notes: null,
				mood: null,
				method: null,
				fall_asleep_time: null,
				onset_note: null,
				woke_by: null,
				wake_notes: null,
				wake_mood: null,
				deleted: 0,
				domain_id: payload.sleepDomainId as string,
				created_by_event_id: null,
				updated_by_event_id: null,
			};
			break;
		}

		case "sleep.ended": {
			if (s.activeSleep && s.activeSleep.domain_id === payload.sleepDomainId) {
				const ended = { ...s.activeSleep, end_time: payload.endTime as string };
				s.todaySleeps = [...s.todaySleeps, ended];
				s.activeSleep = null;
				if (s.stats) {
					const durationMs =
						new Date(ended.end_time!).getTime() - new Date(ended.start_time).getTime();
					const durationMin = Math.max(0, durationMs / 60000);
					if (ended.type === "nap") {
						s.stats.napCount += 1;
						s.stats.totalNapMinutes += durationMin;
					} else {
						s.stats.totalNightMinutes += durationMin;
					}
				}
			}
			break;
		}

		// Legacy pause events — see the matching no-op projections in
		// src/lib/server/projections.ts. The sleep_pauses table is gone;
		// new code only emits night_waking.* events.
		case "sleep.paused":
		case "sleep.resumed":
		case "sleep.pause_deleted":
			break;

		case "sleep.tagged": {
			const target = findSleep(s, payload.sleepDomainId as string);
			if (target) {
				if (payload.mood !== undefined) target.mood = payload.mood as string | null;
				if (payload.method !== undefined) target.method = payload.method as string | null;
				if (payload.fallAsleepTime !== undefined)
					target.fall_asleep_time = payload.fallAsleepTime as string | null;
				if (payload.notes !== undefined) target.notes = (payload.notes as string) || null;
				if (payload.onsetNote !== undefined)
					target.onset_note = (payload.onsetNote as string) || null;
			}
			break;
		}

		case "sleep.updated": {
			const sleepDomainId = payload.sleepDomainId as string;
			// Closing an over-a-day stale session via the wake-up sheet records
			// an end_time; clear the banner optimistically too.
			if (payload.endTime && s.staleActiveSleep?.domain_id === sleepDomainId) {
				s.staleActiveSleep = null;
			}
			const target = findSleep(s, sleepDomainId);
			if (target) {
				if (payload.startTime !== undefined) target.start_time = payload.startTime as string;
				if (payload.endTime !== undefined) target.end_time = (payload.endTime as string) || null;
				if (payload.wokeBy !== undefined) target.woke_by = (payload.wokeBy as string) || null;
				if (payload.wakeNotes !== undefined)
					target.wake_notes = (payload.wakeNotes as string) || null;
				if (payload.wakeMood !== undefined)
					target.wake_mood = (payload.wakeMood as string) || null;
				if (payload.onsetNote !== undefined)
					target.onset_note = (payload.onsetNote as string) || null;
				if (payload.type !== undefined) target.type = payload.type as string;
				// Tag-style fields are also accepted on sleep.updated by the
				// projection — mirror them so the offline view doesn't diverge
				// when a parent edits notes/mood/method while offline.
				if (payload.mood !== undefined) target.mood = (payload.mood as string) || null;
				if (payload.method !== undefined) target.method = (payload.method as string) || null;
				if (payload.fallAsleepTime !== undefined)
					target.fall_asleep_time = (payload.fallAsleepTime as string) || null;
				if (payload.notes !== undefined) target.notes = (payload.notes as string) || null;
			}
			break;
		}

		case "sleep.manual": {
			const manual: SleepLogRow = {
				id: 0,
				baby_id: (payload.babyId as number) || s.baby?.id || 0,
				start_time: payload.startTime as string,
				end_time: (payload.endTime as string) || null,
				type: (payload.type as string) || "nap",
				notes: null,
				mood: null,
				method: null,
				fall_asleep_time: null,
				onset_note: null,
				woke_by: null,
				wake_notes: null,
				wake_mood: null,
				deleted: 0,
				domain_id: (payload.sleepDomainId as string) || `slp_optimistic_${Date.now()}`,
				created_by_event_id: null,
				updated_by_event_id: null,
			};
			s.todaySleeps = [...s.todaySleeps, manual];
			if (s.stats && manual.end_time) {
				const durationMs =
					new Date(manual.end_time).getTime() - new Date(manual.start_time).getTime();
				const durationMin = Math.max(0, durationMs / 60000);
				if (manual.type === "nap") {
					s.stats.napCount += 1;
					s.stats.totalNapMinutes += durationMin;
				} else {
					s.stats.totalNightMinutes += durationMin;
				}
			}
			break;
		}

		case "sleep.deleted": {
			const domainId = payload.sleepDomainId as string;
			// Discarding an over-a-day stale session offline: clear the banner
			// optimistically so it doesn't linger until the next server fetch.
			if (s.staleActiveSleep?.domain_id === domainId) s.staleActiveSleep = null;
			// Undo of "Søvn starta" / "Sove begge" is a sleep.deleted on a sleep
			// that's still active — clear activeSleep too, or offline the baby
			// stays "asleep" locally and follow-up events fire against a session
			// the parent thought was undone.
			if (s.activeSleep?.domain_id === domainId) s.activeSleep = null;
			const deleted = s.todaySleeps.find((sl) => sl.domain_id === domainId);
			s.todaySleeps = s.todaySleeps.filter((sl) => sl.domain_id !== domainId);
			if (s.stats && deleted?.end_time) {
				const durationMs =
					new Date(deleted.end_time).getTime() - new Date(deleted.start_time).getTime();
				const durationMin = Math.max(0, durationMs / 60000);
				if (deleted.type === "nap") {
					s.stats.napCount = Math.max(0, s.stats.napCount - 1);
					s.stats.totalNapMinutes = Math.max(0, s.stats.totalNapMinutes - durationMin);
				} else {
					s.stats.totalNightMinutes = Math.max(0, s.stats.totalNightMinutes - durationMin);
				}
			}
			break;
		}

		case "sleep.restarted": {
			const domainId = payload.sleepDomainId as string;
			const idx = s.todaySleeps.findIndex((sl) => sl.domain_id === domainId);
			if (idx !== -1) {
				const original = s.todaySleeps[idx];
				s.activeSleep = { ...original, end_time: null };
				s.todaySleeps = s.todaySleeps.filter((_, i) => i !== idx);
				if (s.stats && original.end_time) {
					const durationMs =
						new Date(original.end_time).getTime() - new Date(original.start_time).getTime();
					const durationMin = Math.max(0, durationMs / 60000);
					if (original.type === "nap") {
						s.stats.napCount = Math.max(0, s.stats.napCount - 1);
						s.stats.totalNapMinutes = Math.max(0, s.stats.totalNapMinutes - durationMin);
					} else {
						s.stats.totalNightMinutes = Math.max(0, s.stats.totalNightMinutes - durationMin);
					}
				}
			}
			break;
		}

		case "diaper.logged": {
			s.diaperCount = (s.diaperCount || 0) + 1;
			s.lastDiaperTime = payload.time as string;
			break;
		}

		case "day.started": {
			const tz = s.baby?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
			s.todayWakeUp = {
				id: 0,
				baby_id: (payload.babyId as number) || s.baby?.id || 0,
				date: isoToDateInTz(payload.wakeTime as string, tz),
				wake_time: payload.wakeTime as string,
				created_at: new Date().toISOString(),
				created_by_event_id: null,
			} as DayStartRow;
			break;
		}

		case "day.marked_off": {
			const date = payload.date as string;
			const reason = (payload.reason as string | null | undefined) ?? null;
			if (!s.offDays.includes(date)) {
				s.offDays = [...s.offDays, date];
			}
			if (s.todayWakeUp && s.todayWakeUp.date === date) {
				s.todayWakeUp = { ...s.todayWakeUp, off_day: 1, off_day_reason: reason };
			}
			break;
		}

		case "day.unmarked_off": {
			const date = payload.date as string;
			s.offDays = s.offDays.filter((d) => d !== date);
			if (s.todayWakeUp && s.todayWakeUp.date === date) {
				s.todayWakeUp = { ...s.todayWakeUp, off_day: 0, off_day_reason: null };
			}
			break;
		}

		case "night_waking.started": {
			const wakingDomainId = payload.wakingDomainId as string;
			const babyId = (payload.babyId as number) || s.baby?.id || 0;
			s.todayNightWakings = [
				...s.todayNightWakings,
				{
					id: 0,
					baby_id: babyId,
					domain_id: wakingDomainId,
					start_time: payload.startTime as string,
					end_time: null,
					notes: null,
					mood: null,
					deleted: 0,
					created_by_event_id: null,
					updated_by_event_id: null,
				},
			];
			break;
		}

		case "night_waking.ended": {
			const wakingDomainId = payload.wakingDomainId as string;
			s.todayNightWakings = s.todayNightWakings.map((w) =>
				w.domain_id === wakingDomainId ? { ...w, end_time: payload.endTime as string } : w,
			);
			break;
		}

		case "night_waking.edited": {
			const wakingDomainId = payload.wakingDomainId as string;
			s.todayNightWakings = s.todayNightWakings.map((w) => {
				if (w.domain_id !== wakingDomainId) return w;
				return {
					...w,
					start_time: (payload.startTime as string | null | undefined) ?? w.start_time,
					end_time:
						payload.endTime !== undefined
							? (payload.endTime as string | null)
							: w.end_time,
					notes:
						payload.notes !== undefined ? (payload.notes as string | null) : w.notes,
					mood: payload.mood !== undefined ? (payload.mood as string | null) : w.mood,
				};
			});
			break;
		}

		case "night_waking.deleted": {
			const wakingDomainId = payload.wakingDomainId as string;
			s.todayNightWakings = s.todayNightWakings.filter(
				(w) => w.domain_id !== wakingDomainId,
			);
			break;
		}

		// Deliberate no-ops — these events exist in the wire protocol but
		// don't have an optimistic projection (the client either rarely
		// emits them offline, or the affected state isn't visible locally
		// until the server roundtrips and replaces AppState).
		case "baby.created":
		case "baby.updated":
		case "family.updated":
		case "day.deleted":
		case "diaper.updated":
		case "diaper.deleted":
			break;

		default: {
			// Exhaustiveness: when a new event is added to AppEventType
			// (schemas.ts) without a matching case here, this assignment
			// becomes `string` → `never` and the build fails. Forces an
			// explicit decision: either project the new event optimistically
			// or drop it into the no-op block above.
			const _exhaustive: never = evt;
			void _exhaustive;
		}
	}

	return s;
}

/** Apply all queued events to a state (used on boot when offline). */
export function applyQueuedEvents(state: AppState): AppState {
	const queue = getQueue();
	let s = state;
	for (const event of queue) {
		s = applyOptimisticEvent(s, event.type, event.payload);
	}
	return s;
}

/** Find a sleep entry by domain_id in activeSleep or todaySleeps (returns mutable ref). */
function findSleep(state: BabyState, domainId: string): SleepLogRow | undefined {
	if (state.activeSleep?.domain_id === domainId) return state.activeSleep;
	return state.todaySleeps.find((s) => s.domain_id === domainId);
}
