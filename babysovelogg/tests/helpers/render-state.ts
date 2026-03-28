import type { SqliteDb } from "$lib/server/db.js";
import type { SleepLogRow, DiaperLogRow, DayStartRow, Baby, SleepPauseRow } from "$lib/types.js";

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

  const dayStart = db
    .prepare("SELECT * FROM day_start WHERE baby_id = ? ORDER BY date DESC LIMIT 1")
    .get(babyId) as DayStartRow | undefined;

  const pauses = db
    .prepare("SELECT * FROM sleep_pauses ORDER BY pause_time")
    .all() as SleepPauseRow[];
  const pausesBySleep = new Map<number, SleepPauseRow[]>();
  for (const p of pauses) {
    if (!pausesBySleep.has(p.sleep_id)) pausesBySleep.set(p.sleep_id, []);
    pausesBySleep.get(p.sleep_id)!.push(p);
  }

  const lines: string[] = [];
  lines.push(`baby: ${baby.name} (${baby.birthdate})`);

  if (dayStart) {
    lines.push(`vekketid: ${fmtTime(dayStart.wake_time)}`);
  }

  const sleepLine =
    sleeps.length > 0
      ? sleeps.map((s) => renderSleep(s, pausesBySleep.get(s.id))).join(" | ")
      : "(ingen)";
  lines.push(`søvn: ${sleepLine}`);

  const diaperLine = diapers.length > 0 ? diapers.map(renderDiaper).join(" | ") : "(ingen)";
  lines.push(`bleier: ${diaperLine}`);

  return lines.join("\n");
}

/** Render the full event log as a compact summary. */
export function renderEventLog(db: SqliteDb): string {
  const events = db.prepare("SELECT type, payload, domain_id FROM events ORDER BY id").all() as {
    type: string;
    payload: string;
    domain_id: string | null;
  }[];

  if (events.length === 0) return "(ingen hendingar)";

  return events
    .map((e) => {
      const p = JSON.parse(e.payload);
      const parts = [e.type];
      if (e.domain_id) parts.push(e.domain_id);
      // Add key payload fields
      if (p.name) parts.push(p.name);
      if (p.type) parts.push(p.type);
      return parts.join(" ");
    })
    .join("\n");
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
    dayStarts: (db.prepare("SELECT COUNT(*) as c FROM day_start").get() as { c: number }).c,
  };
  return Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}

function renderSleep(s: SleepLogRow, pauses?: SleepPauseRow[]): string {
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
  if (s.mood) parts.push(s.mood);
  if (s.method) parts.push(s.method);
  return parts.join(" ");
}

function renderDiaper(d: DiaperLogRow): string {
  const parts = [fmtTime(d.time), d.type];
  if (d.amount) parts.push(d.amount);
  return parts.join(" ");
}

function fmtTime(iso: string): string {
  return iso.slice(11, 16); // HH:MM from ISO string
}
