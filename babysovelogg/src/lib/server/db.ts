import { Database as BunDatabase } from "bun:sqlite";
import path from "path";
import type { Baby } from "$lib/types.js";

/** Minimal SQLite interface matching the subset used by this app. */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T, A extends unknown[]>(fn: (...args: A) => T): (...args: A) => T;
  close(): void;
}

export let db: SqliteDb;

/** Idempotently add a column. SQLite errors on duplicate ADD COLUMN; treat
 *  that case as a successful no-op so initSchema can run on every boot. */
function tryAddColumn(database: SqliteDb, table: string, column: string, type: string) {
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch {
    // Column already exists — ignore.
  }
}

function initSchema(database: SqliteDb) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_event_id TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      schema_version INTEGER,
      correlation_id TEXT,
      caused_by_event_id INTEGER,
      domain_id TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_client_dedup
      ON events(client_id, client_event_id);

    CREATE INDEX IF NOT EXISTS idx_events_domain_id
      ON events(domain_id) WHERE domain_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS baby (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      birthdate TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      custom_nap_count INTEGER,
      potty_mode INTEGER DEFAULT 0,
      timezone TEXT,
      created_by_event_id INTEGER,
      updated_by_event_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS sleep_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baby_id INTEGER NOT NULL REFERENCES baby(id),
      start_time TEXT NOT NULL,
      end_time TEXT,
      type TEXT NOT NULL DEFAULT 'nap',
      notes TEXT,
      mood TEXT,
      method TEXT,
      fall_asleep_time TEXT,
      woke_by TEXT,
      wake_notes TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      domain_id TEXT NOT NULL,
      created_by_event_id INTEGER,
      updated_by_event_id INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_sleep_log_domain_id ON sleep_log(domain_id);

    CREATE TABLE IF NOT EXISTS diaper_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baby_id INTEGER NOT NULL REFERENCES baby(id),
      time TEXT NOT NULL,
      type TEXT NOT NULL,
      amount TEXT,
      note TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      domain_id TEXT NOT NULL,
      created_by_event_id INTEGER,
      updated_by_event_id INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_diaper_log_domain_id ON diaper_log(domain_id);
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS sleep_pauses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sleep_id INTEGER NOT NULL REFERENCES sleep_log(id),
      pause_time TEXT NOT NULL,
      resume_time TEXT,
      created_by_event_id INTEGER
    );
  `);

  // Migrations: add late-added columns idempotently.
  tryAddColumn(database, "baby", "timezone", "TEXT");
  tryAddColumn(database, "baby", "target_bedtime", "TEXT");
  tryAddColumn(database, "sleep_log", "onset_note", "TEXT");
  tryAddColumn(database, "sleep_log", "wake_mood", "TEXT");

  // Migration: merge "happy" mood into "normal"
  database.exec("UPDATE sleep_log SET mood = 'normal' WHERE mood = 'happy'");

  // Migration: simplify latency buckets (4→3, aligned with Galland 2012)
  database.exec("UPDATE sleep_log SET fall_asleep_time = '5-20' WHERE fall_asleep_time = '5-15'");
  database.exec("UPDATE sleep_log SET fall_asleep_time = '20+' WHERE fall_asleep_time IN ('15-30', '30+')");

  database.exec(`
    CREATE TABLE IF NOT EXISTS day_start (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baby_id INTEGER NOT NULL REFERENCES baby(id),
      date TEXT NOT NULL,
      wake_time TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by_event_id INTEGER,
      off_day INTEGER NOT NULL DEFAULT 0,
      off_day_reason TEXT,
      UNIQUE(baby_id, date)
    );
  `);

  // Migration: add off_day flag for sick/travel/spurt days. Trend math
  // skips flagged days so a worst week doesn't pull recommendations sideways.
  tryAddColumn(database, "day_start", "off_day", "INTEGER NOT NULL DEFAULT 0");
  tryAddColumn(database, "day_start", "off_day_reason", "TEXT");

  database.exec(`
    CREATE TABLE IF NOT EXISTS notification_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baby_id INTEGER NOT NULL REFERENCES baby(id),
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_agent TEXT
    );

    CREATE TABLE IF NOT EXISTS notification_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baby_id INTEGER NOT NULL REFERENCES baby(id),
      kind TEXT NOT NULL,
      fire_at TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      payload_json TEXT,
      sent_at TEXT,
      cancelled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_notif_schedule_due
      ON notification_schedule(fire_at) WHERE sent_at IS NULL AND cancelled_at IS NULL;

    CREATE TABLE IF NOT EXISTS notification_preferences (
      baby_id INTEGER PRIMARY KEY REFERENCES baby(id),
      prefs_json TEXT NOT NULL DEFAULT '{}'
    );

    -- Persisted nap-budget mode for hysteresis. Without it "established"
    -- self-terminates after ~30 days when mean30 catches up to mean7.
    CREATE TABLE IF NOT EXISTS nap_budget_state (
      baby_id INTEGER PRIMARY KEY REFERENCES baby(id),
      mode TEXT NOT NULL,
      entered_at TEXT NOT NULL
    );

    -- Held intervention target for trend ratchet. Sibling of
    -- nap_budget_state so mode hysteresis and target holding evolve
    -- independently. Target lifts/drops driven by classifyTrendDay
    -- (natural vs policy-affected) and slow-drift rules in trend.ts.
    CREATE TABLE IF NOT EXISTS trend_target_state (
      baby_id INTEGER PRIMARY KEY REFERENCES baby(id),
      target_min REAL NOT NULL,
      baseline_min REAL NOT NULL,
      source TEXT NOT NULL,
      confidence TEXT NOT NULL,
      natural_support_streak INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);

  // Per-row attempt counter so transient push failures retry a small
  // number of times before being abandoned (see notification-scheduler).
  tryAddColumn(database, "notification_schedule", "attempts", "INTEGER NOT NULL DEFAULT 0");
}

/** Initialize (or re-initialize) the database. Defaults to file-based db.sqlite. */
export function initDb(dbPath?: string): SqliteDb {
  if (db) try { db.close(); } catch {}
  const finalPath = dbPath ?? process.env.DB_PATH ?? path.join(process.cwd(), "db.sqlite");
  db = new BunDatabase(finalPath) as unknown as SqliteDb;
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("PRAGMA foreign_keys = ON");
  if (finalPath !== ":memory:") {
    db.exec("PRAGMA busy_timeout = 5000");
  }
  initSchema(db);
  return db;
}

/** Clean shutdown. Called on process exit. */
export function closeDb() {
  try {
    db?.close();
  } catch {}
}

/** Return the most-recently-created baby, or undefined if none exists. The
 *  app is currently single-baby; route handlers and the state assembler all
 *  read "the current baby" via this query. */
export function getCurrentBaby(): Baby | undefined {
  return db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as Baby | undefined;
}

// Auto-initialize for production
initDb();
