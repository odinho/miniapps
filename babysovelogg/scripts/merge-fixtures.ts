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
import Database from "bun:sqlite";

interface DayRecord {
  date: string;
  wakeTime: string;
  /** Family's preferred bedtime ("HH:MM" local) on this day. Exported as the
   *  baby's current target_bedtime applied uniformly. */
  target_bedtime?: string | null;
  /** Parent-flagged off-day (sick/travel/spurt/DST). */
  off_day?: 0 | 1;
  off_day_reason?: string | null;
  sleeps: {
    start_time: string;
    end_time: string;
    type: "nap" | "night";
    woke_by?: "self" | "woken" | null;
    /** Pause periods inside the sleep (legacy `sleep_pauses` table). */
    pauses?: { pause_time: string; resume_time: string | null }[];
  }[];
}

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

// ── DB → DayRecords ─────────────────────────────────────────────────────────

function dbToDays(dbPath: string, tz: string): {
  days: DayRecord[];
  targetBedtime: string | null;
} {
  const db = new Database(dbPath, { readonly: true });

  const baby = db.prepare(
    `SELECT target_bedtime FROM baby ORDER BY id DESC LIMIT 1`,
  ).get() as { target_bedtime: string | null } | undefined;
  const targetBedtime = baby?.target_bedtime && baby.target_bedtime.length > 0
    ? baby.target_bedtime
    : null;

  const sleeps = db.prepare(`
    SELECT id, start_time, end_time, type, woke_by
    FROM sleep_log WHERE deleted = 0
    ORDER BY start_time
  `).all() as {
    id: number;
    start_time: string;
    end_time: string | null;
    type: string;
    woke_by: string | null;
  }[];

  const pauseRows = db.prepare(`
    SELECT sleep_id, pause_time, resume_time FROM sleep_pauses ORDER BY pause_time
  `).all() as {
    sleep_id: number;
    pause_time: string;
    resume_time: string | null;
  }[];
  const pausesBySleep = new Map<number, { pause_time: string; resume_time: string | null }[]>();
  for (const p of pauseRows) {
    const list = pausesBySleep.get(p.sleep_id) ?? [];
    list.push({ pause_time: p.pause_time, resume_time: p.resume_time });
    pausesBySleep.set(p.sleep_id, list);
  }

  const dayStarts = db.prepare(`
    SELECT date, wake_time, off_day, off_day_reason FROM day_start ORDER BY date
  `).all() as {
    date: string;
    wake_time: string;
    off_day: number | null;
    off_day_reason: string | null;
  }[];

  db.close();

  const wakeByDate = new Map(dayStarts.map((d) => [d.date, d.wake_time]));
  const offDayByDate = new Map(
    dayStarts.map((d) => [
      d.date,
      { off_day: d.off_day === 1 ? 1 as const : 0 as const, off_day_reason: d.off_day_reason },
    ]),
  );
  const byDate = new Map<string, typeof sleeps>();
  for (const s of sleeps) {
    const date = isoToDateInTz(s.start_time, tz);
    const list = byDate.get(date) ?? [];
    list.push(s);
    byDate.set(date, list);
  }

  const days: DayRecord[] = [];
  const allDates = new Set([...wakeByDate.keys(), ...byDate.keys()]);
  for (const date of [...allDates].sort()) {
    const wakeTime = wakeByDate.get(date);
    const daySleeps = byDate.get(date) ?? [];

    let wake = wakeTime;
    if (!wake) {
      const nightEnd = daySleeps.find((s) => s.type === "night" && s.end_time);
      if (nightEnd?.end_time) wake = nightEnd.end_time;
      else continue;
    }

    const offDayMeta = offDayByDate.get(date);
    days.push({
      date,
      wakeTime: wake,
      ...(targetBedtime ? { target_bedtime: targetBedtime } : {}),
      ...(offDayMeta?.off_day === 1
        ? { off_day: 1 as const, off_day_reason: offDayMeta.off_day_reason ?? null }
        : {}),
      sleeps: daySleeps
        .filter((s) => s.end_time)
        .map((s) => {
          const pauses = pausesBySleep.get(s.id);
          return {
            start_time: s.start_time,
            end_time: s.end_time!,
            type: s.type as "nap" | "night",
            woke_by: s.woke_by === "self" || s.woke_by === "woken" ? s.woke_by : null,
            ...(pauses && pauses.length > 0 ? { pauses } : {}),
          };
        }),
    });
  }

  return { days, targetBedtime };
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

// Read the baby's timezone from the DB for correct day-boundary bucketing
const tzDb = new Database(dbPath, { readonly: true });
const babyRow = tzDb.prepare("SELECT timezone FROM baby ORDER BY id DESC LIMIT 1").get() as { timezone: string | null } | undefined;
tzDb.close();
const tz = babyRow?.timezone || "Europe/Oslo";

const napperDays = napperToDays(await Bun.file(napperCsvPath).text(), tz);
const { days: dbDays, targetBedtime } = dbToDays(dbPath, tz);

// Napper-only days should also carry the baby's current target_bedtime so
// the backtest reads a consistent setting throughout history. This is an
// approximation (no per-day history) — acceptable for current usage.
if (targetBedtime) {
  for (const d of napperDays) {
    if (d.target_bedtime === undefined) d.target_bedtime = targetBedtime;
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
