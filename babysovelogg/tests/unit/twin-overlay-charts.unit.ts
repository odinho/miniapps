import { describe, it, expect } from "bun:test";
import { computeChildrenStats, type ChildRawData } from "$lib/stats/multi-child-stats.js";
import { buildTwinOverlayCharts, buildTwinTimeline } from "$lib/stats/twin-overlay-charts.js";
import type { SleepEntry } from "$lib/types.js";

const NOW = new Date("2026-03-26T12:00:00.000Z").getTime();

function startAt(date: string, hour: number): Date {
  return new Date(`${date}T${String(hour).padStart(2, "0")}:00:00.000Z`);
}

function sleep(date: string, hour: number, minutes: number, type: "nap" | "night"): SleepEntry {
  const start = startAt(date, hour);
  return {
    start_time: start.toISOString(),
    end_time: new Date(start.getTime() + minutes * 60000).toISOString(),
    type,
  };
}

function fixture(): ChildRawData[] {
  return [
    {
      baby: { id: 1, name: "Ada", timezone: "UTC", birthdate: "2025-09-26" },
      sleeps: [
        sleep("2026-03-20", 20, 600, "night"),
        sleep("2026-03-20", 12, 60, "nap"),
        sleep("2026-03-22", 20, 600, "night"),
        sleep("2026-03-22", 10, 60, "nap"),
        sleep("2026-03-22", 14, 60, "nap"),
        sleep("2026-03-23", 19, 720, "night"),
        sleep("2026-03-23", 12, 60, "nap"),
      ],
      diapers: [],
    },
    {
      baby: { id: 2, name: "Bo", timezone: "UTC", birthdate: "2025-09-26" },
      sleeps: [
        sleep("2026-03-21", 21, 480, "night"),
        sleep("2026-03-21", 12, 45, "nap"),
        sleep("2026-03-23", 20, 720, "night"),
        sleep("2026-03-23", 9, 45, "nap"),
        sleep("2026-03-23", 12, 45, "nap"),
        sleep("2026-03-23", 15, 45, "nap"),
        sleep("2026-03-24", 20, 540, "night"),
        sleep("2026-03-24", 12, 30, "nap"),
      ],
      diapers: [],
    },
  ];
}

describe("buildTwinOverlayCharts", () => {
  it("uses union-date x alignment and shared y domains without zero-filled gaps", () => {
    const charts = buildTwinOverlayCharts(computeChildrenStats(fixture(), NOW), { now: NOW });
    const trend = charts.sleepTrend!;
    const ada = trend.series[0];
    const bo = trend.series[1];

    expect(trend.dates).toEqual([
      "2026-03-20",
      "2026-03-21",
      "2026-03-22",
      "2026-03-23",
      "2026-03-24",
    ]);
    expect(trend.xLabels.map((label) => label.x)).toEqual(trend.dates.map((date) => trend.xByDate[date]));
    expect(trend.yTicks.map((tick) => tick.label)).toContain("14t");
    expect(trend.series.map((series) => [series.id, series.label, series.colorVar])).toEqual([
      ["1", "Ada", "--moon"],
      ["2", "Bo", "--peach-dark"],
    ]);

    expect(ada.points.find((point) => point.date === "2026-03-21")).toMatchObject({ value: null, y: null });
    expect(bo.points.find((point) => point.date === "2026-03-20")).toMatchObject({ value: null, y: null });
    expect(ada.points.find((point) => point.date === "2026-03-23")!.value).not.toBe(
      bo.points.find((point) => point.date === "2026-03-23")!.value,
    );
    expect(ada.points.find((point) => point.date === "2026-03-23")!.x).toBe(
      bo.points.find((point) => point.date === "2026-03-23")!.x,
    );
    expect(ada.points.find((point) => point.date === "2026-03-23")!.x).toBe(trend.xByDate["2026-03-23"]);

    expect(charts.sleepVsNorm!.bands).toHaveLength(1);
    expect(charts.sleepVsNorm!.series).toHaveLength(2);
    expect(charts.nightStretch!.series).toHaveLength(2);
    expect(charts.bedtime!.series).toHaveLength(2);
    expect(charts.napCount!.series).toHaveLength(2);
  });
});

const ganttRow = (date: string, blocks: { x: number; w: number; y: number; type: "nap" | "night" }[]) => ({
  date,
  dateLabel: date.slice(5),
  y: 24,
  blocks,
});
const childWithGantt = (babyId: number, name: string, rows: ReturnType<typeof ganttRow>[]) =>
  ({
    babyId,
    name,
    stats: { gantt: { rows, hourLabels: [{ x: 56, label: "00" }], height: 100 } },
  }) as unknown as import("$lib/stats/multi-child-stats.js").ChildStats;

describe("buildTwinTimeline", () => {
  it("stacks both children's blocks into per-child lanes on the shared date row", () => {
    const a = childWithGantt(1, "Ada", [ganttRow("2026-03-20", [{ x: 100, w: 20, y: 26, type: "night" }])]);
    const b = childWithGantt(2, "Bo", [ganttRow("2026-03-20", [{ x: 140, w: 10, y: 26, type: "nap" }])]);

    const out = buildTwinTimeline([a, b])!;
    expect(out.rows).toHaveLength(1);
    const blocks = out.rows[0].blocks;
    // One block per child, each in its own lane (different y), child-coloured.
    expect(blocks.map((bl) => [bl.x, bl.colorVar, bl.h])).toEqual([
      [100, "--moon", 6],
      [140, "--peach-dark", 6],
    ]);
    // Lanes are stacked, not overlapping.
    expect(blocks[0].y).toBeLessThan(blocks[1].y);
  });

  it("returns null when neither child has timeline rows", () => {
    expect(buildTwinTimeline([childWithGantt(1, "Ada", []), childWithGantt(2, "Bo", [])])).toBeNull();
  });
});
