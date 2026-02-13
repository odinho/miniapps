import db from './db.js';

export interface NapperEvent {
  id: number;
  type: string;
  payload: any;
  client_id: string | null;
  timestamp: string;
}

const insertStmt = db.prepare(
  'INSERT INTO events (type, payload, client_id) VALUES (?, ?, ?)'
);

const getEventsSinceStmt = db.prepare(
  'SELECT * FROM events WHERE id > ? ORDER BY id ASC'
);

const getAllEventsStmt = db.prepare(
  'SELECT * FROM events ORDER BY id ASC'
);

export function appendEvent(type: string, payload: any, clientId?: string): NapperEvent {
  const result = insertStmt.run(type, JSON.stringify(payload), clientId ?? null);
  return {
    id: result.lastInsertRowid as number,
    type,
    payload,
    client_id: clientId ?? null,
    timestamp: new Date().toISOString(),
  };
}

export function getEvents(since?: number): NapperEvent[] {
  const rows = since != null
    ? getEventsSinceStmt.all(since)
    : getAllEventsStmt.all();
  return (rows as any[]).map(r => ({
    ...r,
    payload: JSON.parse(r.payload),
  }));
}
