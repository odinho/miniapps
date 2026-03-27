import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db.js";
import type { Baby, DayStartRow } from "$lib/types.js";

export const GET: RequestHandler = ({ url }) => {
  const baby = db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as Baby | undefined;
  if (!baby) return json([]);

  const limitParam = url.searchParams.get("limit") || "50";
  const wakeups = db
    .prepare("SELECT * FROM day_start WHERE baby_id = ? ORDER BY date DESC LIMIT ?")
    .all(baby.id, parseInt(limitParam)) as DayStartRow[];

  return json(wakeups);
};
