import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db, resolveBaby } from "$lib/server/db.js";
import { parseIntParam } from "$lib/server/request-helpers.js";
import type { SleepLogRow } from "$lib/types.js";

export const GET: RequestHandler = ({ url }) => {
  // `?baby=all` returns every child's rows (multi-baby log); otherwise a single
  // baby (explicit `?baby=<id>` or the newest by default).
  const allBabies = url.searchParams.get("baby") === "all";
  const baby = allBabies ? null : resolveBaby(url);
  if (!allBabies && !baby) return json([]);

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const limit = parseIntParam(url, "limit", { default: 50, min: 1, max: 1000 }) ?? 50;
  let sql = "SELECT * FROM sleep_log WHERE deleted = 0";
  const params: (string | number)[] = [];
  if (!allBabies) {
    sql += " AND baby_id = ?";
    params.push(baby!.id);
  }
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

  return json(sleeps);
};
