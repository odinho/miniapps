import type { SqliteDb } from "$lib/server/db.js";
import type {
  SleepLogRow,
  DiaperLogRow,
  Baby,
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

  // Night wakings (first-class events that replaced the legacy
  // sleep_pauses table). Group them per parent sleep by overlap so
  // renderSleep can fold them in.
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
      ? sleeps.map((s) => renderSleep(s, wakingsInSleep(wakings, s))).join(" | ")
      : "(ingen)";
  lines.push(`søvn: ${sleepLine}`);

  const diaperLine = diapers.length > 0 ? diapers.map(renderDiaper).join(" | ") : "(ingen)";
  lines.push(`bleier: ${diaperLine}`);

  return lines.join("\n");
}

interface NotificationScheduleRow {
  baby_id: number;
  kind: string;
  fire_at: string;
  dedupe_key: string;
  payload_json: string | null;
  sent_at: string | null;
  cancelled_at: string | null;
  attempts: number;
}

/**
 * Render the notification_schedule table as a deterministic, readable block.
 * One line per row, sorted by (kind, fire_at, dedupe_key). Status and attempts
 * are only shown when non-default so the common "pending, 0 attempts" case
 * stays compact. Pass `kind` to scope to a single notification type.
 */
export function renderSchedule(db: SqliteDb, kind?: string): string {
  const rows = (
    kind
      ? db.prepare("SELECT * FROM notification_schedule WHERE kind = ?").all(kind)
      : db.prepare("SELECT * FROM notification_schedule").all()
  ) as NotificationScheduleRow[];

  if (rows.length === 0) return "(ingen)";

  rows.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.fire_at.localeCompare(b.fire_at) ||
      a.dedupe_key.localeCompare(b.dedupe_key),
  );

  return rows
    .map((r) => {
      const parts = [`${r.kind} @ ${r.fire_at}`, `baby:${r.baby_id}`, `key:${r.dedupe_key}`];
      const status = r.cancelled_at ? "cancelled" : r.sent_at ? "sent" : "pending";
      if (status !== "pending") parts.push(status);
      if (r.attempts) parts.push(`attempts:${r.attempts}`);
      if (r.payload_json) {
        const title = (JSON.parse(r.payload_json) as { title?: string }).title;
        if (title) parts.push(`"${title}"`);
      }
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
    nightWakings: (
      db.prepare("SELECT COUNT(*) as c FROM night_waking WHERE deleted = 0").get() as { c: number }
    ).c,
  };
  return Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}

function renderSleep(
  s: SleepLogRow,
  wakings?: NightWakingRow[],
): string {
  const time = s.end_time
    ? `${fmtTime(s.start_time)}–${fmtTime(s.end_time)}`
    : `${fmtTime(s.start_time)}–pågår`;
  const parts = [time, s.type === "night" ? "natt" : "lur"];
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
