import { test as base, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "http";
import { initDb, closeDb } from "../server/db.js";
import { handleRequest } from "../server/api.js";
import type Database from "better-sqlite3";

let _db: Database.Database;

// Worker-scoped fixture: one in-process server per Playwright worker
export const test = base.extend<
  { autoResetDb: void; autoMorning: void },
  { workerServer: { server: Server; baseURL: string } }
>({
  workerServer: [
    async ({}, use) => {
      _db = initDb(":memory:");
      const server = createServer(handleRequest);
      await new Promise<void>((resolve) => {
        server.listen(0, () => resolve());
      });
      const { port } = server.address() as { port: number };
      await use({ server, baseURL: `http://localhost:${port}` });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeDb();
    },
    { scope: "worker" },
  ],

  baseURL: async ({ workerServer }, use) => {
    await use(workerServer.baseURL);
  },

  autoResetDb: [
    async ({ workerServer }, use) => {
      void workerServer; // ensure in-memory DB is ready
      resetDb();
      await use();
    },
    { auto: true },
  ],
  autoMorning: [
    async ({ page }, use) => {
      await forceMorning(page);
      await use();
    },
    { auto: true },
  ],
});

// --- DB helpers (use shared in-memory DB directly) ---

/** Returns the shared in-process DB instance. Do NOT close it. */
export function getDb() {
  return _db;
}

export function resetDb() {
  try { _db.prepare("DELETE FROM sleep_pauses").run(); } catch {}
  try { _db.prepare("DELETE FROM diaper_log").run(); } catch {}
  try { _db.prepare("DELETE FROM sleep_log").run(); } catch {}
  try { _db.prepare("DELETE FROM day_start").run(); } catch {}
  try { _db.prepare("DELETE FROM baby").run(); } catch {}
  try { _db.prepare("DELETE FROM events").run(); } catch {}
  try { _db.prepare("DELETE FROM sqlite_sequence").run(); } catch {}
}

// --- ID generation ---

const EPOCH = new Date("2026-01-01T00:00:00Z").getTime();
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function generateId(prefix = "evt"): string {
  const timePart = Math.abs(Math.floor((Date.now() - EPOCH) / 1000)).toString(36);
  let random = "";
  for (let i = 0; i < 6; i++) random += BASE62[Math.floor(Math.random() * 62)];
  return `${prefix}_${timePart}${random}`;
}

function generateSleepId(): string {
  return generateId("slp");
}

function generateDiaperId(): string {
  return generateId("dip");
}

// --- Seed helpers ---

export function createBaby(name = "Testa", birthdate = "2025-06-12"): number {
  const clientId = generateId();
  const clientEventId = generateId();
  _db
    .prepare(
      "INSERT INTO events (type, payload, client_id, client_event_id) VALUES ('baby.created', ?, ?, ?)",
    )
    .run(JSON.stringify({ name, birthdate }), clientId, clientEventId);
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

export function addActiveSleep(babyId: number, startTime: string, type = "nap", domainId?: string) {
  const did = domainId || generateSleepId();
  _db
    .prepare("INSERT INTO sleep_log (baby_id, start_time, type, domain_id) VALUES (?, ?, ?, ?)")
    .run(babyId, startTime, type, did);
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

export function enablePottyMode(babyId: number) {
  _db.prepare("UPDATE baby SET potty_mode = 1 WHERE id = ?").run(babyId);
}

export function seedBabyWithSleep() {
  const clientId = generateId();
  const clientEventId = generateId();
  _db
    .prepare(
      "INSERT INTO events (type, payload, client_id, client_event_id) VALUES ('baby.created', ?, ?, ?)",
    )
    .run(JSON.stringify({ name: "Testa", birthdate: "2025-06-12" }), clientId, clientEventId);
  _db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run("Testa", "2025-06-12");
  const babyId = _db.prepare("SELECT id FROM baby LIMIT 1").get() as { id: number };
  const now = new Date();
  const start = new Date(now.getTime() - 3600000).toISOString();
  const end = now.toISOString();
  const domainId = generateSleepId();
  _db
    .prepare(
      "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id) VALUES (?, ?, ?, 'nap', ?)",
    )
    .run(babyId.id, start, end, domainId);
}

export function addEvent(type: string, payload: Record<string, unknown>) {
  _db
    .prepare(
      "INSERT INTO events (type, payload, client_id, client_event_id) VALUES (?, ?, ?, ?)",
    )
    .run(type, JSON.stringify(payload), generateId(), generateId());
}

/** Create an event envelope with auto-generated IDs. */
export function makeEvent(type: string, payload: Record<string, unknown>) {
  return { type, payload, clientId: "test", clientEventId: generateId() };
}

/** POST events to /api/events via Playwright page.request. */
export function postEvents(
  page: import("@playwright/test").Page,
  events: Record<string, unknown>[],
) {
  return page.request.post("/api/events", { data: { events } });
}

// --- Browser helpers ---

/** Force morning hours (8 AM) in the browser */
export async function forceMorning(page: Page) {
  await page.addInitScript(() => {
    Date.prototype.getHours = function () {
      return 8;
    };
  });
}

/** Force a specific hour in the browser */
export async function forceHour(page: Page, hour: number) {
  await page.addInitScript((h: number) => {
    Date.prototype.getHours = function () {
      return h;
    };
  }, hour);
}

/** Dismiss any visible modal sheet by clicking "Ferdig" */
export async function dismissSheet(page: Page) {
  const overlay = page.getByTestId("modal-overlay");
  try {
    await overlay.waitFor({ state: "visible", timeout: 3000 });
    await page.getByRole("button", { name: "Ferdig" }).click();
    await overlay.waitFor({ state: "hidden", timeout: 3000 });
  } catch {
    // No sheet visible, that's fine
  }
}

export { generateId, generateSleepId, generateDiaperId };

export { expect };
