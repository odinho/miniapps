import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db.js";
import type { Baby } from "$lib/types.js";

export const GET: RequestHandler = ({ url }) => {
  const baby = db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as Baby | undefined;
  if (!baby) return json([]);

  const limitParam = url.searchParams.get("limit") || "50";

  // Derive wakeups from night sleep end times
  const wakeups = db
    .prepare(
      "SELECT baby_id, end_time as wake_time FROM sleep_log WHERE baby_id = ? AND type = 'night' AND end_time IS NOT NULL AND deleted = 0 ORDER BY end_time DESC LIMIT ?",
    )
    .all(baby.id, parseInt(limitParam));

  return json(wakeups);
};
