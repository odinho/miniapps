import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { db, initDb, closeDb } from "$lib/server/db.js";
import { cleanAll } from "../helpers/clean.js";

// ── Console guard ──────────────────────────────────────────────────────
// All console methods are captured during tests. Any call that doesn't
// match a declared expectation fails the test in afterEach.
// Bypass with: DEBUG=1 bun test …

const _debug = !!process.env.DEBUG;

const _orig = {
  log: console.log,
  info: console.info,
  error: console.error,
  warn: console.warn,
};

type Level = "log" | "info" | "error" | "warn";

const _captured: Record<Level, string[]> = { log: [], info: [], error: [], warn: [] };
const _expected: Record<Level, RegExp[]> = { log: [], info: [], error: [], warn: [] };

function toRegExp(pattern: string | RegExp): RegExp {
  return typeof pattern === "string" ? new RegExp(pattern) : pattern;
}

function stringify(args: unknown[]): string {
  return args.map(String).join(" ");
}

export function expectConsoleError(pattern: string | RegExp) {
  _expected.error.push(toRegExp(pattern));
}

function checkLevel(level: Level) {
  const captured = _captured[level];
  const expected = _expected[level];

  const unmatched = captured.filter((msg) => !expected.some((re) => re.test(msg)));
  if (unmatched.length > 0) {
    throw new Error(
      [
        `Unexpected console.${level} during test:`,
        ...unmatched.map((m) => `  ${m}`),
        ``,
        `Debugging? Run with: DEBUG=1 bun test …`,
      ].join("\n"),
    );
  }
  const unused = expected.filter((re) => !captured.some((msg) => re.test(msg)));
  if (unused.length > 0) {
    throw new Error(
      `Expected console.${level} never fired:\n  ${unused.map((r) => r.source).join("\n  ")}`,
    );
  }
}

function installConsoleGuard() {
  beforeEach(() => {
    for (const lvl of ["log", "info", "error", "warn"] as Level[]) {
      _captured[lvl] = [];
      _expected[lvl] = [];
      console[lvl] = (...args: unknown[]) => {
        _captured[lvl].push(stringify(args));
        if (_debug) _orig[lvl](...args);
      };
    }
  });

  afterEach(() => {
    for (const lvl of ["log", "info", "error", "warn"] as Level[]) {
      console[lvl] = _orig[lvl];
    }
    if (!_debug) {
      for (const lvl of ["log", "info", "error", "warn"] as Level[]) {
        checkLevel(lvl);
      }
    }
  });
}

// Import SvelteKit route handlers
import { GET as eventsGET, POST as eventsPOST } from "../../src/routes/api/events/+server.js";
import { GET as stateGET } from "../../src/routes/api/state/+server.js";
import { GET as sleepsGET } from "../../src/routes/api/sleeps/+server.js";
import { GET as diapersGET } from "../../src/routes/api/diapers/+server.js";
import { GET as nightWakingsGET } from "../../src/routes/api/night-wakings/+server.js";
import { GET as wakeupsGET } from "../../src/routes/api/wakeups/+server.js";
import { GET as exportGET } from "../../src/routes/api/export/+server.js";
import { POST as importNapperPOST } from "../../src/routes/api/import/napper/+server.js";
import { POST as adminRebuildPOST } from "../../src/routes/api/admin/rebuild/+server.js";
import { GET as vapidKeyGET } from "../../src/routes/api/notifications/vapid-key/+server.js";
import {
  POST as notifSubscribePOST,
  DELETE as notifSubscribeDELETE,
} from "../../src/routes/api/notifications/subscribe/+server.js";
import {
  GET as notifPrefsGET,
  PUT as notifPrefsPUT,
} from "../../src/routes/api/notifications/preferences/+server.js";

// Re-export db for direct use in tests
export { db } from "$lib/server/db.js";

// Route table mapping paths to handlers
type Handler = (event: { request: Request; url: URL; params: Record<string, string> }) => Response | Promise<Response>;
const routes: {
  pattern: string;
  GET?: Handler;
  POST?: Handler;
  PUT?: Handler;
  DELETE?: Handler;
}[] = [
  { pattern: "/api/events", GET: eventsGET as Handler, POST: eventsPOST as Handler },
  { pattern: "/api/state", GET: stateGET as Handler },
  { pattern: "/api/sleeps", GET: sleepsGET as Handler },
  { pattern: "/api/diapers", GET: diapersGET as Handler },
  { pattern: "/api/night-wakings", GET: nightWakingsGET as Handler },
  { pattern: "/api/wakeups", GET: wakeupsGET as Handler },
  { pattern: "/api/export", GET: exportGET as Handler },
  { pattern: "/api/import/napper", POST: importNapperPOST as Handler },
  { pattern: "/api/admin/rebuild", POST: adminRebuildPOST as Handler },
  { pattern: "/api/notifications/vapid-key", GET: vapidKeyGET as Handler },
  {
    pattern: "/api/notifications/subscribe",
    POST: notifSubscribePOST as Handler,
    DELETE: notifSubscribeDELETE as Handler,
  },
  {
    pattern: "/api/notifications/preferences",
    GET: notifPrefsGET as Handler,
    PUT: notifPrefsPUT as Handler,
  },
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

  const method = req.method as "GET" | "POST" | "PUT" | "DELETE";
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

/** Register lifecycle hooks for integration tests. Call this at the top level of each test file. */
export function setupHarness() {
  installConsoleGuard();

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
    cleanAll(db);
  });
}

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

export async function del(path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function put(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

export function generateNightWakingId(): string {
  return generateId("nwk");
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
  // Insert a completed overnight night sleep so wakeup is derived from its end_time
  const nightStart = new Date(wake);
  nightStart.setDate(nightStart.getDate() - 1);
  nightStart.setHours(19, 0, 0, 0);
  const did = generateId("slp");
  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id) VALUES (?, ?, ?, 'night', ?)",
  ).run(babyId, nightStart.toISOString(), wake.toISOString(), did);
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

export function addNightWaking(
  babyId: number,
  startTime: string,
  endTime: string | null = null,
  domainId?: string,
) {
  const did = domainId || generateNightWakingId();
  db.prepare(
    "INSERT INTO night_waking (baby_id, start_time, end_time, domain_id) VALUES (?, ?, ?, ?)",
  ).run(babyId, startTime, endTime, did);
  return did;
}

/** Create an event envelope with auto-generated IDs. */
export function makeEvent(type: string, payload: Record<string, unknown>) {
  return { type, payload, clientId: "test", clientEventId: generateId() };
}
