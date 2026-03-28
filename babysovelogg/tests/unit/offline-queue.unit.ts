import { describe, it, expect, beforeEach } from 'vitest';
import {
	getQueue,
	saveQueue,
	clearQueue,
	enqueue,
	getPendingCount,
	hasPendingEvents,
	cacheState,
	getCachedState,
	applyOptimisticEvent,
	applyQueuedEvents,
	type QueuedEvent,
} from '$lib/offline-queue.js';
import type { AppState } from '$lib/stores/app.svelte.js';
import type { SleepLogRow } from '$lib/types.js';

function makeState(overrides: Partial<AppState> = {}): AppState {
	return {
		baby: { id: 1, name: 'Halldis', birthdate: '2025-06-01', created_at: '2025-06-01', custom_nap_count: null, potty_mode: 0, timezone: null, created_by_event_id: null, updated_by_event_id: null },
		activeSleep: null,
		todaySleeps: [],
		stats: { napCount: 1, totalNapMinutes: 45, totalNightMinutes: 600, sleeps: [] },
		prediction: null,
		ageMonths: 9,
		diaperCount: 3,
		lastDiaperTime: '2026-03-27T08:00:00.000Z',
		todayWakeUp: null,
		...overrides,
	};
}

function makeSleep(overrides: Partial<SleepLogRow> = {}): SleepLogRow {
	return {
		id: 1,
		baby_id: 1,
		start_time: '2026-03-27T10:00:00.000Z',
		end_time: null,
		type: 'nap',
		notes: null,
		mood: null,
		method: null,
		fall_asleep_time: null,
		woke_by: null,
		wake_notes: null,
		deleted: 0,
		domain_id: 'slp_test1',
		created_by_event_id: null,
		updated_by_event_id: null,
		pauses: [],
		...overrides,
	};
}

function makeEvent(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
	return {
		type: 'sleep.started',
		payload: {},
		clientId: 'client1',
		clientEventId: 'evt1',
		timestamp: '2026-03-27T10:00:00.000Z',
		...overrides,
	};
}

// Mock localStorage
const store: Record<string, string> = {};
beforeEach(() => {
	Object.keys(store).forEach((k) => delete store[k]);
	globalThis.localStorage = {
		getItem: (k: string) => store[k] ?? null,
		setItem: (k: string, v: string) => { store[k] = v; },
		removeItem: (k: string) => { delete store[k]; },
		clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
		length: 0,
		key: () => null,
	};
});

describe('Queue persistence', () => {
	it('returns empty queue when nothing stored', () => {
		expect(getQueue()).toEqual([]);
	});

	it('saves and retrieves events', () => {
		const evt = makeEvent({ type: 'sleep.started' });
		saveQueue([evt]);
		expect(getQueue()).toEqual([evt]);
	});

	it('enqueue appends to existing queue', () => {
		const evt1 = makeEvent({ clientEventId: 'e1' });
		const evt2 = makeEvent({ clientEventId: 'e2' });
		enqueue(evt1);
		enqueue(evt2);
		expect(getQueue()).toHaveLength(2);
		expect(getQueue()[1].clientEventId).toBe('e2');
	});

	it('clearQueue empties the queue', () => {
		enqueue(makeEvent());
		clearQueue();
		expect(getQueue()).toEqual([]);
	});

	it('getPendingCount returns queue length', () => {
		expect(getPendingCount()).toBe(0);
		enqueue(makeEvent());
		expect(getPendingCount()).toBe(1);
	});

	it('hasPendingEvents is true when queue is non-empty', () => {
		expect(hasPendingEvents()).toBe(false);
		enqueue(makeEvent());
		expect(hasPendingEvents()).toBe(true);
	});

	it('handles corrupted localStorage gracefully', () => {
		store['babysovelogg_event_queue'] = '{invalid json';
		expect(getQueue()).toEqual([]);
	});
});

describe('State caching', () => {
	it('caches and retrieves state', () => {
		const state = makeState();
		cacheState(state);
		const cached = getCachedState();
		expect(cached?.baby?.name).toBe('Halldis');
	});

	it('returns null when no cached state', () => {
		expect(getCachedState()).toBeNull();
	});

	it('handles corrupted cached state gracefully', () => {
		store['babysovelogg_cached_state'] = 'not json';
		expect(getCachedState()).toBeNull();
	});
});

describe('applyOptimisticEvent', () => {
	it('sleep.started sets activeSleep', () => {
		const state = makeState();
		const result = applyOptimisticEvent(state, 'sleep.started', {
			babyId: 1,
			startTime: '2026-03-27T12:00:00.000Z',
			type: 'nap',
			sleepDomainId: 'slp_new',
		});
		expect(result.activeSleep).not.toBeNull();
		expect(result.activeSleep!.domain_id).toBe('slp_new');
		expect(result.activeSleep!.start_time).toBe('2026-03-27T12:00:00.000Z');
		expect(result.activeSleep!.type).toBe('nap');
	});

	it('sleep.ended moves activeSleep to todaySleeps', () => {
		const active = makeSleep({ domain_id: 'slp_end', start_time: '2026-03-27T12:00:00.000Z' });
		const state = makeState({ activeSleep: active, todaySleeps: [] });
		const result = applyOptimisticEvent(state, 'sleep.ended', {
			sleepDomainId: 'slp_end',
			endTime: '2026-03-27T12:30:00.000Z',
		});
		expect(result.activeSleep).toBeNull();
		expect(result.todaySleeps).toHaveLength(1);
		expect(result.todaySleeps[0].end_time).toBe('2026-03-27T12:30:00.000Z');
	});

	it('sleep.ended updates nap stats', () => {
		const active = makeSleep({ domain_id: 'slp_s', start_time: '2026-03-27T12:00:00.000Z', type: 'nap' });
		const state = makeState({ activeSleep: active });
		const result = applyOptimisticEvent(state, 'sleep.ended', {
			sleepDomainId: 'slp_s',
			endTime: '2026-03-27T12:30:00.000Z',
		});
		expect(result.stats!.napCount).toBe(2); // was 1 + 1
		expect(result.stats!.totalNapMinutes).toBe(75); // was 45 + 30
	});

	it('sleep.ended ignores mismatched domainId', () => {
		const active = makeSleep({ domain_id: 'slp_a' });
		const state = makeState({ activeSleep: active });
		const result = applyOptimisticEvent(state, 'sleep.ended', {
			sleepDomainId: 'slp_different',
			endTime: '2026-03-27T12:30:00.000Z',
		});
		expect(result.activeSleep).not.toBeNull();
	});

	it('sleep.paused adds a pause to activeSleep', () => {
		const active = makeSleep({ domain_id: 'slp_p', pauses: [] });
		const state = makeState({ activeSleep: active });
		const result = applyOptimisticEvent(state, 'sleep.paused', {
			sleepDomainId: 'slp_p',
			pauseTime: '2026-03-27T12:15:00.000Z',
		});
		expect(result.activeSleep!.pauses).toHaveLength(1);
		expect(result.activeSleep!.pauses![0].pause_time).toBe('2026-03-27T12:15:00.000Z');
		expect(result.activeSleep!.pauses![0].resume_time).toBeNull();
	});

	it('sleep.resumed sets resume_time on last pause', () => {
		const active = makeSleep({
			domain_id: 'slp_r',
			pauses: [{ id: 0, sleep_id: 1, pause_time: '2026-03-27T12:15:00.000Z', resume_time: null, created_by_event_id: null }],
		});
		const state = makeState({ activeSleep: active });
		const result = applyOptimisticEvent(state, 'sleep.resumed', {
			sleepDomainId: 'slp_r',
			resumeTime: '2026-03-27T12:20:00.000Z',
		});
		expect(result.activeSleep!.pauses![0].resume_time).toBe('2026-03-27T12:20:00.000Z');
	});

	it('sleep.tagged updates mood and method on activeSleep', () => {
		const active = makeSleep({ domain_id: 'slp_t' });
		const state = makeState({ activeSleep: active });
		const result = applyOptimisticEvent(state, 'sleep.tagged', {
			sleepDomainId: 'slp_t',
			mood: 'normal',
			method: 'breastfeed',
		});
		expect(result.activeSleep!.mood).toBe('normal');
		expect(result.activeSleep!.method).toBe('breastfeed');
	});

	it('sleep.tagged works on todaySleeps entry', () => {
		const sleep = makeSleep({ domain_id: 'slp_td', end_time: '2026-03-27T12:30:00.000Z' });
		const state = makeState({ todaySleeps: [sleep] });
		const result = applyOptimisticEvent(state, 'sleep.tagged', {
			sleepDomainId: 'slp_td',
			mood: 'tired',
		});
		expect(result.todaySleeps[0].mood).toBe('tired');
	});

	it('sleep.updated changes fields', () => {
		const active = makeSleep({ domain_id: 'slp_u' });
		const state = makeState({ activeSleep: active });
		const result = applyOptimisticEvent(state, 'sleep.updated', {
			sleepDomainId: 'slp_u',
			startTime: '2026-03-27T11:30:00.000Z',
			wokeBy: 'self',
		});
		expect(result.activeSleep!.start_time).toBe('2026-03-27T11:30:00.000Z');
		expect(result.activeSleep!.woke_by).toBe('self');
	});

	it('sleep.manual adds to todaySleeps', () => {
		const state = makeState();
		const result = applyOptimisticEvent(state, 'sleep.manual', {
			startTime: '2026-03-27T09:00:00.000Z',
			endTime: '2026-03-27T09:45:00.000Z',
			type: 'nap',
			sleepDomainId: 'slp_manual',
		});
		expect(result.todaySleeps).toHaveLength(1);
		expect(result.todaySleeps[0].domain_id).toBe('slp_manual');
	});

	it('sleep.deleted removes from todaySleeps', () => {
		const sleep = makeSleep({ domain_id: 'slp_del' });
		const state = makeState({ todaySleeps: [sleep] });
		const result = applyOptimisticEvent(state, 'sleep.deleted', {
			sleepDomainId: 'slp_del',
		});
		expect(result.todaySleeps).toHaveLength(0);
	});

	it('diaper.logged increments count and updates time', () => {
		const state = makeState({ diaperCount: 2, lastDiaperTime: null });
		const result = applyOptimisticEvent(state, 'diaper.logged', {
			time: '2026-03-27T14:00:00.000Z',
		});
		expect(result.diaperCount).toBe(3);
		expect(result.lastDiaperTime).toBe('2026-03-27T14:00:00.000Z');
	});

	it('day.started sets todayWakeUp', () => {
		const state = makeState();
		const result = applyOptimisticEvent(state, 'day.started', {
			babyId: 1,
			wakeTime: '2026-03-27T07:00:00.000Z',
		});
		expect(result.todayWakeUp).not.toBeNull();
		expect(result.todayWakeUp!.wake_time).toBe('2026-03-27T07:00:00.000Z');
	});

	it('does not mutate original state', () => {
		const state = makeState();
		const original = JSON.stringify(state);
		applyOptimisticEvent(state, 'sleep.started', {
			startTime: '2026-03-27T12:00:00.000Z',
			sleepDomainId: 'slp_immutable',
		});
		expect(JSON.stringify(state)).toBe(original);
	});

	it('unknown event type returns state unchanged', () => {
		const state = makeState();
		const result = applyOptimisticEvent(state, 'unknown.event', { foo: 'bar' });
		expect(result.baby?.name).toBe('Halldis');
	});
});

describe('applyQueuedEvents', () => {
	it('applies multiple queued events in order', () => {
		enqueue(makeEvent({
			type: 'sleep.started',
			payload: { startTime: '2026-03-27T12:00:00.000Z', sleepDomainId: 'slp_q1', type: 'nap' },
		}));
		enqueue(makeEvent({
			type: 'diaper.logged',
			payload: { time: '2026-03-27T12:30:00.000Z' },
		}));

		const state = makeState();
		const result = applyQueuedEvents(state);
		expect(result.activeSleep).not.toBeNull();
		expect(result.diaperCount).toBe(4); // was 3 + 1
	});

	it('returns unchanged state when queue is empty', () => {
		const state = makeState();
		const result = applyQueuedEvents(state);
		expect(result.baby?.name).toBe('Halldis');
	});
});
