import db from "./db.js";
import type { EventRow } from "../types.js";

export interface AppEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  client_id: string | null;
  timestamp: string;
}

const insertStmt = db.prepare(
  "INSERT INTO events (type, payload, client_id, client_event_id) VALUES (?, ?, ?, ?)",
);

const checkDupStmt = db.prepare(
  "SELECT id FROM events WHERE client_event_id = ?",
);

const getEventsSinceStmt = db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC");

const getAllEventsStmt = db.prepare("SELECT * FROM events ORDER BY id ASC");

export function appendEvent(
  type: string,
  payload: Record<string, unknown>,
  clientId?: string,
  clientEventId?: string,
): AppEvent | null {
  // Deduplicate: if clientEventId already exists, skip
  if (clientEventId) {
    const existing = checkDupStmt.get(clientEventId) as { id: number } | undefined;
    if (existing) {
      return null; // Duplicate — already processed
    }
  }

  const result = insertStmt.run(
    type,
    JSON.stringify(payload),
    clientId ?? null,
    clientEventId ?? null,
  );
  return {
    id: result.lastInsertRowid as number,
    type,
    payload,
    client_id: clientId ?? null,
    timestamp: new Date().toISOString(),
  };
}

export function getEvents(since?: number): AppEvent[] {
  const rows = since != null ? getEventsSinceStmt.all(since) : getAllEventsStmt.all();
  return (rows as EventRow[]).map(
    (r) => Object.assign(r, { payload: JSON.parse(r.payload) }) as unknown as AppEvent,
  );
}
