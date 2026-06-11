#!/usr/bin/env bun
/**
 * Merge Napper CSV export + prod DB into a single backtest fixture.
 *
 * Usage:
 *   bun scripts/merge-fixtures.ts <napper.csv> <db-path> <output.json>
 *
 * Steps:
 *   1. Convert Napper CSV → DayRecords
 *   2. Convert DB → DayRecords
 *   3. Merge by date (DB takes precedence for overlapping dates)
 *   4. Validate and fix wake times
 */

import { parseNapperCsv } from "$lib/server/import-napper.js";
import { isoToDateInTz } from "$lib/tz.js";
import type { DayRecord } from "$lib/engine/backtest.js";
import { dbToDays, effectiveSettings } from "./lib/db-to-days.js";

// ── Napper CSV → DayRecords ─────────────────────────────────────────────────

function toUtc(ts: string): string {
  return new Date(ts).toISOString();
}

function napperToDays(csv: string, tz: string): DayRecord[] {
  const rows = parseNapperCsv(csv);
  const sorted = [...rows].toSorted(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );

  const days: DayRecord[] = [];
  let current: DayRecord | null = null;
  let pendingBedtime: string | null = null;

  for (const row of sorted) {
    switch (row.category) {
      case "WOKE_UP": {
        if (pendingBedtime && current) {
          current.sleeps.push({
            start_time: pendingBedtime,
            end_time: toUtc(row.start),
            type: "night",
          });
          pendingBedtime = null;
        }
        current = {
          date: isoToDateInTz(toUtc(row.start), tz),
          wakeTime: toUtc(row.start),
          sleeps: [],
        };
        days.push(current);
        break;
      }
      case "NAP": {
        if (!current) {
          current = {
            date: isoToDateInTz(toUtc(row.start), tz),
            wakeTime: toUtc(row.start),
            sleeps: [],
          };
          days.push(current);
        }
        current.sleeps.push({
          start_time: toUtc(row.start),
          end_time: toUtc(row.end),
          type: "nap",
        });
        break;
      }
      case "BED_TIME": {
        pendingBedtime = toUtc(row.start);
        break;
      }
    }
  }

  return days;
}

// ── Merge + Validate ────────────────────────────────────────────────────────

function mergeDays(napper: DayRecord[], db: DayRecord[]): DayRecord[] {
  const byDate = new Map<string, DayRecord>();

  // Napper first (lower priority)
  for (const d of napper) byDate.set(d.date, d);
  // DB overwrites overlapping dates
  for (const d of db) byDate.set(d.date, d);

  return [...byDate.values()].toSorted((a, b) => a.date.localeCompare(b.date));
}

function validateAndFix(days: DayRecord[]): { days: DayRecord[]; warnings: string[] } {
  const warnings: string[] = [];

  for (let i = 0; i < days.length; i++) {
    const day = days[i];

    // Check: wake time should be on the same date as the day
    const wakeDate = day.wakeTime.slice(0, 10);
    if (wakeDate !== day.date) {
      warnings.push(`${day.date}: wakeTime ${day.wakeTime} is on ${wakeDate}, not ${day.date}`);

      // Try to fix from previous night's end time
      if (i > 0) {
        const prevNight = days[i - 1].sleeps.find((s) => s.type === "night");
        if (prevNight?.end_time) {
          const nightEndDate = prevNight.end_time.slice(0, 10);
          if (nightEndDate === day.date || nightEndDate <= day.date) {
            day.wakeTime = prevNight.end_time;
            warnings[warnings.length - 1] += ` → fixed to ${day.wakeTime}`;
          }
        }
      }
    }

    // Check: wake time should be before first sleep
    if (day.sleeps.length > 0) {
      const firstSleep = new Date(day.sleeps[0].start_time).getTime();
      const wake = new Date(day.wakeTime).getTime();
      if (wake > firstSleep) {
        warnings.push(`${day.date}: wakeTime ${day.wakeTime} is after first sleep ${day.sleeps[0].start_time}`);
      }
    }
  }

  return { days, warnings };
}

// ── Main ────────────────────────────────────────────────────────────────────

const [napperCsvPath, dbPath, outputPath] = process.argv.slice(2);
if (!napperCsvPath || !dbPath || !outputPath) {
  console.error("Usage: bun scripts/merge-fixtures.ts <napper.csv> <db-path> <output.json>");
  process.exit(1);
}

// dbToDays reads the baby's timezone + walks the settings timeline.
const { days: dbDays, tz, settingsTimeline } = dbToDays(dbPath);

const napperDays = napperToDays(await Bun.file(napperCsvPath).text(), tz);

// Napper-only days (pre-app history) carry the bedtime target that was
// actually in effect on each date, walked from `baby.updated` events — not a
// uniform "current value" smear across history.
for (const d of napperDays) {
  if (d.target_bedtime === undefined) {
    const tb = effectiveSettings(settingsTimeline, d.date).targetBedtime;
    if (tb) d.target_bedtime = tb;
  }
}

console.error(`Napper: ${napperDays.length} days (${napperDays[0]?.date} to ${napperDays.at(-1)?.date})`);
console.error(`DB: ${dbDays.length} days (${dbDays[0]?.date} to ${dbDays.at(-1)?.date})`);

const merged = mergeDays(napperDays, dbDays);
console.error(`Merged: ${merged.length} days (${merged[0]?.date} to ${merged.at(-1)?.date})`);

const { days, warnings } = validateAndFix(merged);
if (warnings.length > 0) {
  console.error(`\nWarnings (${warnings.length}):`);
  for (const w of warnings) console.error(`  ${w}`);
}

await Bun.write(outputPath, JSON.stringify(days, null, 2));
console.error(`\nWrote ${days.length} days to ${outputPath}`);
