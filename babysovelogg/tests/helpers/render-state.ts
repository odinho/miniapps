import type { SqliteDb } from "$lib/server/db.js";
import type {
  SleepLogRow,
  DiaperLogRow,
  Baby,
  SleepPauseRow,
  NightWakingRow,
} from "$lib/types.js";

/** Render a compact, readable summary of a baby's current day state from the DB. */
export function renderDayState(db: SqliteDb, babyId: number): string {
  const baby = db.prepare("SELECT * FROM baby WHERE id = ?").get(babyId) as Baby | undefined;
  if (!baby) return "(no baby)";

  const sleeps = db
    .prepare("SELECT * FROM sleep_log WHERE baby_id = ? AND deleted = 0 ORDER BY start_time")
    .all(babyId) as SleepLogRow[];

  const diapers = db
    .prepare("SELECT * FROM diaper_log WHERE baby_id = ? AND deleted = 0 ORDER BY time")
    .all(babyId) as DiaperLogRow[];

  // Derive wakeup from last completed night sleep end_time
  const lastNight = db
    .prepare("SELECT end_time FROM sleep_log WHERE baby_id = ? AND type = 'night' AND end_time IS NOT NULL AND deleted = 0 ORDER BY end_time DESC LIMIT 1")
    .get(babyId) as { end_time: string } | undefined;

  const pauses = db
    .prepare("SELECT * FROM sleep_pauses ORDER BY pause_time")
    .all() as SleepPauseRow[];
  const pausesBySleep = new Map<number, SleepPauseRow[]>();
  for (const p of pauses) {
    if (!pausesBySleep.has(p.sleep_id)) pausesBySleep.set(p.sleep_id, []);
    pausesBySleep.get(p.sleep_id)!.push(p);
  }

  // Night wakings (first-class events that replace pauses on night sleeps).
  // Group them per parent sleep by overlap so renderSleep can fold them in.
  const wakings = db
    .prepare(
      "SELECT * FROM night_waking WHERE baby_id = ? AND deleted = 0 ORDER BY start_time",
    )
    .all(babyId) as NightWakingRow[];

  const lines: string[] = [];
  lines.push(`baby: ${baby.name} (${baby.birthdate})`);

  if (lastNight) {
    lines.push(`vekketid: ${fmtTime(lastNight.end_time)}`);
  }

  const sleepLine =
    sleeps.length > 0
      ? sleeps.map((s) => renderSleep(s, pausesBySleep.get(s.id), wakingsInSleep(wakings, s))).join(" | ")
      : "(ingen)";
  lines.push(`søvn: ${sleepLine}`);

  const diaperLine = diapers.length > 0 ? diapers.map(renderDiaper).join(" | ") : "(ingen)";
  lines.push(`bleier: ${diaperLine}`);

  return lines.join("\n");
}

/** Render projection row counts — useful for rebuild tests. */
export function renderCounts(db: SqliteDb): string {
  const counts = {
    events: (db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }).c,
    sleeps: (
      db.prepare("SELECT COUNT(*) as c FROM sleep_log WHERE deleted = 0").get() as { c: number }
    ).c,
    diapers: (
      db.prepare("SELECT COUNT(*) as c FROM diaper_log WHERE deleted = 0").get() as { c: number }
    ).c,
    pauses: (db.prepare("SELECT COUNT(*) as c FROM sleep_pauses").get() as { c: number }).c,
  };
  return Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}

function renderSleep(
  s: SleepLogRow,
  pauses?: SleepPauseRow[],
  wakings?: NightWakingRow[],
): string {
  const time = s.end_time
    ? `${fmtTime(s.start_time)}–${fmtTime(s.end_time)}`
    : `${fmtTime(s.start_time)}–pågår`;
  const parts = [time, s.type === "night" ? "natt" : "lur"];
  if (pauses && pauses.length > 0) {
    const pauseMin = Math.round(
      pauses.reduce((sum, p) => {
        const start = new Date(p.pause_time).getTime();
        const end = p.resume_time ? new Date(p.resume_time).getTime() : Date.now();
        return sum + (end - start);
      }, 0) / 60000,
    );
    parts.push(`${pauses.length} pause (${pauseMin}m)`);
  }
  if (wakings && wakings.length > 0) {
    const wakingMin = Math.round(
      wakings.reduce((sum, w) => {
        const start = new Date(w.start_time).getTime();
        const end = w.end_time ? new Date(w.end_time).getTime() : Date.now();
        return sum + (end - start);
      }, 0) / 60000,
    );
    parts.push(`${wakings.length} vakning (${wakingMin}m)`);
  }
  if (s.mood) parts.push(s.mood);
  if (s.method) parts.push(s.method);
  if (s.fall_asleep_time) parts.push(`innsov:${s.fall_asleep_time}`);
  if (s.woke_by) parts.push(`vekt:${s.woke_by}`);
  if (s.notes) parts.push(`"${s.notes}"`);
  if (s.wake_notes) parts.push(`vaknenotat:"${s.wake_notes}"`);
  return parts.join(" ");
}

function wakingsInSleep(all: NightWakingRow[], s: SleepLogRow): NightWakingRow[] {
  const startMs = new Date(s.start_time).getTime();
  const endMs = s.end_time ? new Date(s.end_time).getTime() : Date.now();
  return all.filter((w) => {
    const ws = new Date(w.start_time).getTime();
    return ws >= startMs && ws < endMs;
  });
}

function renderDiaper(d: DiaperLogRow): string {
  const parts = [fmtTime(d.time), d.type];
  if (d.amount) parts.push(d.amount);
  if (d.note) parts.push(`"${d.note}"`);
  return parts.join(" ");
}

function fmtTime(iso: string): string {
  return iso.slice(11, 16); // HH:MM from ISO string
}
