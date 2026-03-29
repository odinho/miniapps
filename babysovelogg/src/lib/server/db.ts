import { Database as BunDatabase } from "bun:sqlite";
import path from "path";

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

  // Migration: add timezone column to existing baby tables
  try {
    database.exec("ALTER TABLE baby ADD COLUMN timezone TEXT");
  } catch {
    // Column already exists — ignore
  }

  // Migration: merge "happy" mood into "normal"
  database.exec("UPDATE sleep_log SET mood = 'normal' WHERE mood = 'happy'");

  database.exec(`
    CREATE TABLE IF NOT EXISTS day_start (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baby_id INTEGER NOT NULL REFERENCES baby(id),
      date TEXT NOT NULL,
      wake_time TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by_event_id INTEGER,
      UNIQUE(baby_id, date)
    );
  `);
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

// Auto-initialize for production
initDb();
