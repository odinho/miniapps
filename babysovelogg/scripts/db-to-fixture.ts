#!/usr/bin/env bun
/**
 * Convert sleep data from our SQLite DB to a backtest fixture JSON file.
 *
 * Usage:
 *   bun scripts/db-to-fixture.ts [db-path] [output.json]
 *
 * Defaults: db-path = db.sqlite, output = stdout.
 *
 * Date keys ("which day does this sleep belong to?") use the baby's stored
 * IANA timezone — raw UTC slicing would put a 21:00-local sleep on the wrong
 * calendar day in any timezone where local midnight isn't UTC midnight.
 */

import Database from "bun:sqlite";
import { isoToDateInTz } from "../src/lib/tz.js";

interface DayRecord {
  date: string;
  wakeTime: string;
  /** Family's preferred bedtime ("HH:MM" local) on this day, if tracked.
   *  Currently exported as the baby's *current* target_bedtime applied
   *  uniformly — historical changes are not yet walked from events. */
  target_bedtime?: string | null;
  /** True when the parent flagged the day as sick/travel/spurt/DST. The
   *  engine excludes these from trend math. */
  off_day?: 0 | 1;
  off_day_reason?: string | null;
  sleeps: {
    start_time: string;
    end_time: string;
    type: "nap" | "night";
    woke_by?: "self" | "woken" | null;
    /** Pause periods inside the sleep (legacy `sleep_pauses` table; replaced
     *  by `night_waking` events for nights in the 2026-05-22 redesign). The
     *  backtest engine reads these and nets their duration out of night
     *  totals via `calcPauseMs`. */
    pauses?: { pause_time: string; resume_time: string | null }[];
  }[];
}

const [dbPath = "db.sqlite", outputPath] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true });

const baby = db.prepare(
  `SELECT timezone, target_bedtime FROM baby ORDER BY id DESC LIMIT 1`,
).get() as
  | { timezone: string | null; target_bedtime: string | null }
  | undefined;
const tz = baby?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
// `target_bedtime` is stored as either an empty string or "HH:MM" — only
// treat non-empty as set.
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
  SELECT sleep_id, pause_time, resume_time
  FROM sleep_pauses
  ORDER BY pause_time
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

// Index day starts by date (carrying off-day metadata).
const wakeByDate = new Map(dayStarts.map((d) => [d.date, d.wake_time]));
const offDayByDate = new Map(
  dayStarts.map((d) => [
    d.date,
    { off_day: d.off_day === 1 ? 1 as const : 0 as const, off_day_reason: d.off_day_reason },
  ]),
);

// Group sleeps by local start-date (TZ-aware so e.g. Tokyo bedtimes don't
// land on the wrong UTC date).
const byDate = new Map<string, typeof sleeps>();
for (const s of sleeps) {
  const date = isoToDateInTz(s.start_time, tz);
  const list = byDate.get(date) ?? [];
  list.push(s);
  byDate.set(date, list);
}

// Index night-ends by the local date the night *ended* on. Mirrors the prod
// `getState` rule: today's wake time is yesterday's night.end_time, with
// `ORDER BY end_time DESC LIMIT 1` picking the latest end on a date when
// fragmented data has multiple nights ending the same day.
const nightEndByEndDate = new Map<string, string>();
for (const s of sleeps) {
  if (s.type !== "night" || !s.end_time) continue;
  const endDate = isoToDateInTz(s.end_time, tz);
  const startDate = isoToDateInTz(s.start_time, tz);
  // Many nights end in the early hours of the next local day — that's the
  // morning wake we want. Skip nights that end the same local day they
  // started (very long nights or fragmented data).
  if (endDate === startDate) continue;
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

  const offDayMeta = offDayByDate.get(date);
  days.push({
    date,
    wakeTime: wake,
    ...(targetBedtime ? { target_bedtime: targetBedtime } : {}),
    ...(offDayMeta?.off_day === 1
      ? { off_day: 1 as const, off_day_reason: offDayMeta.off_day_reason ?? null }
      : {}),
    sleeps: daySleeps.map((s) => {
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

const json = JSON.stringify(days, null, 2);
if (outputPath) {
  await Bun.write(outputPath, json);
  console.error(`Wrote ${days.length} days to ${outputPath}`);
} else {
  console.log(json);
}
