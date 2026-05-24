import { test, expect } from "bun:test";
import { isWithinEndUndoWindow, END_UNDO_WINDOW_MS } from "$lib/end-undo.js";

function nap(
  domainId: string,
  startMs: number,
  endMs: number | null,
): {
  domain_id: string;
  type: "nap" | "night";
  start_time: string;
  end_time: string | null;
} {
  return {
    domain_id: domainId,
    type: "nap",
    start_time: new Date(startMs).toISOString(),
    end_time: endMs == null ? null : new Date(endMs).toISOString(),
  };
}

const NOW = new Date("2026-05-22T12:00:00Z").getTime();

test("eligible: nap ended just now, no later sleep", () => {
  const snap = nap("a", NOW - 30 * 60_000, NOW - 60_000);
  expect(isWithinEndUndoWindow(snap, [snap], NOW)).toBe(true);
});

test("ineligible: night sleep, even if just ended", () => {
  const snap = { ...nap("a", NOW - 60 * 60_000, NOW - 60_000), type: "night" as const };
  expect(isWithinEndUndoWindow(snap, [snap], NOW)).toBe(false);
});

test("ineligible: nap with null end_time (still active)", () => {
  const snap = nap("a", NOW - 30 * 60_000, null);
  expect(isWithinEndUndoWindow(snap, [snap], NOW)).toBe(false);
});

test("ineligible: ended more than 15 min ago", () => {
  const snap = nap("a", NOW - 60 * 60_000, NOW - END_UNDO_WINDOW_MS - 1);
  expect(isWithinEndUndoWindow(snap, [snap], NOW)).toBe(false);
});

test("eligible: ended exactly 14 min 59 s ago", () => {
  const snap = nap("a", NOW - 60 * 60_000, NOW - (END_UNDO_WINDOW_MS - 1_000));
  expect(isWithinEndUndoWindow(snap, [snap], NOW)).toBe(true);
});

test("ineligible: a later sleep has been started", () => {
  const snap = nap("a", NOW - 60 * 60_000, NOW - 5 * 60_000);
  const later = nap("b", NOW - 2 * 60_000, null);
  expect(isWithinEndUndoWindow(snap, [snap, later], NOW)).toBe(false);
});

test("eligible: another sleep exists but starts BEFORE the ended nap", () => {
  const earlier = nap("earlier", NOW - 5 * 3600_000, NOW - 4 * 3600_000);
  const snap = nap("a", NOW - 60 * 60_000, NOW - 60_000);
  expect(isWithinEndUndoWindow(snap, [earlier, snap], NOW)).toBe(true);
});

test("ineligible: end_time in the future (clock skew)", () => {
  const snap = nap("a", NOW - 60 * 60_000, NOW + 30_000);
  expect(isWithinEndUndoWindow(snap, [snap], NOW)).toBe(false);
});
