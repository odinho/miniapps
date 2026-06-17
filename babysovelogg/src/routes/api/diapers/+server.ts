import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db, resolveBaby } from "$lib/server/db.js";
import { parseIntParam } from "$lib/server/request-helpers.js";

export const GET: RequestHandler = ({ url }) => {
  const allBabies = url.searchParams.get("baby") === "all";
  const baby = allBabies ? null : resolveBaby(url);
  if (!allBabies && !baby) return json([]);

  const from = url.searchParams.get("from");
  // See /api/sleeps: high cap so full-history stats reads aren't truncated.
  const limit = parseIntParam(url, "limit", { default: 50, min: 1, max: 100000 }) ?? 50;
  let sql = "SELECT * FROM diaper_log WHERE deleted = 0";
  const params: (string | number)[] = [];
  if (!allBabies) {
    sql += " AND baby_id = ?";
    params.push(baby!.id);
  }
  if (from) {
    sql += " AND time >= ?";
    params.push(from);
  }
  sql += " ORDER BY time DESC LIMIT ?";
  params.push(limit);

  return json(db.prepare(sql).all(...params));
};
