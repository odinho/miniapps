import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { beforeAll, afterAll, beforeEach } from "vitest";
import { db, initDb, closeDb } from "$lib/server/db.js";

// Import SvelteKit route handlers
import { GET as eventsGET, POST as eventsPOST } from "../../src/routes/api/events/+server.js";
import { GET as stateGET } from "../../src/routes/api/state/+server.js";
import { GET as sleepsGET } from "../../src/routes/api/sleeps/+server.js";
import { GET as diapersGET } from "../../src/routes/api/diapers/+server.js";
import { GET as wakeupsGET } from "../../src/routes/api/wakeups/+server.js";
import { GET as exportGET } from "../../src/routes/api/export/+server.js";
import { POST as importNapperPOST } from "../../src/routes/api/import/napper/+server.js";
import { POST as adminRebuildPOST } from "../../src/routes/api/admin/rebuild/+server.js";

// Re-export db for direct use in tests
export { db } from "$lib/server/db.js";

// Route table mapping paths to handlers
type Handler = (event: { request: Request; url: URL; params: Record<string, string> }) => Response | Promise<Response>;
const routes: { pattern: string; GET?: Handler; POST?: Handler }[] = [
  { pattern: "/api/events", GET: eventsGET as Handler, POST: eventsPOST as Handler },
  { pattern: "/api/state", GET: stateGET as Handler },
  { pattern: "/api/sleeps", GET: sleepsGET as Handler },
  { pattern: "/api/diapers", GET: diapersGET as Handler },
  { pattern: "/api/wakeups", GET: wakeupsGET as Handler },
  { pattern: "/api/export", GET: exportGET as Handler },
  { pattern: "/api/import/napper", POST: importNapperPOST as Handler },
  { pattern: "/api/admin/rebuild", POST: adminRebuildPOST as Handler },
];

// Convert Node IncomingMessage → Web Request
async function toWebRequest(req: IncomingMessage, baseUrl: string): Promise<Request> {
  const url = new URL(req.url!, baseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    init.body = Buffer.concat(chunks).toString();
  }

  return new Request(url.toString(), init);
}

// Convert Web Response → Node ServerResponse
async function sendWebResponse(webRes: Response, nodeRes: ServerResponse) {
  nodeRes.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => nodeRes.setHeader(key, value));
  const body = await webRes.arrayBuffer();
  nodeRes.end(Buffer.from(body));
}

// Mini-router
async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const baseUrl = "http://localhost";
  const url = new URL(req.url!, baseUrl);
  const pathname = url.pathname;

  const route = routes.find((r) => pathname === r.pattern);
  if (!route) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `Not found: ${pathname}` }));
    return;
  }

  const method = req.method as "GET" | "POST";
  const handler = route[method];
  if (!handler) {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    const webReq = await toWebRequest(req, baseUrl);
    const webRes = await handler({ request: webReq, url, params: {} });
    await sendWebResponse(webRes, res);
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(err) }));
  }
}

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
  db.prepare("DELETE FROM sleep_pauses").run();
  db.prepare("DELETE FROM diaper_log").run();
  db.prepare("DELETE FROM sleep_log").run();
  db.prepare("DELETE FROM day_start").run();
  db.prepare("DELETE FROM baby").run();
  db.prepare("DELETE FROM events").run();
  try {
    db.prepare("DELETE FROM sqlite_sequence").run();
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
  db.prepare(
    "INSERT INTO events (type, payload, client_id, client_event_id) VALUES ('baby.created', ?, ?, ?)",
  ).run(JSON.stringify({ name, birthdate }), generateId(), generateId());
  const info = db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run(name, birthdate);
  return Number(info.lastInsertRowid);
}

export function setWakeUpTime(babyId: number, wakeTime?: Date) {
  const wake = wakeTime || new Date();
  wake.setHours(7, 0, 0, 0);
  const dateStr = wake.toISOString().split("T")[0];
  db.prepare("INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)").run(
    babyId,
    dateStr,
    wake.toISOString(),
  );
}

/** Timezone-safe version that takes explicit ISO strings for deterministic snapshots. */
export function setWakeUpTimeUTC(babyId: number, date: string, wakeTimeISO: string) {
  db.prepare("INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)").run(
    babyId,
    date,
    wakeTimeISO,
  );
}

export function addCompletedSleep(
  babyId: number,
  startTime: string,
  endTime: string,
  type = "nap",
  domainId?: string,
) {
  const did = domainId || generateSleepId();
  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id) VALUES (?, ?, ?, ?, ?)",
  ).run(babyId, startTime, endTime, type, did);
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
  db.prepare(
    "INSERT INTO diaper_log (baby_id, time, type, amount, domain_id) VALUES (?, ?, ?, ?, ?)",
  ).run(babyId, time, type, amount, did);
  return did;
}

/** Create an event envelope with auto-generated IDs. */
export function makeEvent(type: string, payload: Record<string, unknown>) {
  return { type, payload, clientId: "test", clientEventId: generateId() };
}
