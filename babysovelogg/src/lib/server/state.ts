import { db } from "./db.js";
import { assembleState } from "$lib/engine/state.js";
import type { Baby, SleepLogRow, SleepPauseRow, DayStartRow } from "$lib/types.js";
import { todayInTz } from "$lib/tz.js";

export function getState() {
  const baby = db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as Baby | undefined;
  if (!baby)
    return { baby: null, activeSleep: null, todaySleeps: [], stats: null, prediction: null };

  let activeSleep = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND end_time IS NULL AND deleted = 0 ORDER BY id DESC LIMIT 1",
    )
    .get(baby.id) as SleepLogRow | undefined;

  if (activeSleep) {
    const pauses = db
      .prepare("SELECT * FROM sleep_pauses WHERE sleep_id = ? ORDER BY pause_time ASC")
      .all(activeSleep.id) as SleepPauseRow[];
    activeSleep = { ...activeSleep, pauses };
  }

  const tz = baby.timezone || "UTC";
  const { dateStr: todayDateStr, midnightIso } = todayInTz(tz);

  const todaySleeps = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time DESC",
    )
    .all(baby.id, midnightIso) as SleepLogRow[];

  let todayWakeUp = db
    .prepare("SELECT * FROM day_start WHERE baby_id = ? AND date = ?")
    .get(baby.id, todayDateStr) as DayStartRow | undefined;

  // Derive wakeup from overnight night sleep if no explicit day.started exists.
  if (!todayWakeUp) {
    const overnightSleep = db
      .prepare(
        "SELECT end_time FROM sleep_log WHERE baby_id = ? AND type = 'night' AND start_time < ? AND end_time >= ? AND deleted = 0 ORDER BY end_time DESC LIMIT 1",
      )
      .get(baby.id, midnightIso, midnightIso) as { end_time: string } | undefined;
    if (overnightSleep) {
      todayWakeUp = {
        baby_id: baby.id,
        date: todayDateStr,
        wake_time: overnightSleep.end_time,
        created_by_event_id: null,
      } as DayStartRow;
    }
  }

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const recentSleeps = db
    .prepare(
      "SELECT * FROM sleep_log WHERE baby_id = ? AND start_time >= ? AND deleted = 0 ORDER BY start_time DESC",
    )
    .all(baby.id, weekAgo) as SleepLogRow[];

  // Batch-fetch pauses for all today's sleeps (avoids N+1 query)
  const todaySleepIds = todaySleeps.map((s) => s.id);
  const pausesBySleep = new Map<number, SleepPauseRow[]>();
  if (todaySleepIds.length > 0) {
    const allPauses = db
      .prepare(
        `SELECT * FROM sleep_pauses WHERE sleep_id IN (${todaySleepIds.map(() => "?").join(",")}) ORDER BY pause_time ASC`,
      )
      .all(...todaySleepIds) as SleepPauseRow[];
    for (const p of allPauses) {
      if (!pausesBySleep.has(p.sleep_id)) pausesBySleep.set(p.sleep_id, []);
      pausesBySleep.get(p.sleep_id)!.push(p);
    }
  }

  const todayDiapers = db
    .prepare(
      "SELECT COUNT(*) as count FROM diaper_log WHERE baby_id = ? AND time >= ? AND deleted = 0",
    )
    .get(baby.id, midnightIso) as { count: number } | undefined;

  const lastDiaper = db
    .prepare(
      "SELECT time FROM diaper_log WHERE baby_id = ? AND deleted = 0 ORDER BY time DESC LIMIT 1",
    )
    .get(baby.id) as { time: string } | undefined;

  return assembleState({
    baby,
    activeSleep,
    todaySleeps,
    recentSleeps,
    todayWakeUp,
    pausesBySleep,
    diaperCount: todayDiapers?.count ?? 0,
    lastDiaperTime: lastDiaper?.time ?? null,
  });
}
