import { describe, expect, it } from "bun:test";
import { calculateAgeMonths } from "$lib/engine/schedule.js";
import { regressionEquations } from "$lib/data/galland2012.js";
import { parentReportedNaps, daytimeSleepDuration, avgBedtime } from "$lib/data/shine2021.js";
import type { DayRecord } from "$lib/engine/backtest.js";

import halldisData from "../fixtures/halldis-sleep.json";

const BIRTHDATE = "2025-06-12";
const days = halldisData as DayRecord[];

// =============================================================================
// Helpers: compute actual stats from Halldis fixture
// =============================================================================

interface MonthStats {
  ageMonths: number;
  days: number;
  avgNaps: number;
  avgDaytimeSleepMin: number;
  avgBedtimeHour: number;
}

function computeMonthlyStats(): MonthStats[] {
  const byMonth = new Map<number, DayRecord[]>();
  for (const day of days) {
    const age = calculateAgeMonths(BIRTHDATE, new Date(day.date + "T12:00:00Z"));
    if (!byMonth.has(age)) byMonth.set(age, []);
    byMonth.get(age)!.push(day);
  }

  return [...byMonth.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([age, monthDays]) => {
      const napCounts = monthDays.map(
        (d) => d.sleeps.filter((s) => s.type === "nap").length,
      );
      const daytimeMins = monthDays.map((d) =>
        d.sleeps
          .filter((s) => s.type === "nap" && s.end_time)
          .reduce(
            (sum, s) =>
              sum + (new Date(s.end_time!).getTime() - new Date(s.start_time).getTime()) / 60000,
            0,
          ),
      );
      const bedtimeHours = monthDays
        .map((d) => {
          const night = d.sleeps.find((s) => s.type === "night");
          if (!night) return null;
          const h = new Date(night.start_time).getUTCHours();
          const m = new Date(night.start_time).getUTCMinutes();
          return h + m / 60 + 1; // UTC+1 for CET
        })
        .filter((h): h is number => h !== null);

      return {
        ageMonths: age,
        days: monthDays.length,
        avgNaps: napCounts.reduce((a, b) => a + b, 0) / napCounts.length,
        avgDaytimeSleepMin:
          daytimeMins.reduce((a, b) => a + b, 0) / daytimeMins.length,
        avgBedtimeHour:
          bedtimeHours.length > 0
            ? bedtimeHours.reduce((a, b) => a + b, 0) / bedtimeHours.length
            : 0,
      };
    });
}

function zScore(value: number, mean: number, sd: number): string {
  const z = (value - mean) / sd;
  const sign = z >= 0 ? "+" : "";
  return `${sign}${z.toFixed(1)}σ`;
}

function renderNormsComparison(stats: MonthStats[]): string {
  const lines: string[] = [];
  lines.push("age  days  naps  galland  SHINE       daySleep          bedtime  SHINE-bed");

  for (const s of stats) {
    const galNaps = regressionEquations.daytimeNapsCount(s.ageMonths);
    const shineNap = parentReportedNaps.find((b) => b.ageMonths === s.ageMonths);
    const shineDaySleep = daytimeSleepDuration.find((b) => b.ageMonths === s.ageMonths);
    const shineBed = avgBedtime.find((b) => b.ageMonths === s.ageMonths);

    const shineZ = shineNap
      ? zScore(s.avgNaps, shineNap.mean, shineNap.sd)
      : "-";
    const dayMin = Math.round(s.avgDaytimeSleepMin);
    const shineDayZ = shineDaySleep
      ? zScore(s.avgDaytimeSleepMin, shineDaySleep.mean, shineDaySleep.sd)
      : "-";
    const bed = s.avgBedtimeHour > 0
      ? `${Math.floor(s.avgBedtimeHour)}:${String(Math.round((s.avgBedtimeHour % 1) * 60)).padStart(2, "0")}`
      : "-";
    const shineBedZ = shineBed && s.avgBedtimeHour > 0
      ? zScore(s.avgBedtimeHour, shineBed.mean, shineBed.sd)
      : "-";

    lines.push(
      `${String(s.ageMonths).padStart(2)}mo  ` +
      `${String(s.days).padStart(3)}   ` +
      `${s.avgNaps.toFixed(1)}   ${galNaps.toFixed(1)}     ${shineZ.padEnd(8)}  ` +
      `${String(dayMin).padStart(3)} min ${shineDayZ.padEnd(6)}  ${bed.padEnd(6)}   ${shineBedZ}`,
    );
  }

  return lines.join("\n");
}

// =============================================================================
// Tests
// =============================================================================

describe("Halldis vs population norms", () => {
  const stats = computeMonthlyStats();

  it("comparison table", () => {
    expect(renderNormsComparison(stats)).toMatchInlineSnapshot(`
      "age  days  naps  galland  SHINE       daySleep          bedtime  SHINE-bed
       6mo    6   2.7   2.5     -0.2σ     131 min -0.3σ   18:28    -1.9σ
       7mo   31   1.9   2.4     -         128 min -       18:16    -
       8mo   28   1.9   2.2     -         116 min -       18:19    -
       9mo   31   1.1   2.1     -         100 min -       17:45    -
      10mo   30   1.1   2.0     -          99 min -       17:17    -
      11mo   13   0.9   1.9     -          95 min -       17:37    -"
    `);
  });

  it("nap count is within 2 SD of SHINE at measured ages", () => {
    for (const s of stats) {
      const shine = parentReportedNaps.find((b) => b.ageMonths === s.ageMonths);
      if (!shine) continue;
      const z = Math.abs((s.avgNaps - shine.mean) / shine.sd);
      expect(z).toBeLessThan(2);
    }
  });

  it("she is an early nap dropper at 9mo", () => {
    const age9 = stats.find((s) => s.ageMonths === 9);
    expect(age9).toBeDefined();

    // Galland predicts 2.1 naps at 9mo, SHINE 12mo is 1.8 ±0.6
    const gallandExpected = regressionEquations.daytimeNapsCount(9);
    expect(age9!.avgNaps).toBeLessThan(gallandExpected);

    // She's doing fewer naps than even the 12mo SHINE mean
    const shine12 = parentReportedNaps.find((b) => b.ageMonths === 12)!;
    expect(age9!.avgNaps).toBeLessThan(shine12.mean);
  });
});
