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
  sleeps: { start_time: string; end_time: string; type: "nap" | "night" }[];
}

const [dbPath = "db.sqlite", outputPath] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true });

const sleeps = db.prepare(`
  SELECT start_time, end_time, type
  FROM sleep_log WHERE deleted = 0
  ORDER BY start_time
`).all() as { start_time: string; end_time: string | null; type: string }[];

const dayStarts = db.prepare(`
  SELECT date, wake_time FROM day_start ORDER BY date
`).all() as { date: string; wake_time: string }[];

db.close();

// Index day starts by date
const wakeByDate = new Map(dayStarts.map((d) => [d.date, d.wake_time]));

// Group sleeps by date
const byDate = new Map<string, typeof sleeps>();
for (const s of sleeps) {
  const date = s.start_time.slice(0, 10);
  const list = byDate.get(date) ?? [];
  list.push(s);
  byDate.set(date, list);
}

// Build day records
const days: DayRecord[] = [];
const allDates = new Set([...wakeByDate.keys(), ...byDate.keys()]);
for (const date of [...allDates].sort()) {
  const wakeTime = wakeByDate.get(date);
  const daySleeps = byDate.get(date) ?? [];

  // Need a wake time — either from day_start or from ending of a prior night sleep
  let wake = wakeTime;
  if (!wake) {
    const nightEnd = daySleeps.find((s) => s.type === "night" && s.end_time);
    if (nightEnd?.end_time) wake = nightEnd.end_time;
    else continue; // skip days without a known wake time
  }

  days.push({
    date,
    wakeTime: wake,
    sleeps: daySleeps
      .filter((s) => s.end_time)
      .map((s) => ({
        start_time: s.start_time,
        end_time: s.end_time!,
        type: s.type as "nap" | "night",
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
