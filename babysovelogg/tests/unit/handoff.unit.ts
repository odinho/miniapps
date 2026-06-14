import { describe, expect, it } from "bun:test";
import { handoffSegments, handoffWakings, HANDOFF_WINDOW_MS } from "$lib/handoff.js";
import type { SleepLogRow, NightWakingRow } from "$lib/types.js";

const NOW = new Date("2026-06-14T15:00:00.000Z").getTime();
const at = (h: number, m = 0) => new Date(`2026-06-14T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`).toISOString();

let sid = 0;
const sleep = (start: string, end: string | null, type = "nap", over: Partial<SleepLogRow> = {}): SleepLogRow =>
  ({ id: ++sid, baby_id: 1, domain_id: `slp_${sid}`, start_time: start, end_time: end, type, deleted: 0, ...over }) as SleepLogRow;

const waking = (start: string, end: string | null, over: Partial<NightWakingRow> = {}): NightWakingRow =>
  ({ id: ++sid, baby_id: 1, domain_id: `nw_${sid}`, start_time: start, end_time: end, deleted: 0, ...over }) as NightWakingRow;

describe("handoffSegments", () => {
  it("returns blocks intersecting the 6h window, sorted by start", () => {
    const segs = handoffSegments(
      { todaySleeps: [sleep(at(13, 10), at(14, 25)), sleep(at(10), at(11))] },
      NOW,
    );
    expect(segs.map((s) => [s.startMs, s.endMs])).toEqual([
      [new Date(at(10)).getTime(), new Date(at(11)).getTime()],
      [new Date(at(13, 10)).getTime(), new Date(at(14, 25)).getTime()],
    ]);
  });

  it("clips a block that started before the window to the window start", () => {
    const segs = handoffSegments({ priorOvernightSleep: sleep(at(7), at(14), "night") }, NOW);
    expect(segs).toHaveLength(1);
    expect(segs[0].startMs).toBe(NOW - HANDOFF_WINDOW_MS); // 09:00, not 07:00
    expect(segs[0].endMs).toBe(new Date(at(14)).getTime());
  });

  it("treats an open session as ongoing, ending at now", () => {
    const active = sleep(at(14, 30), null, "nap");
    const segs = handoffSegments({ todaySleeps: [active], activeSleep: active }, NOW);
    expect(segs).toHaveLength(1); // deduped by domain_id
    expect(segs[0]).toEqual({ startMs: new Date(at(14, 30)).getTime(), endMs: NOW, type: "nap", ongoing: true });
  });

  it("keeps a split overnight (straddling fragment + post-midnight fragment) as distinct blocks", () => {
    // Mirrors state.ts: priorOvernightSleep is the midnight-straddling fragment;
    // a later fragment lives in todaySleeps. Distinct domain_ids → not deduped.
    const segs = handoffSegments(
      {
        priorOvernightSleep: sleep(at(11), at(12, 30), "night"),
        todaySleeps: [sleep(at(13), at(14), "night")],
      },
      NOW,
    );
    expect(segs.map((s) => [s.startMs, s.endMs])).toEqual([
      [new Date(at(11)).getTime(), new Date(at(12, 30)).getTime()],
      [new Date(at(13)).getTime(), new Date(at(14)).getTime()],
    ]);
  });

  it("drops blocks entirely before the window and deleted rows", () => {
    expect(handoffSegments({ todaySleeps: [sleep(at(2), at(3))] }, NOW)).toEqual([]);
    expect(handoffSegments({ todaySleeps: [sleep(at(13), at(14), "nap", { deleted: 1 })] }, NOW)).toEqual([]);
  });
});

describe("handoffWakings", () => {
  it("returns wakings in the window, clipped, ongoing kept", () => {
    const ws = handoffWakings(
      { todayNightWakings: [waking(at(13), at(13, 20)), waking(at(2), at(2, 10)), waking(at(14, 50), null)] },
      NOW,
    );
    expect(ws).toEqual([
      { startMs: new Date(at(13)).getTime(), endMs: new Date(at(13, 20)).getTime() },
      { startMs: new Date(at(14, 50)).getTime(), endMs: null },
    ]);
  });
});
