import { describe, expect, it } from "bun:test";
import { calibrate } from "$lib/engine/calibration.js";
import { calculateAgeMonths } from "$lib/engine/schedule.js";
import type { DayRecord } from "$lib/engine/backtest.js";
import type { SleepEntry } from "$lib/types.js";

import halldisData from "../fixtures/halldis-sleep.json";

const BIRTHDATE = "2025-06-12";
const TZ = "Europe/Oslo";
const days = halldisData as DayRecord[];

function collectRecent(dayIndex: number, lookback = 7): SleepEntry[] {
  const sleeps: SleepEntry[] = [];
  for (let j = Math.max(0, dayIndex - lookback); j < dayIndex; j++) {
    sleeps.push(...days[j].sleeps.filter((s) => s.end_time));
  }
  return sleeps;
}

function renderCal(dayIndex: number): string {
  const day = days[dayIndex];
  const ageMonths = calculateAgeMonths(BIRTHDATE, new Date(day.date + "T12:00:00Z"));
  const recent = collectRecent(dayIndex);
  const cal = calibrate(ageMonths, recent, null, TZ);
  const sources = [
    `count=${cal.napCount.source}(${cal.napCount.sampleCount})`,
    `ww=${cal.wakeWindows.source}(${cal.wakeWindows.sampleCount})`,
    `bed=${cal.bedtimeWakeWindow.source}(${cal.bedtimeWakeWindow.sampleCount})`,
    `dur=${cal.napDuration.source}(${cal.napDuration.sampleCount})`,
  ].join(", ");
  const warns = cal.warnings.length > 0 ? ` [${cal.warnings.join("; ")}]` : "";
  return `day ${dayIndex}: trust=${cal.trust}, ${cal.daysWithData}d/${cal.completedNaps}naps — ${sources}${warns}`;
}

describe("calibration", () => {
  it("no data → age-default trust with warning", () => {
    const cal = calibrate(7, undefined, null, TZ);

    expect(cal.trust).toBe("age-default");
    expect(cal.warnings).toContain("No recent sleep data — using age-based defaults only");
  });

  it("1 day of data → age-default trust", () => {
    const cal = calibrate(7, collectRecent(1), null, TZ);

    expect(cal.trust).toBe("age-default");
    expect(cal.daysWithData).toBeLessThanOrEqual(1);
  });

  it("custom nap count counts as learned", () => {
    const cal = calibrate(7, collectRecent(5), 2, TZ);

    expect(cal.napCount.source).toBe("learned");
  });

  it("calibration progression over time", () => {
    const lines = [0, 1, 3, 7, 15, 40, 70].map(renderCal);
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "day 0: trust=age-default, 0d/0naps — count=age-default(0), ww=age-default(0), bed=age-default(0), dur=age-default(0) [No recent sleep data — using age-based defaults only; Baby is in a transition age (2-3 naps typical) — consider setting nap count manually]
      day 1: trust=age-default, 1d/2naps — count=age-default(0), ww=age-default(1), bed=age-default(0), dur=age-default(2) [Only 1 day(s) of data — predictions will improve with more logging; Baby is in a transition age (2-3 naps typical) — consider setting nap count manually]
      day 3: trust=learned, 3d/7naps — count=learned(3), ww=learned(6), bed=learned(3), dur=learned(7)
      day 7: trust=learned, 7d/18naps — count=learned(7), ww=learned(17), bed=learned(7), dur=learned(18)
      day 15: trust=learned, 7d/13naps — count=learned(7), ww=learned(12), bed=learned(7), dur=learned(13)
      day 40: trust=learned, 7d/15naps — count=learned(7), ww=learned(14), bed=learned(7), dur=learned(15)
      day 70: trust=learned, 7d/9naps — count=learned(7), ww=learned(8), bed=learned(7), dur=learned(9)"
    `);
  });
});
