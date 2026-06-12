import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { resolveBaby, getFamilyTimezone } from "$lib/server/db.js";
import { processBatchTx } from "$lib/server/events.js";
import { parseNapperCsv, mapNapperToEvents } from "$lib/server/import-napper.js";
import { getState } from "$lib/server/state.js";
import { broadcast } from "$lib/server/broadcast.js";

export const POST: RequestHandler = async ({ request, url }) => {
  try {
    const baby = resolveBaby(url);
    if (!baby) return json({ error: "No baby configured" }, { status: 404 });

    const csvBody = await request.text();
    const rows = parseNapperCsv(csvBody);
    const events = mapNapperToEvents(rows, baby.id, getFamilyTimezone());

    if (events.length > 0) {
      processBatchTx(events);
      broadcast("update", { state: getState() });
    }

    // Count what was imported
    let sleeps = 0;
    for (const e of events) {
      if (e.type === "sleep.manual" || e.type === "sleep.started") sleeps++;
    }
    const skipped = rows.filter(
      (r) => !["WOKE_UP", "NAP", "BED_TIME", "NIGHT_WAKING"].includes(r.category),
    ).length;

    return json({ sleeps, skipped, totalEvents: events.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ERROR] POST /api/import/napper:", message);
    return json({ error: message }, { status: 400 });
  }
};
