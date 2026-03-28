import { db } from "./db.js";
import { applyEvent } from "./projections.js";
import type { EventRow } from "$lib/types.js";

export interface AppEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  client_id: string;
  client_event_id: string;
  timestamp: string;
  schema_version: number | null;
  correlation_id: string | null;
  caused_by_event_id: number | null;
  domain_id: string | null;
}

export interface ProcessedEvent {
  event: AppEvent;
  duplicate: boolean;
}

function rowToAppEvent(row: EventRow): AppEvent {
  return {
    ...row,
    payload: JSON.parse(row.payload),
  } as unknown as AppEvent;
}

/**
 * Process an entire batch of events inside one transaction.
 * Dedup check → append → project for each event.
 * If any projection fails, the entire batch rolls back.
 */
export function processBatchTx(
  events: {
    type: string;
    payload: Record<string, unknown>;
    clientId: string;
    clientEventId: string;
  }[],
): ProcessedEvent[] {
  return db.transaction(
    (
      evts: typeof events,
    ): ProcessedEvent[] => {
      const results: ProcessedEvent[] = [];
      for (const { type, payload, clientId, clientEventId } of evts) {
        // dedup check on (clientId, clientEventId)
        const existing = db
          .prepare("SELECT id FROM events WHERE client_id = ? AND client_event_id = ?")
          .get(clientId, clientEventId) as { id: number } | undefined;
        if (existing) {
          const row = db.prepare("SELECT * FROM events WHERE id = ?").get(existing.id) as EventRow;
          results.push({ event: rowToAppEvent(row), duplicate: true });
          continue;
        }
        // extract domain_id from payload
        const domainId =
          (payload.sleepDomainId as string) ?? (payload.diaperDomainId as string) ?? null;
        // insert
        const result = db
          .prepare(
            "INSERT INTO events (type, payload, client_id, client_event_id, domain_id) VALUES (?, ?, ?, ?, ?)",
          )
          .run(type, JSON.stringify(payload), clientId, clientEventId, domainId);
        const event: AppEvent = {
          id: result.lastInsertRowid as number,
          type,
          payload,
          client_id: clientId,
          client_event_id: clientEventId,
          timestamp: new Date().toISOString(),
          schema_version: null,
          correlation_id: null,
          caused_by_event_id: null,
          domain_id: domainId,
        };
        // project — if this throws, the ENTIRE batch rolls back
        applyEvent(event);
        results.push({ event, duplicate: false });
      }
      return results;
    },
  )(events);
}

export function getEvents(since?: number): AppEvent[] {
  const rows =
    since != null
      ? db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC").all(since)
      : db.prepare("SELECT * FROM events ORDER BY id ASC").all();
  return (rows as EventRow[]).map(rowToAppEvent);
}
