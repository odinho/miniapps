import { describe, expect, it } from "bun:test";
import { computeConfidence } from "$lib/engine/confidence.js";
import { predictDayNaps, recommendBedtime, calculateAgeMonths } from "$lib/engine/schedule.js";
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

describe("confidence intervals", () => {
  it("cold start (day 2) has low confidence with wide ranges", () => {
    const day = days[1];
    const ageMonths = calculateAgeMonths(BIRTHDATE, new Date(day.date + "T12:00:00Z"));
    const recent = collectRecent(1);
    const naps = predictDayNaps(day.wakeTime, ageMonths, recent, null, TZ);
    const bedtime = recommendBedtime(
      day.sleeps.filter((s) => s.type === "nap" && s.end_time),
      ageMonths, null, recent, TZ,
    );

    const conf = computeConfidence(naps, bedtime, ageMonths, recent, TZ);

    expect(conf.level).toBe("low");
    expect(conf.dataPoints).toBeLessThanOrEqual(1);
    // Wide ranges when no data
    for (const nap of conf.napRanges) {
      expect(nap.startRange.sdMinutes).toBeGreaterThanOrEqual(10);
    }
  });

  it("warm state (day 40) has reasonable confidence", () => {
    const day = days[40];
    const ageMonths = calculateAgeMonths(BIRTHDATE, new Date(day.date + "T12:00:00Z"));
    const recent = collectRecent(40);
    const naps = predictDayNaps(day.wakeTime, ageMonths, recent, null, TZ);
    const bedtime = recommendBedtime(
      day.sleeps.filter((s) => s.type === "nap" && s.end_time),
      ageMonths, null, recent, TZ,
    );

    const conf = computeConfidence(naps, bedtime, ageMonths, recent, TZ);

    expect(conf.dataPoints).toBeGreaterThan(3);
    expect(conf.napRanges.length).toBeGreaterThan(0);
    // Ranges should be tighter than cold start
    for (const nap of conf.napRanges) {
      expect(nap.startRange.sdMinutes).toBeGreaterThanOrEqual(10);
      expect(nap.startRange.sdMinutes).toBeLessThan(120);
    }
    expect(conf.bedtimeRange.sdMinutes).toBeGreaterThanOrEqual(10);
  });

  it("later naps have wider ranges (uncertainty compounds)", () => {
    const day = days[50];
    const ageMonths = calculateAgeMonths(BIRTHDATE, new Date(day.date + "T12:00:00Z"));
    const recent = collectRecent(50);
    const naps = predictDayNaps(day.wakeTime, ageMonths, recent, null, TZ);
    const bedtime = recommendBedtime(
      day.sleeps.filter((s) => s.type === "nap" && s.end_time),
      ageMonths, null, recent, TZ,
    );

    const conf = computeConfidence(naps, bedtime, ageMonths, recent, TZ);

    if (conf.napRanges.length >= 2) {
      expect(conf.napRanges[1].startRange.sdMinutes).toBeGreaterThanOrEqual(
        conf.napRanges[0].startRange.sdMinutes,
      );
    }
  });

  it("snapshot of confidence at various points", () => {
    const snapshots = [10, 30, 50, 70].map((i) => {
      const day = days[i];
      const ageMonths = calculateAgeMonths(BIRTHDATE, new Date(day.date + "T12:00:00Z"));
      const recent = collectRecent(i);
      const naps = predictDayNaps(day.wakeTime, ageMonths, recent, null, TZ);
      const bedtime = recommendBedtime(
        day.sleeps.filter((s) => s.type === "nap" && s.end_time),
        ageMonths, null, recent, TZ,
      );
      const conf = computeConfidence(naps, bedtime, ageMonths, recent, TZ);

      const napSDs = conf.napRanges.map((n) => n.startRange.sdMinutes).join("/");
      return `day ${i} (${ageMonths}mo): level=${conf.level}, nap SDs=[${napSDs}], bed SD=${conf.bedtimeRange.sdMinutes}, data=${conf.dataPoints}d`;
    });

    expect(snapshots.join("\n")).toMatchInlineSnapshot(`
      "day 10 (7mo): level=low, nap SDs=[28/45], bed SD=55, data=7d
      day 30 (7mo): level=low, nap SDs=[25/47], bed SD=25, data=7d
      day 50 (8mo): level=low, nap SDs=[33/49], bed SD=30, data=7d
      day 70 (9mo): level=high, nap SDs=[15], bed SD=82, data=7d"
    `);
  });
});
