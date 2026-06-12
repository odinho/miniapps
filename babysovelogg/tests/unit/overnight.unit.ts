import { test, expect } from "bun:test";
import { collectOvernightFragments } from "../../src/lib/overnight.js";
import type { SleepLogRow } from "../../src/lib/types.js";

let id = 0;
function sleep(type: string, start: string, end: string | null): SleepLogRow {
  return { id: ++id, type, start_time: start, end_time: end } as SleepLogRow;
}
const ranges = (rows: SleepLogRow[]) => rows.map((r) => `${r.start_time}–${r.end_time}`);

test("single continuous overnight (straddler, day starts with a nap)", () => {
  const straddler = sleep("night", "2026-05-19T23:00:00.000Z", "2026-05-20T07:00:00.000Z");
  const today = [sleep("nap", "2026-05-20T09:00:00.000Z", "2026-05-20T10:00:00.000Z")];
  expect(ranges(collectOvernightFragments(straddler, today))).toEqual([
    "2026-05-19T23:00:00.000Z–2026-05-20T07:00:00.000Z",
  ]);
});

test("fragmented night: straddler + post-midnight pieces, stops at first nap", () => {
  const straddler = sleep("night", "2026-05-19T23:00:00.000Z", "2026-05-20T00:25:00.000Z");
  // Intentionally shuffled to prove order-independence.
  const today = [
    sleep("nap", "2026-05-20T07:41:00.000Z", "2026-05-20T09:25:00.000Z"),
    sleep("night", "2026-05-20T05:05:00.000Z", "2026-05-20T07:29:00.000Z"),
    sleep("night", "2026-05-20T00:56:00.000Z", "2026-05-20T04:29:00.000Z"),
  ];
  const frags = collectOvernightFragments(straddler, today);
  expect(ranges(frags)).toEqual([
    "2026-05-19T23:00:00.000Z–2026-05-20T00:25:00.000Z",
    "2026-05-20T00:56:00.000Z–2026-05-20T04:29:00.000Z",
    "2026-05-20T05:05:00.000Z–2026-05-20T07:29:00.000Z",
  ]);
  expect(frags.at(-1)!.end_time).toBe("2026-05-20T07:29:00.000Z"); // morning wake
});

test("overnight entirely after midnight (no straddler)", () => {
  const today = [
    sleep("night", "2026-05-20T00:30:00.000Z", "2026-05-20T07:00:00.000Z"),
    sleep("nap", "2026-05-20T09:00:00.000Z", "2026-05-20T10:00:00.000Z"),
  ];
  expect(ranges(collectOvernightFragments(null, today))).toEqual([
    "2026-05-20T00:30:00.000Z–2026-05-20T07:00:00.000Z",
  ]);
});

test("evening night on a no-nap day is a separate block (long gap)", () => {
  const straddler = sleep("night", "2026-05-19T23:00:00.000Z", "2026-05-20T07:00:00.000Z");
  const today = [sleep("night", "2026-05-20T19:00:00.000Z", "2026-05-20T19:30:00.000Z")];
  expect(ranges(collectOvernightFragments(straddler, today))).toEqual([
    "2026-05-19T23:00:00.000Z–2026-05-20T07:00:00.000Z",
  ]);
});

test("active (open) trailing fragment closes the block", () => {
  const straddler = sleep("night", "2026-05-19T23:00:00.000Z", "2026-05-20T00:25:00.000Z");
  const today = [
    sleep("night", "2026-05-20T00:56:00.000Z", "2026-05-20T04:29:00.000Z"),
    sleep("night", "2026-05-20T05:05:00.000Z", null), // still asleep
  ];
  expect(ranges(collectOvernightFragments(straddler, today))).toEqual([
    "2026-05-19T23:00:00.000Z–2026-05-20T00:25:00.000Z",
    "2026-05-20T00:56:00.000Z–2026-05-20T04:29:00.000Z",
  ]);
});

test("no night logged returns empty", () => {
  const today = [sleep("nap", "2026-05-20T09:00:00.000Z", "2026-05-20T10:00:00.000Z")];
  expect(collectOvernightFragments(null, today)).toEqual([]);
});
