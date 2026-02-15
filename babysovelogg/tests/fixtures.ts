import { test as base, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'path';

export function getDb() {
  return new Database(path.join(process.cwd(), 'napper.db'));
}

export function resetDb() {
  const db = getDb();
  try { db.prepare('DELETE FROM sleep_pauses').run(); } catch {}
  try { db.prepare('DELETE FROM diaper_log').run(); } catch {}
  try { db.prepare('DELETE FROM sleep_log').run(); } catch {}
  try { db.prepare('DELETE FROM day_start').run(); } catch {}
  try { db.prepare('DELETE FROM baby').run(); } catch {}
  try { db.prepare('DELETE FROM events').run(); } catch {}
  db.close();
}

export function createBaby(name = 'Testa', birthdate = '2025-06-12'): number {
  const db = getDb();
  db.prepare("INSERT INTO events (type, payload) VALUES ('baby.created', ?)").run(JSON.stringify({ name, birthdate }));
  const info = db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run(name, birthdate);
  db.close();
  return Number(info.lastInsertRowid);
}

export function setWakeUpTime(babyId: number, wakeTime?: Date) {
  const db = getDb();
  const wake = wakeTime || new Date();
  wake.setHours(7, 0, 0, 0);
  const dateStr = wake.toISOString().split('T')[0];
  db.prepare("INSERT INTO day_start (baby_id, date, wake_time) VALUES (?, ?, ?)").run(
    babyId, dateStr, wake.toISOString()
  );
  db.close();
}

export function addCompletedSleep(babyId: number, startTime: string, endTime: string, type = 'nap') {
  const db = getDb();
  db.prepare("INSERT INTO sleep_log (baby_id, start_time, end_time, type) VALUES (?, ?, ?, ?)").run(babyId, startTime, endTime, type);
  db.close();
}

export function addActiveSleep(babyId: number, startTime: string, type = 'nap') {
  const db = getDb();
  db.prepare("INSERT INTO sleep_log (baby_id, start_time, type) VALUES (?, ?, ?)").run(babyId, startTime, type);
  db.close();
}

export function seedBabyWithSleep() {
  const db = getDb();
  db.prepare("INSERT INTO events (type, payload) VALUES ('baby.created', ?)").run(JSON.stringify({ name: 'Testa', birthdate: '2025-06-12' }));
  db.prepare("INSERT INTO baby (name, birthdate) VALUES (?, ?)").run('Testa', '2025-06-12');
  const babyId = db.prepare('SELECT id FROM baby LIMIT 1').get() as any;
  const now = new Date();
  const start = new Date(now.getTime() - 3600000).toISOString();
  const end = now.toISOString();
  db.prepare("INSERT INTO sleep_log (baby_id, start_time, end_time, type) VALUES (?, ?, ?, 'nap')").run(babyId.id, start, end);
  db.close();
}

/** Custom test that auto-resets DB before each test */
export const test = base.extend<{ autoResetDb: void }>({
  autoResetDb: [async ({}, use) => {
    resetDb();
    await use();
  }, { auto: true }],
});

export { expect };
