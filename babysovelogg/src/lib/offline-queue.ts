/**
 * Offline event queue — localStorage-backed queue with optimistic state updates.
 * Pure module (no Svelte runes), fully unit-testable.
 */

import type { AppState } from "./stores/app.svelte.js";
import type { SleepLogRow, DayStartRow } from "./types.js";
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

/** Apply a single event optimistically to local state so UI reflects offline changes. */
export function applyOptimisticEvent(
	state: AppState,
	type: string,
	payload: Record<string, unknown>,
): AppState {
	const s: AppState = JSON.parse(JSON.stringify(state));

	switch (type) {
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
				woke_by: null,
				wake_notes: null,
				deleted: 0,
				domain_id: payload.sleepDomainId as string,
				created_by_event_id: null,
				updated_by_event_id: null,
				pauses: [],
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

		case "sleep.paused": {
			if (s.activeSleep && s.activeSleep.domain_id === payload.sleepDomainId) {
				const pauses = [...(s.activeSleep.pauses || [])];
				pauses.push({
					id: 0,
					sleep_id: s.activeSleep.id,
					pause_time: payload.pauseTime as string,
					resume_time: null,
					created_by_event_id: null,
				});
				s.activeSleep = { ...s.activeSleep, pauses };
			}
			break;
		}

		case "sleep.resumed": {
			if (s.activeSleep && s.activeSleep.domain_id === payload.sleepDomainId) {
				const pauses = [...(s.activeSleep.pauses || [])];
				const last = pauses[pauses.length - 1];
				if (last && !last.resume_time) {
					pauses[pauses.length - 1] = { ...last, resume_time: payload.resumeTime as string };
					s.activeSleep = { ...s.activeSleep, pauses };
				}
			}
			break;
		}

		case "sleep.tagged": {
			const target = findSleep(s, payload.sleepDomainId as string);
			if (target) {
				if (payload.mood !== undefined) target.mood = payload.mood as string | null;
				if (payload.method !== undefined) target.method = payload.method as string | null;
				if (payload.fallAsleepTime !== undefined)
					target.fall_asleep_time = payload.fallAsleepTime as string | null;
				if (payload.notes !== undefined) target.notes = (payload.notes as string) || null;
			}
			break;
		}

		case "sleep.updated": {
			const target = findSleep(s, payload.sleepDomainId as string);
			if (target) {
				if (payload.startTime !== undefined) target.start_time = payload.startTime as string;
				if (payload.endTime !== undefined) target.end_time = (payload.endTime as string) || null;
				if (payload.wokeBy !== undefined) target.woke_by = (payload.wokeBy as string) || null;
				if (payload.wakeNotes !== undefined)
					target.wake_notes = (payload.wakeNotes as string) || null;
				if (payload.type !== undefined) target.type = payload.type as string;
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
				woke_by: null,
				wake_notes: null,
				deleted: 0,
				domain_id: (payload.sleepDomainId as string) || `slp_optimistic_${Date.now()}`,
				created_by_event_id: null,
				updated_by_event_id: null,
				pauses: [],
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
			// Derive date in baby's timezone, matching server behavior in projections.ts
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
function findSleep(state: AppState, domainId: string): SleepLogRow | undefined {
	if (state.activeSleep?.domain_id === domainId) return state.activeSleep;
	return state.todaySleeps.find((s) => s.domain_id === domainId);
}
