#!/usr/bin/env bun
/**
 * Convert sleep data from our SQLite DB to a backtest fixture JSON file.
 *
 * Usage:
 *   bun scripts/db-to-fixture.ts [db-path] [output.json]
 *
 * Defaults: db-path = db.sqlite, output = stdout.
 */

import Database from "bun:sqlite";

interface DayRecord {
  date: string;
  wakeTime: string;
  sleeps: {
    start_time: string;
    end_time: string;
    type: "nap" | "night";
    woke_by?: "self" | "woken" | null;
  }[];
}

const [dbPath = "db.sqlite", outputPath] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true });

const sleeps = db.prepare(`
  SELECT start_time, end_time, type, woke_by
  FROM sleep_log WHERE deleted = 0
  ORDER BY start_time
`).all() as {
  start_time: string;
  end_time: string | null;
  type: string;
  woke_by: string | null;
}[];

const dayStarts = db.prepare(`
  SELECT date, wake_time FROM day_start ORDER BY date
`).all() as { date: string; wake_time: string }[];

db.close();

// Index day starts by date
const wakeByDate = new Map(dayStarts.map((d) => [d.date, d.wake_time]));

// Group sleeps by start-date
const byDate = new Map<string, typeof sleeps>();
for (const s of sleeps) {
  const date = s.start_time.slice(0, 10);
  const list = byDate.get(date) ?? [];
  list.push(s);
  byDate.set(date, list);
}

// Index night-ends by the date the night *ended* on. Mirrors the prod
// `getState` rule: today's wake time is yesterday's night.end_time, with
// `ORDER BY end_time DESC LIMIT 1` picking the latest end on a date when
// fragmented data has multiple nights ending the same day.
const nightEndByEndDate = new Map<string, string>();
for (const s of sleeps) {
  if (s.type !== "night" || !s.end_time) continue;
  const endDate = s.end_time.slice(0, 10);
  // Many nights end in the early hours of the next day — that's the morning
  // wake we want. Skip nights that end the same day they started (very long
  // nights or fragmented data).
  if (endDate === s.start_time.slice(0, 10)) continue;
  const prev = nightEndByEndDate.get(endDate);
  if (!prev || s.end_time > prev) nightEndByEndDate.set(endDate, s.end_time);
}

// Build day records
const days: DayRecord[] = [];
const allDates = new Set([...wakeByDate.keys(), ...byDate.keys()]);
for (const date of [...allDates].sort()) {
  const wakeTime = wakeByDate.get(date);
  const daySleeps = byDate.get(date) ?? [];

  // Need a wake time — either from day_start or from prior night's end_time
  let wake = wakeTime;
  if (!wake) {
    wake = nightEndByEndDate.get(date);
    if (!wake) continue; // skip days without a known wake time
  }

  // Skip in-progress days (any active sleep) — fixtures are for replaying
  // completed history, not partial state.
  if (daySleeps.some((s) => !s.end_time)) continue;

  days.push({
    date,
    wakeTime: wake,
    sleeps: daySleeps.map((s) => ({
      start_time: s.start_time,
      end_time: s.end_time!,
      type: s.type as "nap" | "night",
      woke_by: s.woke_by === "self" || s.woke_by === "woken" ? s.woke_by : null,
    })),
  });
}

const json = JSON.stringify(days, null, 2);
if (outputPath) {
  await Bun.write(outputPath, json);
  console.error(`Wrote ${days.length} days to ${outputPath}`);
} else {
  console.log(json);
}
