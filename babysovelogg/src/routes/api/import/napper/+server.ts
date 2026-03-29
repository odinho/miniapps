import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db.js";
import { processBatchTx } from "$lib/server/events.js";
import { parseNapperCsv, mapNapperToEvents } from "$lib/server/import-napper.js";
import { getState } from "$lib/server/state.js";
import { broadcast } from "$lib/server/broadcast.js";
import type { Baby } from "$lib/types.js";

export const POST: RequestHandler = async ({ request }) => {
  try {
    const baby = db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as Baby | undefined;
    if (!baby) return json({ error: "No baby configured" }, { status: 404 });

    const csvBody = await request.text();
    const rows = parseNapperCsv(csvBody);
    const events = mapNapperToEvents(rows, baby.id);

    if (events.length > 0) {
      processBatchTx(events);
      broadcast("update", { state: getState() });
    }

    // Count what was imported
    let sleeps = 0;
    let dayStarts = 0;
    for (const e of events) {
      if (e.type === "sleep.manual" || e.type === "sleep.started") sleeps++;
      if (e.type === "day.started") dayStarts++;
    }
    const skipped = rows.filter(
      (r) => !["WOKE_UP", "NAP", "BED_TIME", "NIGHT_WAKING"].includes(r.category),
    ).length;

    return json({ sleeps, dayStarts, skipped, totalEvents: events.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] POST /api/import/napper:`, message);
    return json({ error: message }, { status: 400 });
  }
};
