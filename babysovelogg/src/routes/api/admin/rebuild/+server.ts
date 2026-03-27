import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { rebuildAll } from "$lib/server/projections.js";

export const POST: RequestHandler = () => {
  try {
    const report = rebuildAll();
    return json(report, { status: report.success ? 200 : 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] POST /api/admin/rebuild:`, message);
    return json({ error: message }, { status: 500 });
  }
};
