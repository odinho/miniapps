import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db.js";
import type { Baby, SleepLogRow, SleepPauseRow } from "$lib/types.js";

export const GET: RequestHandler = ({ url }) => {
  const baby = db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as Baby | undefined;
  if (!baby) return json([]);

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const limitParam = url.searchParams.get("limit") || "50";
  let sql = "SELECT * FROM sleep_log WHERE baby_id = ? AND deleted = 0";
  const params: (string | number)[] = [baby.id];
  if (from) {
    sql += " AND start_time >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND start_time <= ?";
    params.push(to);
  }
  sql += " ORDER BY start_time DESC LIMIT ?";
  params.push(parseInt(limitParam));
  const sleeps = db.prepare(sql).all(...params) as SleepLogRow[];

  // Batch-fetch pauses for all returned sleeps
  const sleepIds = sleeps.map((s) => s.id);
  if (sleepIds.length > 0) {
    const allPauses = db
      .prepare(
        `SELECT * FROM sleep_pauses WHERE sleep_id IN (${sleepIds.map(() => "?").join(",")}) ORDER BY pause_time ASC`,
      )
      .all(...sleepIds) as SleepPauseRow[];
    const grouped = new Map<number, SleepPauseRow[]>();
    for (const p of allPauses) {
      if (!grouped.has(p.sleep_id)) grouped.set(p.sleep_id, []);
      grouped.get(p.sleep_id)!.push(p);
    }
    for (const s of sleeps) {
      s.pauses = grouped.get(s.id) || [];
    }
  } else {
    for (const s of sleeps) s.pauses = [];
  }

  return json(sleeps);
};
