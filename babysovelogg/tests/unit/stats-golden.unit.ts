import { describe, it, expect } from "bun:test";
import { computeAllStats } from "$lib/stats-view-utils.js";
import type { SleepEntry, DiaperLogRow } from "$lib/types.js";

// GOLDEN characterization snapshot. Pins the exact chart geometry computeAllStats
// produces for a fixed single-baby fixture + pinned `now`, so the Phase-3
// charting refactor (extract scales/paths, chart components, page migration)
// can prove it keeps single-baby output byte-identical. If a change here is
// intentional, it must be a deliberate `--update-snapshots` with review — never
// a silent drift.

const NOW = new Date("2026-03-26T12:00:00.000Z").getTime();

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: number) => `2026-03-${pad(d)}`;
const at = (d: number, h: number, m = 0) => `${day(d)}T${pad(h)}:${pad(m)}:00.000Z`;

// 10 complete days (16th–25th) before "today" (26th): each an overnight that
// crosses midnight plus two naps. Deterministic — no wall-clock.
function fixtureSleeps(): SleepEntry[] {
  const out: SleepEntry[] = [];
  for (let d = 16; d <= 25; d++) {
    out.push({ start_time: at(d - 1, 19, 30), end_time: at(d, 7, 0), type: "night" });
    out.push({ start_time: at(d, 9, 30), end_time: at(d, 11, 0), type: "nap" });
    out.push({ start_time: at(d, 13, 30), end_time: at(d, 14, 30), type: "nap" });
  }
  return out;
}

function fixtureDiapers(): DiaperLogRow[] {
  const mk = (time: string, type: string): DiaperLogRow => ({
    id: 1, baby_id: 1, time, type, amount: null, note: null, deleted: 0,
    domain_id: "d", created_by_event_id: null, updated_by_event_id: null,
  });
  return [
    mk(at(24, 8, 0), "wet"),
    mk(at(24, 12, 0), "dirty"),
    mk(at(25, 9, 0), "both"),
    mk(at(25, 15, 0), "potty_wet"),
  ];
}

describe("computeAllStats — golden single-baby chart geometry", () => {
  const s = computeAllStats(fixtureSleeps(), fixtureDiapers(), "UTC", "2025-09-26", NOW);

  it("is deterministic for a pinned now (re-run matches)", () => {
    const again = computeAllStats(fixtureSleeps(), fixtureDiapers(), "UTC", "2025-09-26", NOW);
    expect(again).toEqual(s);
  });

  it("pins the chart geometry", () => {
    expect({
      stackedArea: s.stackedArea,
      sleepVsNorm: s.sleepVsNorm,
      nightStretchChart: s.nightStretchChart,
      bedtimeChart: s.bedtimeChart,
      napCountChart: s.napCountChart,
      gantt: s.gantt,
      heatmapChart: s.heatmapChart,
      wakeScatter: s.wakeScatter,
    }).toMatchSnapshot();
  });

  it("pins the summary tables + diaper stats", () => {
    expect({
      trendRows: s.trendRows,
      bestWorst: s.bestWorst,
      wakeAvg: s.wakeAvg,
      diaperStats7: s.diaperStats7,
      diaperStats30: s.diaperStats30,
    }).toMatchSnapshot();
  });
});
