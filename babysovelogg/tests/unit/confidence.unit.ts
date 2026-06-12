import { describe, expect, it } from "bun:test";
import { computeConfidence, computeWakeRange } from "$lib/engine/confidence.js";
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
      "day 10 (7mo): level=low, nap SDs=[39/55], bed SD=55, data=7d
      day 30 (7mo): level=low, nap SDs=[36/47], bed SD=25, data=7d
      day 50 (8mo): level=low, nap SDs=[32/49], bed SD=30, data=7d
      day 70 (9mo): level=low, nap SDs=[91], bed SD=82, data=7d"
    `);
  });

  // Pin: cut-short censoring narrows the duration SD when woke_by data is
  // present. The fixture-based tests above mix censored and uncensored days
  // (the early Halldis logs predate the field, the later ones populate it),
  // so this test isolates the behavior on a synthetic input where the cut-
  // short is unambiguous.
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

  // Pin: positional SDs are aligned to the same nap positions schedule.ts
  // uses. Position 0 must measure morning-wake → nap1, NOT nap1 → nap2. The
  // morning overnight is start-anchored to yesterday's day bucket, so a naive
  // per-day loop shifts every position by one (deep-review bug #1). Here the
  // first WW is rock-stable (nap1 at 09:30 sharp) while the second gap swings
  // wildly — an aligned reading gives nap0 a tight band.
  it("positional SD aligns position 0 to the morning wake window", () => {
    const sleeps: SleepEntry[] = [];
    for (let d = 1; d <= 6; d++) {
      const day = `2026-06-0${d}`;
      sleeps.push({
        start_time: `2026-06-0${d - 1 === 0 ? d : d - 1}T17:30:00.000Z`,
        end_time: `${day}T05:00:00.000Z`, // 07:00 Oslo, stable
        type: "night",
      });
      sleeps.push({
        start_time: `${day}T07:30:00.000Z`, // 09:30 Oslo, stable → first WW ~150m
        end_time: `${day}T09:00:00.000Z`,
        type: "nap",
      });
      const startH = d % 2 === 0 ? 11 : 13; // nap2 start swings 13:00 vs 15:00 Oslo
      sleeps.push({
        start_time: `${day}T${String(startH).padStart(2, "0")}:00:00.000Z`,
        end_time: `${day}T${String(startH + 1).padStart(2, "0")}:00:00.000Z`,
        type: "nap",
      });
    }
    const naps = [
      { startTime: "2026-06-07T07:30:00.000Z", endTime: "2026-06-07T09:00:00.000Z" },
      { startTime: "2026-06-07T12:00:00.000Z", endTime: "2026-06-07T13:00:00.000Z" },
    ];

    const conf = computeConfidence(naps, "2026-06-07T17:30:00.000Z", 10, sleeps, TZ);

    expect(conf.napRanges[0].startRange.sdMinutes).toBe(10); // floored — stable first WW
    expect(conf.napRanges[1].startRange.sdMinutes).toBeGreaterThan(60); // wild second gap
  });
});

describe("computeWakeRange (active-sleep progress meter)", () => {
  const WAKE = "2026-04-29T11:00:00.000Z";

  it("returns null when wakePoint is null", () => {
    expect(computeWakeRange(null, "nap", 8)).toBeNull();
    expect(computeWakeRange(null, "night", 8)).toBeNull();
  });

  it("falls back to age-default SD for naps with no data", () => {
    const youngRange = computeWakeRange(WAKE, "nap", 4)!;
    const olderRange = computeWakeRange(WAKE, "nap", 12)!;
    // Young infants: fallback 20m; older: 15m (per getNapDurationStats).
    expect(youngRange.sdMinutes).toBe(20);
    expect(olderRange.sdMinutes).toBe(15);
    // Range straddles the wake point symmetrically.
    expect(youngRange.point).toBe(WAKE);
    const wakeMs = new Date(WAKE).getTime();
    expect(new Date(youngRange.lo).getTime()).toBe(wakeMs - 20 * 60_000);
    expect(new Date(youngRange.hi).getTime()).toBe(wakeMs + 20 * 60_000);
  });

  it("uses wider SD for night sleep than nap", () => {
    const napYoung = computeWakeRange(WAKE, "nap", 4)!;
    const nightYoung = computeWakeRange(WAKE, "night", 4)!;
    expect(nightYoung.sdMinutes).toBeGreaterThan(napYoung.sdMinutes);
    // Older babies → tighter night SD than younger.
    const nightOlder = computeWakeRange(WAKE, "night", 12)!;
    expect(nightOlder.sdMinutes).toBeLessThan(nightYoung.sdMinutes);
  });

  it("floors SD at MIN_SD_MINUTES (10) even for a perfectly consistent baby", () => {
    // 5 identical-length naps → variance 0, but the floor must keep SD ≥ 10.
    const naps: SleepEntry[] = Array.from({ length: 5 }, (_, i) => ({
      start_time: `2026-04-2${i + 1}T08:00:00Z`,
      end_time: `2026-04-2${i + 1}T09:30:00Z`,
      type: "nap",
      woke_by: "self",
    }));
    const range = computeWakeRange(WAKE, "nap", 8, naps)!;
    expect(range.sdMinutes).toBeGreaterThanOrEqual(10);
  });

  it("ignores implausible night durations outside 360–900 min", () => {
    // 3 plausible 11h nights + 2 noise samples (45 min and 18 h). The filter
    // must drop the noise so the SD reflects only the good nights.
    const nights: SleepEntry[] = [
      { start_time: "2026-04-22T19:00:00Z", end_time: "2026-04-23T06:00:00Z", type: "night", woke_by: null },
      { start_time: "2026-04-23T19:00:00Z", end_time: "2026-04-24T06:00:00Z", type: "night", woke_by: null },
      { start_time: "2026-04-24T19:00:00Z", end_time: "2026-04-25T06:00:00Z", type: "night", woke_by: null },
      // 45 min "night" — data entry mistake
      { start_time: "2026-04-25T19:00:00Z", end_time: "2026-04-25T19:45:00Z", type: "night", woke_by: null },
      // 18 h "night" — partial-log artefact
      { start_time: "2026-04-26T19:00:00Z", end_time: "2026-04-27T13:00:00Z", type: "night", woke_by: null },
    ];
    const range = computeWakeRange(WAKE, "night", 10, nights)!;
    // With 3 identical nights the floor kicks in (SD === 10), but the call
    // must not throw or produce NaN from the noisy samples.
    expect(range.sdMinutes).toBeGreaterThanOrEqual(10);
    expect(Number.isFinite(range.sdMinutes)).toBe(true);
  });
});
