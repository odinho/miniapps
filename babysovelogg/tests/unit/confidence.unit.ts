import { describe, expect, it } from "bun:test";
import { computeConfidence } from "$lib/engine/confidence.js";
import { predictDayNaps, recommendBedtime, calculateAgeMonths } from "$lib/engine/schedule.js";
import type { DayRecord } from "$lib/engine/backtest.js";
import type { SleepEntry, BabyContext } from "$lib/types.js";

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

function makeCtx(dayIndex: number): BabyContext {
  const day = days[dayIndex];
  return {
    birthdate: BIRTHDATE,
    ageMonths: calculateAgeMonths(BIRTHDATE, new Date(day.date + "T12:00:00Z")),
    tz: TZ,
    customNapCount: null,
    recentSleeps: collectRecent(dayIndex),
  };
}

describe("confidence intervals", () => {
  it("cold start (day 2) has low confidence with wide ranges", () => {
    const ctx = makeCtx(1);
    const day = days[1];
    const naps = predictDayNaps(day.wakeTime, ctx);
    const bedtime = recommendBedtime(
      day.sleeps.filter((s) => s.type === "nap" && s.end_time),
      ctx,
    );

    const conf = computeConfidence(naps, bedtime, ctx.ageMonths, ctx.recentSleeps, TZ);

    expect(conf.level).toBe("low");
    expect(conf.dataPoints).toBeLessThanOrEqual(1);
    for (const nap of conf.napRanges) {
      expect(nap.startRange.sdMinutes).toBeGreaterThanOrEqual(10);
    }
  });

  it("warm state (day 40) has reasonable confidence", () => {
    const ctx = makeCtx(40);
    const day = days[40];
    const naps = predictDayNaps(day.wakeTime, ctx);
    const bedtime = recommendBedtime(
      day.sleeps.filter((s) => s.type === "nap" && s.end_time),
      ctx,
    );

    const conf = computeConfidence(naps, bedtime, ctx.ageMonths, ctx.recentSleeps, TZ);

    expect(conf.dataPoints).toBeGreaterThan(3);
    expect(conf.napRanges.length).toBeGreaterThan(0);
    for (const nap of conf.napRanges) {
      expect(nap.startRange.sdMinutes).toBeGreaterThanOrEqual(10);
      expect(nap.startRange.sdMinutes).toBeLessThan(120);
    }
    expect(conf.bedtimeRange.sdMinutes).toBeGreaterThanOrEqual(10);
  });

  it("later naps have wider ranges (uncertainty compounds)", () => {
    const ctx = makeCtx(50);
    const day = days[50];
    const naps = predictDayNaps(day.wakeTime, ctx);
    const bedtime = recommendBedtime(
      day.sleeps.filter((s) => s.type === "nap" && s.end_time),
      ctx,
    );

    const conf = computeConfidence(naps, bedtime, ctx.ageMonths, ctx.recentSleeps, TZ);

    if (conf.napRanges.length >= 2) {
      expect(conf.napRanges[1].startRange.sdMinutes).toBeGreaterThanOrEqual(
        conf.napRanges[0].startRange.sdMinutes,
      );
    }
  });

  it("snapshot of confidence at various points", () => {
    const snapshots = [10, 30, 50, 70].map((i) => {
      const ctx = makeCtx(i);
      const day = days[i];
      const naps = predictDayNaps(day.wakeTime, ctx);
      const bedtime = recommendBedtime(
        day.sleeps.filter((s) => s.type === "nap" && s.end_time),
        ctx,
      );
      const conf = computeConfidence(naps, bedtime, ctx.ageMonths, ctx.recentSleeps, TZ);

      const napSDs = conf.napRanges.map((n) => n.startRange.sdMinutes).join("/");
      return `day ${i} (${ctx.ageMonths}mo): level=${conf.level}, nap SDs=[${napSDs}], bed SD=${conf.bedtimeRange.sdMinutes}, data=${conf.dataPoints}d`;
    });

    expect(snapshots.join("\n")).toMatchInlineSnapshot(`
      "day 10 (7mo): level=low, nap SDs=[28/45], bed SD=55, data=7d
      day 30 (7mo): level=low, nap SDs=[25/47], bed SD=25, data=7d
      day 50 (8mo): level=low, nap SDs=[33/49], bed SD=30, data=7d
      day 70 (9mo): level=low, nap SDs=[15], bed SD=82, data=7d"
    `);
  });

  // Pin: cut-short censoring narrows the duration SD when woke_by data is
  // present. Existing fixture-based tests above don't exercise this because
  // halldis-sleep.json predates the woke_by field — they verify the path is
  // a no-op without labels. This test verifies the path engages with labels.
  it("censors cut-shorts before computing nap-duration SD", () => {
    const ageMonths = 10;
    const sd2 = (s: SleepEntry[]) => {
      const dummyNap = { startTime: "2026-04-29T07:00:00Z", endTime: "2026-04-29T08:30:00Z" };
      return computeConfidence(
        [dummyNap, { ...dummyNap, startTime: "2026-04-29T11:00:00Z", endTime: "2026-04-29T12:30:00Z" }],
        "2026-04-29T19:00:00Z",
        ageMonths,
        s,
        TZ,
      ).napRanges[1].startRange.sdMinutes;
    };

    const naturalNaps: SleepEntry[] = [
      { start_time: "2026-04-22T08:00:00Z", end_time: "2026-04-22T09:50:00Z", type: "nap", woke_by: "self" },
      { start_time: "2026-04-23T08:00:00Z", end_time: "2026-04-23T09:50:00Z", type: "nap", woke_by: "self" },
      { start_time: "2026-04-24T08:00:00Z", end_time: "2026-04-24T09:55:00Z", type: "nap", woke_by: "self" },
      { start_time: "2026-04-25T08:00:00Z", end_time: "2026-04-25T09:50:00Z", type: "nap", woke_by: "self" },
      { start_time: "2026-04-26T08:00:00Z", end_time: "2026-04-26T09:48:00Z", type: "nap", woke_by: "self" },
    ];
    const withCutShort: SleepEntry[] = [
      ...naturalNaps,
      { start_time: "2026-04-27T08:00:00Z", end_time: "2026-04-27T08:42:00Z", type: "nap", woke_by: "woken" },
    ];
    const withoutLabels: SleepEntry[] = withCutShort.map((s) => ({ ...s, woke_by: null }));

    // The cut-short adds a low outlier to the durations. Without censoring
    // (no labels), it inflates the SD. With labels, the censor drops it and
    // the SD is closer to the natural-only baseline.
    const censored = sd2(withCutShort);
    const uncensored = sd2(withoutLabels);
    expect(censored).toBeLessThan(uncensored);
  });
});
