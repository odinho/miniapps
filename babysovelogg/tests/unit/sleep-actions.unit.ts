import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	buildStartSleep,
	buildEndSleep,
	buildPause,
	buildResume,
	isPaused,
} from '$lib/sleep-actions.js';
import type { SleepLogRow, SleepPauseRow } from '$lib/types.js';

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
		...overrides,
	};
}

describe('buildStartSleep', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-27T14:00:00.000Z'));
	});
	afterEach(() => vi.useRealTimers());

	it('creates a sleep.started event with correct payload', () => {
		const result = buildStartSleep(1, [], 6, null);

		expect(result.events).toHaveLength(1);
		expect(result.events[0].type).toBe('sleep.started');
		expect(result.events[0].payload.babyId).toBe(1);
		expect(result.events[0].payload.startTime).toBe('2026-03-27T14:00:00.000Z');
		expect(result.events[0].payload.sleepDomainId).toMatch(/^slp_/);
		expect(result.sleepDomainId).toBe(result.events[0].payload.sleepDomainId);
		expect(result.startTime).toBe('2026-03-27T14:00:00.000Z');
	});

	it('classifies daytime sleep as nap', () => {
		const result = buildStartSleep(1, [], 6, null);
		expect(result.events[0].payload.type).toBe('nap');
	});

	it('classifies late-night sleep as night', () => {
		vi.setSystemTime(new Date('2026-03-27T22:00:00.000Z'));
		const result = buildStartSleep(1, [], 6, null);
		expect(result.events[0].payload.type).toBe('night');
	});

	it('classifies early-morning sleep as night', () => {
		vi.setSystemTime(new Date('2026-03-27T03:00:00.000Z'));
		const result = buildStartSleep(1, [], 6, null);
		expect(result.events[0].payload.type).toBe('night');
	});

	it('generates unique domain IDs per call', () => {
		const r1 = buildStartSleep(1, [], 6, null);
		const r2 = buildStartSleep(1, [], 6, null);
		expect(r1.sleepDomainId).not.toBe(r2.sleepDomainId);
	});
});

describe('buildEndSleep', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-27T15:00:00.000Z'));
	});
	afterEach(() => vi.useRealTimers());

	it('creates a sleep.ended event', () => {
		const sleep = makeSleep();
		const result = buildEndSleep(sleep, 1);

		expect(result.events[0].type).toBe('sleep.ended');
		expect(result.events[0].payload.sleepDomainId).toBe('slp_test1');
		expect(result.events[0].payload.endTime).toBe('2026-03-27T15:00:00.000Z');
		expect(result.endTime).toBe('2026-03-27T15:00:00.000Z');
	});

	it('returns a snapshot of the sleep', () => {
		const sleep = makeSleep({ mood: 'normal' });
		const result = buildEndSleep(sleep, 1);
		expect(result.sleepSnapshot).toEqual(sleep);
		// Should be a copy, not the same reference
		expect(result.sleepSnapshot).not.toBe(sleep);
	});

	it('adds day.started event for night sleep (B18)', () => {
		const sleep = makeSleep({ type: 'night' });
		const result = buildEndSleep(sleep, 1);

		expect(result.events).toHaveLength(2);
		expect(result.events[1].type).toBe('day.started');
		expect(result.events[1].payload.babyId).toBe(1);
		expect(result.events[1].payload.wakeTime).toBe('2026-03-27T15:00:00.000Z');
	});

	it('does not add day.started for nap', () => {
		const sleep = makeSleep({ type: 'nap' });
		const result = buildEndSleep(sleep, 1);
		expect(result.events).toHaveLength(1);
	});
});

describe('buildPause', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-27T10:30:00.000Z'));
	});
	afterEach(() => vi.useRealTimers());

	it('creates a sleep.paused event', () => {
		const event = buildPause('slp_test1');
		expect(event.type).toBe('sleep.paused');
		expect(event.payload.sleepDomainId).toBe('slp_test1');
		expect(event.payload.pauseTime).toBe('2026-03-27T10:30:00.000Z');
	});
});

describe('buildResume', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-27T10:45:00.000Z'));
	});
	afterEach(() => vi.useRealTimers());

	it('creates a sleep.resumed event', () => {
		const event = buildResume('slp_test1');
		expect(event.type).toBe('sleep.resumed');
		expect(event.payload.sleepDomainId).toBe('slp_test1');
		expect(event.payload.resumeTime).toBe('2026-03-27T10:45:00.000Z');
	});
});

describe('isPaused', () => {
	it('returns false for undefined pauses', () => {
		expect(isPaused(undefined)).toBe(false);
	});

	it('returns false for empty pauses', () => {
		expect(isPaused([])).toBe(false);
	});

	it('returns false when last pause is resumed', () => {
		const pauses: SleepPauseRow[] = [
			{
				id: 1,
				sleep_id: 1,
				pause_time: '2026-03-27T10:30:00.000Z',
				resume_time: '2026-03-27T10:45:00.000Z',
				created_by_event_id: null,
			},
		];
		expect(isPaused(pauses)).toBe(false);
	});

	it('returns true when last pause has no resume_time', () => {
		const pauses: SleepPauseRow[] = [
			{
				id: 1,
				sleep_id: 1,
				pause_time: '2026-03-27T10:30:00.000Z',
				resume_time: null,
				created_by_event_id: null,
			},
		];
		expect(isPaused(pauses)).toBe(true);
	});

	it('returns true when most recent of multiple pauses is open', () => {
		const pauses: SleepPauseRow[] = [
			{
				id: 1,
				sleep_id: 1,
				pause_time: '2026-03-27T10:30:00.000Z',
				resume_time: '2026-03-27T10:35:00.000Z',
				created_by_event_id: null,
			},
			{
				id: 2,
				sleep_id: 1,
				pause_time: '2026-03-27T10:45:00.000Z',
				resume_time: null,
				created_by_event_id: null,
			},
		];
		expect(isPaused(pauses)).toBe(true);
	});

	it('returns false when all pauses are resumed', () => {
		const pauses: SleepPauseRow[] = [
			{
				id: 1,
				sleep_id: 1,
				pause_time: '2026-03-27T10:30:00.000Z',
				resume_time: '2026-03-27T10:35:00.000Z',
				created_by_event_id: null,
			},
			{
				id: 2,
				sleep_id: 1,
				pause_time: '2026-03-27T10:45:00.000Z',
				resume_time: '2026-03-27T10:50:00.000Z',
				created_by_event_id: null,
			},
		];
		expect(isPaused(pauses)).toBe(false);
	});
});
