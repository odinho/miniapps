import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db, resolveBaby } from "$lib/server/db.js";
import { parseIntParam } from "$lib/server/request-helpers.js";
import type { NightWakingRow } from "$lib/types.js";

export const GET: RequestHandler = ({ url }) => {
  const baby = resolveBaby(url);
  if (!baby) return json([]);

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const limit = parseIntParam(url, "limit", { default: 50, min: 1, max: 1000 }) ?? 50;
  let sql = "SELECT * FROM night_waking WHERE baby_id = ? AND deleted = 0";
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
  const wakings = db.prepare(sql).all(...params) as NightWakingRow[];

  return json(wakings);
};
