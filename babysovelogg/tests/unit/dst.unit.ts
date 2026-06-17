import { describe, expect, it } from "bun:test";
import {
	getNextDstTransition,
	getRecentDstTransition,
	getNearbyDstTransition,
	getDstAdjustedTime,
	formatDstDate,
} from "$lib/dst-utils.js";
import { assembleState, type DayData } from "$lib/engine/state.js";
import type { Baby, SleepLogRow, DayStartRow } from "$lib/types.js";
import { expectTimeNear } from "../helpers/time.js";

// --- getNextDstTransition ---

describe("getNextDstTransition", () => {
	it("finds spring-forward for Europe/Oslo (CET→CEST, last Sunday of March)", () => {
		// 2026-03-20 is a week before the transition on 2026-03-29
		const now = new Date("2026-03-20T12:00:00Z");
		const result = getNextDstTransition("Europe/Oslo", now, 30);
		expect(result).not.toBeNull();
		expect(result!.direction).toBe("spring-forward");
		expect(result!.offsetChangeMinutes).toBe(60);
		// Transition day should be 2026-03-29
		const dateStr = result!.date.toISOString().slice(0, 10);
		expect(dateStr).toBe("2026-03-29");
	});

	it("finds fall-back for Europe/Oslo (CEST→CET, last Sunday of October)", () => {
		// 2026-10-20 is before the transition on 2026-10-25
		const now = new Date("2026-10-20T12:00:00Z");
		const result = getNextDstTransition("Europe/Oslo", now, 30);
		expect(result).not.toBeNull();
		expect(result!.direction).toBe("fall-back");
		expect(result!.offsetChangeMinutes).toBe(60);
		const dateStr = result!.date.toISOString().slice(0, 10);
		expect(dateStr).toBe("2026-10-25");
	});

	it("returns null for UTC (no DST)", () => {
		const now = new Date("2026-03-20T12:00:00Z");
		const result = getNextDstTransition("UTC", now, 365);
		expect(result).toBeNull();
	});

	it("returns null when no transition within range", () => {
		// In summer, next transition is in October — 7 days isn't enough
		const now = new Date("2026-07-01T12:00:00Z");
		const result = getNextDstTransition("Europe/Oslo", now, 7);
		expect(result).toBeNull();
	});

	it("works for US Eastern (America/New_York)", () => {
		// 2026 US spring forward: March 8
		const now = new Date("2026-03-01T12:00:00Z");
		const result = getNextDstTransition("America/New_York", now, 30);
		expect(result).not.toBeNull();
		expect(result!.direction).toBe("spring-forward");
		expect(result!.offsetChangeMinutes).toBe(60);
	});
});

// --- getRecentDstTransition ---

describe("getRecentDstTransition", () => {
	it("detects transition that just happened (day of)", () => {
		// 2026-03-29 afternoon — spring forward happened this day
		const now = new Date("2026-03-29T14:00:00Z");
		const result = getRecentDstTransition("Europe/Oslo", now, 3);
		expect(result).not.toBeNull();
		expect(result!.direction).toBe("spring-forward");
	});

	it("detects transition from 1 day ago", () => {
		// 2026-03-30 — transition was yesterday (March 29)
		const now = new Date("2026-03-30T12:00:00Z");
		const result = getRecentDstTransition("Europe/Oslo", now, 3);
		expect(result).not.toBeNull();
		expect(result!.direction).toBe("spring-forward");
	});

	it("returns null when no recent transition", () => {
		const now = new Date("2026-06-15T12:00:00Z");
		const result = getRecentDstTransition("Europe/Oslo", now, 3);
		expect(result).toBeNull();
	});

	it("returns null for UTC", () => {
		const now = new Date("2026-03-29T14:00:00Z");
		const result = getRecentDstTransition("UTC", now, 3);
		expect(result).toBeNull();
	});
});

// --- getNearbyDstTransition ---

describe("getNearbyDstTransition", () => {
	it("returns upcoming transition when within range", () => {
		// 2 days before spring forward
		const now = new Date("2026-03-27T12:00:00Z");
		const result = getNearbyDstTransition("Europe/Oslo", now, 3);
		expect(result).not.toBeNull();
		expect(result!.direction).toBe("spring-forward");
	});

	it("returns recent transition when within range", () => {
		// 1 day after spring forward
		const now = new Date("2026-03-30T12:00:00Z");
		const result = getNearbyDstTransition("Europe/Oslo", now, 3);
		expect(result).not.toBeNull();
		expect(result!.direction).toBe("spring-forward");
	});

	it("returns null when no transition nearby", () => {
		const now = new Date("2026-06-15T12:00:00Z");
		const result = getNearbyDstTransition("Europe/Oslo", now, 3);
		expect(result).toBeNull();
	});
});

// --- getDstAdjustedTime ---

describe("getDstAdjustedTime", () => {
	it("adjusts forward for spring-forward (18:20 → 19:20)", () => {
		// Day after spring forward in Oslo
		const now = new Date("2026-03-30T12:00:00Z");
		const result = getDstAdjustedTime("18:20", "Europe/Oslo", now);
		expect(result).toBe("19:20");
	});

	it("adjusts backward for fall-back (18:20 → 17:20)", () => {
		// Day after fall back in Oslo (Oct 25, 2026)
		const now = new Date("2026-10-26T12:00:00Z");
		const result = getDstAdjustedTime("18:20", "Europe/Oslo", now);
		expect(result).toBe("17:20");
	});

	it("returns null when no recent transition", () => {
		const now = new Date("2026-06-15T12:00:00Z");
		const result = getDstAdjustedTime("18:20", "Europe/Oslo", now);
		expect(result).toBeNull();
	});

	it("clamps to 23:59 if adjusted time would exceed midnight", () => {
		// Spring forward, 23:30 + 60min = 24:30 → clamped to 23:59
		const now = new Date("2026-03-30T12:00:00Z");
		const result = getDstAdjustedTime("23:30", "Europe/Oslo", now);
		expect(result).toBe("23:59");
	});

	it("clamps to 00:00 if adjusted time would go below midnight", () => {
		// Fall back, 00:20 - 60min = -40min → clamped to 00:00
		const now = new Date("2026-10-26T12:00:00Z");
		const result = getDstAdjustedTime("00:20", "Europe/Oslo", now);
		expect(result).toBe("00:00");
	});
});

// --- formatDstDate ---

describe("formatDstDate", () => {
	it("formats date in Nynorsk style", () => {
		const date = new Date("2026-03-29T00:00:00");
		expect(formatDstDate(date)).toBe("sundag 29. mars");
	});
});

// --- DST transition through assembleState ---
//
// dst-utils above is helper-level. This block runs the FULL assembly path on
// the two Oslo transition days so predictions stay anchored to the baby's
// LOCAL clock, not the UTC offset that shifts under them. Tolerant invariants
// pin current behavior; an exact-time pin would just track engine drift.

const Z = "Europe/Oslo";

const dstBaby: Baby = {
	id: 1, name: "Testa", birthdate: "2025-06-12", created_at: "2026-01-01T00:00:00.000Z",
	custom_nap_count: null, potty_mode: 0, track_diaper: 0, timezone: Z,
	target_bedtime: null, created_by_event_id: null, updated_by_event_id: null,
};

function dstSleepRow(o: Partial<SleepLogRow>): SleepLogRow {
	return {
		id: 1, baby_id: 1, start_time: "", end_time: "", type: "nap", notes: null, mood: null,
		method: null, fall_asleep_time: null, onset_note: null, woke_by: null, wake_notes: null,
		wake_mood: null, deleted: 0, domain_id: "x", created_by_event_id: null, updated_by_event_id: null,
		...o,
	} as SleepLogRow;
}

/** 14 days of a stable 2-nap Oslo routine ending the day before `dayEnd`. */
function dstRecent(month: string, dayStart: number, dayEnd: number): SleepLogRow[] {
	const s: SleepLogRow[] = [];
	for (let d = dayStart; d <= dayEnd; d++) {
		const ds = `2026-${month}-${String(d).padStart(2, "0")}`;
		s.push(dstSleepRow({ id: d * 10 + 1, start_time: `${ds}T08:00:00Z`, end_time: `${ds}T09:30:00Z`, type: "nap", woke_by: "self", domain_id: `a${d}` }));
		s.push(dstSleepRow({ id: d * 10 + 2, start_time: `${ds}T12:00:00Z`, end_time: `${ds}T13:30:00Z`, type: "nap", woke_by: "self", domain_id: `b${d}` }));
		s.push(dstSleepRow({ id: d * 10 + 3, start_time: `${ds}T18:00:00Z`, end_time: `${ds}T23:59:00Z`, type: "night", woke_by: "self", domain_id: `c${d}` }));
	}
	return s;
}

const osloHHMM = (iso: string) =>
	new Date(iso).toLocaleTimeString("en-GB", { timeZone: Z, hour: "2-digit", minute: "2-digit" });

describe("assembleState across an Oslo DST transition", () => {
	it("spring-forward 2026-03-29: predictions stay on the local clock", () => {
		// Wake 06:30 Oslo = 04:30Z (CEST, after the 02:00→03:00 jump).
		const wake: DayStartRow = {
			id: 1, baby_id: 1, date: "2026-03-29", wake_time: "2026-03-29T04:30:00.000Z",
			created_at: "2026-03-29T04:30:00.000Z", created_by_event_id: null,
		};
		const data: DayData = {
			baby: dstBaby, activeSleep: undefined, todaySleeps: [],
			recentSleeps: dstRecent("03", 15, 28), todayWakeUp: wake,
			diaperCount: 0, lastDiaperTime: null,
			now: new Date("2026-03-29T05:00:00.000Z").getTime(),
		};

		const p = assembleState(data).prediction!;

		expect(p.strategy).toBe("routine_schedule");
		expect(osloHHMM(p.nextNap!)).toBe("09:00"); // ~2.5h WW after 06:30 local
		expect(osloHHMM(p.bedtime!)).toBe("19:00");
	});

	it("fall-back 2026-10-25: predictions stay on the local clock", () => {
		// Wake 06:30 Oslo = 05:30Z (CET, after the 03:00→02:00 repeat).
		const wake: DayStartRow = {
			id: 1, baby_id: 1, date: "2026-10-25", wake_time: "2026-10-25T05:30:00.000Z",
			created_at: "2026-10-25T05:30:00.000Z", created_by_event_id: null,
		};
		const data: DayData = {
			baby: dstBaby, activeSleep: undefined, todaySleeps: [],
			recentSleeps: dstRecent("10", 11, 24), todayWakeUp: wake,
			diaperCount: 0, lastDiaperTime: null,
			now: new Date("2026-10-25T06:00:00.000Z").getTime(),
		};

		const p = assembleState(data).prediction!;

		expect(p.strategy).toBe("routine_schedule");
		// First nap lands mid-morning local; bedtime in the evening local window.
		expectTimeNear(p.nextNap!, "2026-10-25T08:39:00.000Z", 30);
		expectTimeNear(p.bedtime!, "2026-10-25T18:51:00.000Z", 30);
	});
});
