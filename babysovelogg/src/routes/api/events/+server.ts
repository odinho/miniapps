import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db.js";
import { processBatchTx, getEvents } from "$lib/server/events.js";
import { validateBatch } from "$lib/server/schemas.js";
import { getState } from "$lib/server/state.js";
import { broadcast } from "$lib/server/broadcast.js";
import { reconcileNotifications, fireDueNotifications } from "$lib/server/notification-scheduler.js";
import { parseIntParam, safeJson } from "$lib/server/request-helpers.js";
import type { EventRow } from "$lib/types.js";

export const GET: RequestHandler = ({ url }) => {
  const since = parseIntParam(url, "since", { min: 0 });
  const typeFilter = url.searchParams.get("type");
  const domainIdFilter = url.searchParams.get("domainId");
  const limit = parseIntParam(url, "limit", { min: 1, max: 10_000 });
  const offset = parseIntParam(url, "offset", { min: 0 });

  // Simple path: no filters, no pagination → bypass the count query.
  if (!typeFilter && !domainIdFilter && limit == null && offset == null) {
    return json(getEvents(since));
  }

  // Advanced query with filters and pagination
  let sql = "SELECT * FROM events WHERE 1=1";
  let countSql = "SELECT COUNT(*) as total FROM events WHERE 1=1";
  const params: (string | number)[] = [];
  const countParams: (string | number)[] = [];

  if (since != null) {
    sql += " AND id > ?";
    countSql += " AND id > ?";
    params.push(since);
    countParams.push(since);
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
  // SQLite requires LIMIT when OFFSET is present; emit LIMIT -1 (no cap) when
  // the caller supplied an offset but not a limit.
  if (limit != null || offset != null) {
    sql += " LIMIT ?";
    params.push(limit ?? -1);
  }
  if (offset != null) {
    sql += " OFFSET ?";
    params.push(offset);
  }

  const rows = db.prepare(sql).all(...params) as EventRow[];
  const events = rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  return json({ events, total });
};

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await safeJson(request);
    if (body == null) {
      return json({ error: "invalid_json" }, { status: 400 });
    }

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
      try {
        // Reconcile every baby's slice, not just the top-level alias —
        // otherwise the non-newest child never gets notifications scheduled.
        for (const slice of state.babies) reconcileNotifications(slice);
        // Fire any newly-due notifications (e.g. continuation-window opens
        // immediately on cut-short logging) without waiting on web-push so
        // the HTTP response stays fast. The 30s poll loop is a safety net.
        fireDueNotifications().catch((err) => {
          console.error("[fireDueNotifications]", err);
        });
      } catch (err) {
        console.error("[reconcileNotifications]", err);
      }
    }
    return json({
      events: results.map((r) => ({ ...r.event, duplicate: r.duplicate })),
      state,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ERROR] POST /api/events:", message);
    return json({ error: message }, { status: 500 });
  }
};
