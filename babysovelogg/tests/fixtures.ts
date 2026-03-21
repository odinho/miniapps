import { test as base, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "path";

export function getDb() {
  return new Database(path.join(process.cwd(), "db.sqlite"));
}

export function resetDb() {
  const db = getDb();
  try {
    db.prepare("DELETE FROM sleep_pauses").run();
  } catch {}
  try {
    db.prepare("DELETE FROM diaper_log").run();
  } catch {}
  try {
    db.prepare("DELETE FROM sleep_log").run();
  } catch {}
  try {
    db.prepare("DELETE FROM day_start").run();
  } catch {}
  try {
    db.prepare("DELETE FROM baby").run();
  } catch {}
  try {
    db.prepare("DELETE FROM events").run();
  } catch {}
  // Reset autoincrement counters so rebuild produces matching IDs
  try {
    db.prepare("DELETE FROM sqlite_sequence").run();
  } catch {}
  db.close();
}

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

export function createBaby(name = "Testa", birthdate = "2025-06-12"): number {
  const db = getDb();
  const clientId = generateId();
  const clientEventId = generateId();
  db.prepare(
    "INSERT INTO events (type, payload, client_id, client_event_id) VALUES ('baby.created', ?, ?, ?)",
  ).run(JSON.stringify({ name, birthdate }), clientId, clientEventId);
  const info = db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run(name, birthdate);
  db.close();
  return Number(info.lastInsertRowid);
}

export function setWakeUpTime(babyId: number, wakeTime?: Date) {
  const db = getDb();
  const wake = wakeTime || new Date();
  wake.setHours(7, 0, 0, 0);
  const dateStr = wake.toISOString().split("T")[0];
  db.prepare("INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)").run(
    babyId,
    dateStr,
    wake.toISOString(),
  );
  db.close();
}

export function addCompletedSleep(
  babyId: number,
  startTime: string,
  endTime: string,
  type = "nap",
  domainId?: string,
) {
  const db = getDb();
  const did = domainId || generateSleepId();
  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id) VALUES (?, ?, ?, ?, ?)",
  ).run(babyId, startTime, endTime, type, did);
  db.close();
  return did;
}

export function addActiveSleep(babyId: number, startTime: string, type = "nap", domainId?: string) {
  const db = getDb();
  const did = domainId || generateSleepId();
  db.prepare("INSERT INTO sleep_log (baby_id, start_time, type, domain_id) VALUES (?, ?, ?, ?)").run(
    babyId,
    startTime,
    type,
    did,
  );
  db.close();
  return did;
}

export function addDiaper(
  babyId: number,
  time: string,
  type = "wet",
  amount = "middels",
  domainId?: string,
) {
  const db = getDb();
  const did = domainId || generateDiaperId();
  db.prepare(
    "INSERT INTO diaper_log (baby_id, time, type, amount, domain_id) VALUES (?, ?, ?, ?, ?)",
  ).run(babyId, time, type, amount, did);
  db.close();
  return did;
}

export function seedBabyWithSleep() {
  const db = getDb();
  const clientId = generateId();
  const clientEventId = generateId();
  db.prepare(
    "INSERT INTO events (type, payload, client_id, client_event_id) VALUES ('baby.created', ?, ?, ?)",
  ).run(JSON.stringify({ name: "Testa", birthdate: "2025-06-12" }), clientId, clientEventId);
  db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run("Testa", "2025-06-12");
  const babyId = db.prepare("SELECT id FROM baby LIMIT 1").get() as { id: number };
  const now = new Date();
  const start = new Date(now.getTime() - 3600000).toISOString();
  const end = now.toISOString();
  const domainId = generateSleepId();
  db.prepare(
    "INSERT INTO sleep_log (baby_id, start_time, end_time, type, domain_id) VALUES (?, ?, ?, 'nap', ?)",
  ).run(babyId.id, start, end, domainId);
  db.close();
}

/** Custom test that auto-resets DB before each test */
export const test = base.extend<{ autoResetDb: void }>({
  // eslint-disable-next-line no-empty-pattern
  autoResetDb: [
    async ({}, use) => {
      resetDb();
      await use();
    },
    { auto: true },
  ],
});

/** Force morning hours (8 AM) in the browser so morning prompt and day theme work at any time */
export async function forceMorning(page: Page) {
  await page.addInitScript(() => {
    Date.prototype.getHours = function () {
      return 8;
    };
  });
}

/** Force a specific hour in the browser for time-dependent tests */
export async function forceHour(page: Page, hour: number) {
  await page.addInitScript((h: number) => {
    Date.prototype.getHours = function () {
      return h;
    };
  }, hour);
}

/** Dismiss any visible modal sheet (tag sheet or wake-up sheet) by clicking "Ferdig" */
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

/** Helper to generate IDs for tests */
export { generateId, generateSleepId, generateDiaperId };

export { expect };
