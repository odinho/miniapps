import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db.js";
import { processBatchTx, getEvents } from "$lib/server/events.js";
import { validateBatch } from "$lib/server/schemas.js";
import { getState } from "$lib/server/state.js";
import { broadcast } from "$lib/server/broadcast.js";
import type { EventRow } from "$lib/types.js";

export const GET: RequestHandler = ({ url }) => {
  const since = url.searchParams.get("since");
  const typeFilter = url.searchParams.get("type");
  const domainIdFilter = url.searchParams.get("domainId");
  const limit = url.searchParams.get("limit");
  const offset = url.searchParams.get("offset");

  // Simple path: just since filter
  if (!typeFilter && !domainIdFilter && !limit) {
    return json(getEvents(since ? parseInt(since) : undefined));
  }

  // Advanced query with filters and pagination
  let sql = "SELECT * FROM events WHERE 1=1";
  let countSql = "SELECT COUNT(*) as total FROM events WHERE 1=1";
  const params: (string | number)[] = [];
  const countParams: (string | number)[] = [];

  if (since) {
    sql += " AND id > ?";
    countSql += " AND id > ?";
    params.push(parseInt(since));
    countParams.push(parseInt(since));
  }
  if (typeFilter) {
    sql += " AND type = ?";
    countSql += " AND type = ?";
    params.push(typeFilter);
    countParams.push(typeFilter);
  }
  if (domainIdFilter) {
    sql += " AND domain_id = ?";
    countSql += " AND domain_id = ?";
    params.push(domainIdFilter);
    countParams.push(domainIdFilter);
  }

  const total = (db.prepare(countSql).get(...countParams) as { total: number }).total;

  sql += " ORDER BY id DESC";
  if (limit) {
    sql += " LIMIT ?";
    params.push(parseInt(limit));
  }
  if (offset) {
    sql += " OFFSET ?";
    params.push(parseInt(offset));
  }

  const rows = db.prepare(sql).all(...params) as EventRow[];
  const events = rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  return json({ events, total });
};

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();

    // Level 1+2 validation
    const validation = validateBatch(body);
    if (!validation.ok) {
      return json({ errors: validation.errors }, { status: 400 });
    }

    // Process all events in one transaction
    const results = processBatchTx(validation.events);

    const state = getState();
    // Only broadcast if at least one event was actually applied (not duplicate)
    if (results.some((r) => !r.duplicate)) {
      broadcast("update", { state });
    }
    return json({
      events: results.map((r) => ({ ...r.event, duplicate: r.duplicate })),
      state,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] POST /api/events:`, message);
    return json({ error: message }, { status: 500 });
  }
};
