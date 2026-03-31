import { describe, expect, it } from "bun:test";
import {
	getNextDstTransition,
	getRecentDstTransition,
	getNearbyDstTransition,
	getDstAdjustedTime,
	formatDstDate,
} from "$lib/dst-utils.js";

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
