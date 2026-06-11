/**
 * Shared loader: prod SQLite DB → backtest `DayRecord[]`.
 *
 * One canonical implementation for `db-to-fixture.ts`, `merge-fixtures.ts`,
 * and `backtest-report.ts --db`. Three copies had drifted apart and all
 * three carried the same two bugs:
 *   1. crashed on `sleep_pauses` (DROPped by the 2026-05-22 night_waking
 *      migration) — night wakings now live in `night_waking` and are netted
 *      out of night duration via `wakingsAsPausesForSleep`, the same helper
 *      prod uses, so fixture pause semantics match the engine exactly.
 *   2. stamped the baby's *current* `target_bedtime` uniformly across all
 *      history. Settings are event-sourced (`baby.updated`), so we walk that
 *      log and stamp the value that was actually in effect on each day.
 *
 * Day-boundary bucketing uses the baby's stored IANA timezone — a 21:00-local
 * sleep would otherwise land on the wrong calendar day wherever local midnight
 * isn't UTC midnight.
 */

import Database from "bun:sqlite";
import { isoToDateInTz } from "$lib/tz.js";
import { wakingsAsPausesForSleep } from "$lib/engine/state.js";
import type { DayRecord } from "$lib/engine/backtest.js";
import type { NightWakingRow } from "$lib/types.js";

export interface BabySettings {
  /** "HH:MM" local, or null when no manual bedtime target was set. */
  targetBedtime: string | null;
  /** Manual nap-count override, or null when the engine infers it. */
  customNapCount: number | null;
}

export interface SettingsChange {
  /** Local date (baby tz) this setting snapshot became effective, inclusive. */
  fromDate: string;
  settings: BabySettings;
}

export interface LoadedDb {
  days: DayRecord[];
  tz: string;
  birthdate: string | null;
  settingsTimeline: SettingsChange[];
}

const EMPTY_SETTINGS: BabySettings = { targetBedtime: null, customNapCount: null };

/** SQLite `datetime('now')` writes "YYYY-MM-DD HH:MM:SS" in UTC with no zone
 *  marker; `new Date()` would parse that as *local* time. Normalize to ISO-UTC
 *  before any tz math. Pass-through for values that already carry a zone. */
function eventIso(ts: string): string {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(ts)) return ts;
  return ts.replace(" ", "T") + "Z";
}

/**
 * Walk `baby.created` / `baby.updated` events into a settings timeline.
 * Each `baby.updated` payload is a full settings snapshot, so we just record
 * the value at each change. A change takes effect on the local date of its
 * event (inclusive); multiple changes on the same local date collapse to the
 * last (highest event id) — matching "the value the parent ended that day on."
 */
export function loadSettingsTimeline(db: Database, tz: string): SettingsChange[] {
  const rows = db
    .prepare(
      `SELECT id, payload, timestamp FROM events
       WHERE type IN ('baby.created', 'baby.updated')
       ORDER BY id ASC`,
    )
    .all() as { id: number; payload: string; timestamp: string }[];

  const byDate = new Map<string, BabySettings>();
  for (const r of rows) {
    let p: { targetBedtime?: string | null; customNapCount?: number | null };
    try {
      p = JSON.parse(r.payload);
    } catch {
      continue;
    }
    const settings: BabySettings = {
      targetBedtime:
        typeof p.targetBedtime === "string" && p.targetBedtime.length > 0
          ? p.targetBedtime
          : null,
      customNapCount:
        typeof p.customNapCount === "number" ? p.customNapCount : null,
    };
    byDate.set(isoToDateInTz(eventIso(r.timestamp), tz), settings);
  }

  return [...byDate.entries()]
    .map(([fromDate, settings]) => ({ fromDate, settings }))
    .toSorted((a, b) => a.fromDate.localeCompare(b.fromDate));
}

/** The settings in effect on `date` (the latest change with fromDate <= date). */
export function effectiveSettings(
  timeline: SettingsChange[],
  date: string,
): BabySettings {
  let result = EMPTY_SETTINGS;
  for (const c of timeline) {
    if (c.fromDate <= date) result = c.settings;
    else break;
  }
  return result;
}

interface SleepRow {
  id: number;
  start_time: string;
  end_time: string | null;
  type: string;
  woke_by: string | null;
}

/** Load a prod DB into backtest day records with historically-faithful
 *  per-day settings and night_waking-derived pauses. `tzOverride` forces a
 *  timezone (CLI `--tz`); otherwise the baby's stored timezone is used. */
export function dbToDays(dbPath: string, tzOverride?: string): LoadedDb {
  const db = new Database(dbPath, { readonly: true });

  const baby = db
    .prepare(`SELECT timezone, birthdate FROM baby ORDER BY id DESC LIMIT 1`)
    .get() as { timezone: string | null; birthdate: string | null } | undefined;
  const tz = tzOverride || baby?.timezone || "Europe/Oslo";

  const settingsTimeline = loadSettingsTimeline(db, tz);

  const sleeps = db
    .prepare(
      `SELECT id, start_time, end_time, type, woke_by
       FROM sleep_log WHERE deleted = 0 ORDER BY start_time`,
    )
    .all() as SleepRow[];

  const wakings = db
    .prepare(
      `SELECT * FROM night_waking WHERE deleted = 0 ORDER BY start_time ASC`,
    )
    .all() as NightWakingRow[];

  const dayStarts = db
    .prepare(
      `SELECT date, wake_time, off_day, off_day_reason FROM day_start ORDER BY date`,
    )
    .all() as {
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
      {
        off_day: d.off_day === 1 ? (1 as const) : (0 as const),
        off_day_reason: d.off_day_reason,
      },
    ]),
  );

  // Group sleeps by local start-date (tz-aware).
  const byDate = new Map<string, SleepRow[]>();
  for (const s of sleeps) {
    const date = isoToDateInTz(s.start_time, tz);
    const list = byDate.get(date) ?? [];
    list.push(s);
    byDate.set(date, list);
  }

  // Index night-ends by the local date the night *ended* on — mirrors prod's
  // `getState` rule (today's wake is yesterday's night end). Skip nights that
  // end the same local day they started.
  const nightEndByEndDate = new Map<string, string>();
  for (const s of sleeps) {
    if (s.type !== "night" || !s.end_time) continue;
    const endDate = isoToDateInTz(s.end_time, tz);
    const startDate = isoToDateInTz(s.start_time, tz);
    if (endDate === startDate) continue;
    const prev = nightEndByEndDate.get(endDate);
    if (!prev || s.end_time > prev) nightEndByEndDate.set(endDate, s.end_time);
  }

  const days: DayRecord[] = [];
  const allDates = new Set([...wakeByDate.keys(), ...byDate.keys()]);
  for (const date of [...allDates].sort()) {
    const daySleeps = byDate.get(date) ?? [];

    let wake = wakeByDate.get(date);
    if (!wake) {
      wake = nightEndByEndDate.get(date);
      if (!wake) continue; // no known wake time — skip
    }

    // Skip in-progress days — fixtures replay completed history only.
    if (daySleeps.some((s) => !s.end_time)) continue;

    const settings = effectiveSettings(settingsTimeline, date);
    const offDayMeta = offDayByDate.get(date);

    days.push({
      date,
      wakeTime: wake,
      ...(settings.targetBedtime ? { target_bedtime: settings.targetBedtime } : {}),
      ...(offDayMeta?.off_day === 1
        ? { off_day: 1 as const, off_day_reason: offDayMeta.off_day_reason ?? null }
        : {}),
      sleeps: daySleeps.map((s) => {
        const pauses = wakingsAsPausesForSleep(
          { id: s.id, start_time: s.start_time, end_time: s.end_time, type: s.type },
          wakings,
        );
        return {
          start_time: s.start_time,
          end_time: s.end_time!,
          type: s.type as "nap" | "night",
          woke_by: s.woke_by === "self" || s.woke_by === "woken" ? s.woke_by : null,
          ...(pauses.length > 0 ? { pauses } : {}),
        };
      }),
    });
  }

  return { days, tz, birthdate: baby?.birthdate ?? null, settingsTimeline };
}
