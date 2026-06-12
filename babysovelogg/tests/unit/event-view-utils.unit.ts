import { describe, it, expect } from 'bun:test';
import {
	TYPE_COLORS,
	EVENT_TYPES,
	PAGE_SIZE,
	formatPayloadValue,
	buildPayloadPreview,
	formatEventTimestamp,
	getTypeColor,
	buildEventsQuery,
} from '../../src/lib/event-view-utils.js';

describe('view constants', () => {
	it('renders the full event-type colour map plus derived constants', () => {
		expect(
			[
				'TYPE_COLORS:',
				...Object.entries(TYPE_COLORS).map(([type, color]) => `  ${type} → ${color}`),
				`EVENT_TYPES = [${EVENT_TYPES.join(', ')}]`,
				`PAGE_SIZE = ${PAGE_SIZE}`,
			].join('\n'),
		).toMatchInlineSnapshot(`
		  "TYPE_COLORS:
		    baby.created → #9c27b0
		    baby.updated → #ab47bc
		    sleep.started → #1565c0
		    sleep.ended → #1976d2
		    sleep.updated → #1e88e5
		    sleep.manual → #2196f3
		    sleep.deleted → #64b5f6
		    sleep.tagged → #42a5f5
		    sleep.paused → #90caf9
		    sleep.resumed → #bbdefb
		    diaper.logged → #2e7d32
		    diaper.updated → #43a047
		    diaper.deleted → #66bb6a
		    day.started → #ef6c00
		  EVENT_TYPES = [baby.created, baby.updated, sleep.started, sleep.ended, sleep.updated, sleep.manual, sleep.deleted, sleep.tagged, sleep.paused, sleep.resumed, diaper.logged, diaper.updated, diaper.deleted, day.started]
		  PAGE_SIZE = 30"
		`);

		// EVENT_TYPES must stay derived from TYPE_COLORS, never hand-maintained.
		expect(EVENT_TYPES).toEqual(Object.keys(TYPE_COLORS));
	});
});

describe('formatPayloadValue', () => {
	it('returns null for DomainId keys', () => {
		expect(formatPayloadValue('sleepDomainId', 'abc-123')).toBeNull();
		expect(formatPayloadValue('diaperDomainId', 'xyz')).toBeNull();
	});

	it('returns null for clientId key', () => {
		expect(formatPayloadValue('clientId', 'client-1')).toBeNull();
	});

	it('returns null for domainId key', () => {
		expect(formatPayloadValue('domainId', 'dom-1')).toBeNull();
	});

	it('shortens ISO date strings to HH:MM', () => {
		expect(formatPayloadValue('startTime', '2026-03-27T14:23:00.000Z')).toBe('14:23');
	});

	it('truncates strings longer than 30 chars', () => {
		const long = 'a'.repeat(40);
		const result = formatPayloadValue('notes', long);
		expect(result).toBe('a'.repeat(30) + '\u2026');
	});

	it('returns short strings as-is', () => {
		expect(formatPayloadValue('mood', 'normal')).toBe('normal');
	});

	it('returns null for null and undefined', () => {
		expect(formatPayloadValue('notes', null)).toBeNull();
		expect(formatPayloadValue('notes', undefined)).toBeNull();
	});

	it('stringifies numbers', () => {
		expect(formatPayloadValue('babyId', 42)).toBe('42');
	});

	it('stringifies booleans', () => {
		expect(formatPayloadValue('pottyMode', true)).toBe('true');
	});
});

describe('buildPayloadPreview', () => {
	it('builds comma-separated key:value pairs', () => {
		const result = buildPayloadPreview({
			name: 'Halldis',
			birthdate: '2025-06-15',
		});
		expect(result).toBe('name: Halldis, birthdate: 2025-06-15');
	});

	it('skips hidden keys', () => {
		const result = buildPayloadPreview({
			sleepDomainId: 'abc',
			mood: 'normal',
			clientId: 'c1',
		});
		expect(result).toBe('mood: normal');
	});

	it('shortens ISO dates in preview', () => {
		const result = buildPayloadPreview({
			startTime: '2026-03-27T14:00:00.000Z',
		});
		expect(result).toBe('startTime: 14:00');
	});

	it('returns empty string for empty payload', () => {
		expect(buildPayloadPreview({})).toBe('');
	});

	it('returns empty string if all keys hidden', () => {
		expect(buildPayloadPreview({ sleepDomainId: 'a', clientId: 'b' })).toBe('');
	});
});

describe('formatEventTimestamp', () => {
	it('formats as "DD. mon HH:MM"', () => {
		// Use a UTC timestamp — but formatEventTimestamp uses local time via `new Date`
		// So we construct a date in a controlled way
		const d = new Date(2026, 2, 27, 14, 5); // March 27, 2026 14:05 local
		const result = formatEventTimestamp(d.toISOString());
		expect(result).toBe('27. mar 14:05');
	});

	it('pads hours and minutes', () => {
		const d = new Date(2026, 0, 3, 8, 3); // Jan 3, 2026 08:03 local
		const result = formatEventTimestamp(d.toISOString());
		expect(result).toBe('3. jan 08:03');
	});
});

describe('getTypeColor', () => {
	it('returns the matching colour for known types', () => {
		expect(getTypeColor('baby.created')).toBe('#9c27b0');
		expect(getTypeColor('sleep.started')).toBe('#1565c0');
	});

	it('returns grey for unknown types', () => {
		expect(getTypeColor('unknown.event')).toBe('#757575');
	});
});

describe('buildEventsQuery', () => {
	it('includes limit by default', () => {
		const qs = buildEventsQuery({});
		expect(qs).toContain('limit=30');
	});

	it('includes type filter when set', () => {
		const qs = buildEventsQuery({ typeFilter: 'sleep.started' });
		expect(qs).toContain('type=sleep.started');
	});

	it('includes domainId when set', () => {
		const qs = buildEventsQuery({ domainId: 'abc-123' });
		expect(qs).toContain('domainId=abc-123');
	});

	it('includes offset when non-zero', () => {
		const qs = buildEventsQuery({ offset: 30 });
		expect(qs).toContain('offset=30');
	});

	it('excludes offset when zero or undefined', () => {
		const qs = buildEventsQuery({ offset: 0 });
		expect(qs).not.toContain('offset');
		const qs2 = buildEventsQuery({});
		expect(qs2).not.toContain('offset');
	});

	it('excludes type when null', () => {
		const qs = buildEventsQuery({ typeFilter: null });
		expect(qs).not.toContain('type=');
	});

	it('supports custom limit', () => {
		const qs = buildEventsQuery({ limit: 50 });
		expect(qs).toContain('limit=50');
	});
});
