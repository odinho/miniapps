import { createServer, type Server } from "http";
import { beforeAll, afterAll, beforeEach } from "vitest";
import { initDb, db as _db, closeDb } from "../../server/db.js";
import { handleRequest } from "../../server/api.js";

// Re-export the live db binding for direct use in tests
export { db } from "../../server/db.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  initDb(":memory:");
  server = createServer(handleRequest);
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

beforeEach(() => {
  _db.prepare("DELETE FROM sleep_pauses").run();
  _db.prepare("DELETE FROM diaper_log").run();
  _db.prepare("DELETE FROM sleep_log").run();
  _db.prepare("DELETE FROM day_start").run();
  _db.prepare("DELETE FROM baby").run();
  _db.prepare("DELETE FROM events").run();
  try {
    _db.prepare("DELETE FROM sqlite_sequence").run();
  } catch {}
});

// --- HTTP helpers ---

export async function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function get(path: string) {
  return fetch(`${baseUrl}${path}`);
}

export async function postEvents(events: Record<string, unknown>[]) {
  return post("/api/events", { events });
}

export async function postCsv(path: string, body: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body,
  });
}

// --- ID generation ---

const EPOCH = new Date("2026-01-01T00:00:00Z").getTime();
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function generateId(prefix = "evt"): string {
  const timePart = Math.abs(Math.floor((Date.now() - EPOCH) / 1000)).toString(36);
  let random = "";
  for (let i = 0; i < 6; i++) random += BASE62[Math.floor(Math.random() * 62)];
  return `${prefix}_${timePart}${random}`;
}

export function generateSleepId(): string {
  return generateId("slp");
}

export function generateDiaperId(): string {
  return generateId("dip");
}

// --- Seed helpers (use shared in-memory db directly) ---

export function createBaby(name = "Testa", birthdate = "2025-06-12"): number {
  _db
    .prepare(
      "INSERT INTO events (type, payload, client_id, client_event_id) VALUES ('baby.created', ?, ?, ?)",
    )
    .run(JSON.stringify({ name, birthdate }), generateId(), generateId());
  const info = _db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run(name, birthdate);
  return Number(info.lastInsertRowid);
}

export function setWakeUpTime(babyId: number, wakeTime?: Date) {
  const wake = wakeTime || new Date();
  wake.setHours(7, 0, 0, 0);
  const dateStr = wake.toISOString().split("T")[0];
  _db
    .prepare("INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)")
    .run(babyId, dateStr, wake.toISOString());
}

/** Timezone-safe version that takes explicit ISO strings for deterministic snapshots. */
export function setWakeUpTimeUTC(babyId: number, date: string, wakeTimeISO: string) {
  _db
    .prepare("INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)")
    .run(babyId, date, wakeTimeISO);
}

export function addCompletedSleep(
  babyId: number,
  startTime: string,
  endTime: string,
  type = "nap",
  domainId?: string,
) {
  const did = domainId || generateSleepId();
  _db
    .prepare(
      "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id) VALUES (?, ?, ?, ?, ?)",
    )
    .run(babyId, startTime, endTime, type, did);
  return did;
}

export function addDiaper(
  babyId: number,
  time: string,
  type = "wet",
  amount = "middels",
  domainId?: string,
) {
  const did = domainId || generateDiaperId();
  _db
    .prepare(
      "INSERT INTO diaper_log (baby_id, time, type, amount, domain_id) VALUES (?, ?, ?, ?, ?)",
    )
    .run(babyId, time, type, amount, did);
  return did;
}

/** Create an event envelope with auto-generated IDs. */
export function makeEvent(type: string, payload: Record<string, unknown>) {
  return { type, payload, clientId: "test", clientEventId: generateId() };
}
