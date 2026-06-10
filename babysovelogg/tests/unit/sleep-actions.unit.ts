import { describe, it, expect, setSystemTime, beforeEach, afterEach, afterAll } from 'bun:test';

afterAll(() => setSystemTime());
import {
	buildStartSleep,
	buildEndSleep,
} from '$lib/sleep-actions.js';
import type { SleepLogRow } from '$lib/types.js';

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
		onset_note: null,
		woke_by: null,
		wake_notes: null,
		wake_mood: null,
		deleted: 0,
		domain_id: 'slp_test1',
		created_by_event_id: null,
		updated_by_event_id: null,
		...overrides,
	};
}

describe('buildStartSleep', () => {
	beforeEach(() => {
		setSystemTime(new Date('2026-03-27T14:00:00.000Z'));
	});
	afterEach(() => setSystemTime());

	it('creates a sleep.started event with correct payload', () => {
		const result = buildStartSleep(1, [], 6, null);

		expect(result.events).toHaveLength(1);
		expect(result.events[0].type).toBe('sleep.started');
		expect(result.events[0].payload.babyId).toBe(1);
		expect(result.events[0].payload.startTime).toBe('2026-03-27T14:00:00.000Z');
		expect(result.events[0].payload.sleepDomainId).toMatch(/^slp_/);
		expect(result.sleepDomainId).toBe(result.events[0].payload.sleepDomainId as string);
		expect(result.startTime).toBe('2026-03-27T14:00:00.000Z');
	});

	it('classifies daytime sleep as nap', () => {
		const result = buildStartSleep(1, [], 6, null);
		expect(result.events[0].payload.type).toBe('nap');
	});

	it('classifies late-night sleep as night', () => {
		setSystemTime(new Date('2026-03-27T22:00:00.000Z'));
		const result = buildStartSleep(1, [], 6, null);
		expect(result.events[0].payload.type).toBe('night');
	});

	it('classifies early-morning sleep as night', () => {
		setSystemTime(new Date('2026-03-27T03:00:00.000Z'));
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
		setSystemTime(new Date('2026-03-27T15:00:00.000Z'));
	});
	afterEach(() => setSystemTime());

	it('creates a sleep.ended event', () => {
		const sleep = makeSleep();
		const result = buildEndSleep(sleep);

		expect(result.events[0].type).toBe('sleep.ended');
		expect(result.events[0].payload.sleepDomainId).toBe('slp_test1');
		expect(result.events[0].payload.endTime).toBe('2026-03-27T15:00:00.000Z');
		expect(result.endTime).toBe('2026-03-27T15:00:00.000Z');
	});

	it('returns a snapshot of the sleep with end_time stamped', () => {
		const sleep = makeSleep({ mood: 'normal' });
		const result = buildEndSleep(sleep);
		// Snapshot reflects post-end state — end_time is set to the just-emitted timestamp
		expect(result.sleepSnapshot).toEqual({ ...sleep, end_time: result.endTime });
		// Should be a copy, not the same reference
		expect(result.sleepSnapshot).not.toBe(sleep);
	});

	it('only emits sleep.ended for night sleep (no day.started)', () => {
		const sleep = makeSleep({ type: 'night' });
		const result = buildEndSleep(sleep);
		expect(result.events).toHaveLength(1);
		expect(result.events[0].type).toBe('sleep.ended');
	});

	it('does not tag woke_by by default', () => {
		const result = buildEndSleep(makeSleep());
		expect(result.events).toHaveLength(1);
		expect(result.sleepSnapshot.woke_by).toBeNull();
	});

	it('tags woke_by="woken" on a cap-respect wake so continuation is suppressed', () => {
		const sleep = makeSleep({ type: 'nap' });
		const result = buildEndSleep(sleep, true);
		expect(result.events[0].type).toBe('sleep.ended');
		expect(result.events[1]).toEqual({
			type: 'sleep.updated',
			payload: { sleepDomainId: 'slp_test1', wokeBy: 'woken' },
		});
		expect(result.sleepSnapshot.woke_by).toBe('woken');
	});
});

// buildPause / buildResume / isPaused removed with the pause UX redesign —
// night wakings now use night_waking.{started,ended} events; nap pause no
// longer exists. See docs/pause-redesign-2026-05-22.md.
