import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db, getCurrentBaby } from "$lib/server/db.js";
import { parseIntParam } from "$lib/server/request-helpers.js";
import type { SleepLogRow, SleepPauseRow } from "$lib/types.js";

export const GET: RequestHandler = ({ url }) => {
  const baby = getCurrentBaby();
  if (!baby) return json([]);

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const limit = parseIntParam(url, "limit", { default: 50, min: 1, max: 1000 }) ?? 50;
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
  params.push(limit);
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
