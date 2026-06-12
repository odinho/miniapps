import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db, resolveBaby } from "$lib/server/db.js";
import { parseIntParam } from "$lib/server/request-helpers.js";

export const GET: RequestHandler = ({ url }) => {
  const baby = resolveBaby(url);
  if (!baby) return json([]);

  const from = url.searchParams.get("from");
  const limit = parseIntParam(url, "limit", { default: 50, min: 1, max: 1000 }) ?? 50;
  let sql = "SELECT * FROM diaper_log WHERE baby_id = ? AND deleted = 0";
  const params: (string | number)[] = [baby.id];
  if (from) {
    sql += " AND time >= ?";
    params.push(from);
  }
  sql += " ORDER BY time DESC LIMIT ?";
  params.push(limit);

  return json(db.prepare(sql).all(...params));
};
