import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const dbPath = path.join(process.cwd(), 'napper.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Checkpoint after every page change — critical for low-write apps.
// Default (1000 pages) means WAL accumulates indefinitely with 2-3 writes/day,
// leaving the main .db file empty and all data only in the -wal file.
db.pragma('wal_autocheckpoint = 1');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    client_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS baby (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    birthdate TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS diaper_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    baby_id INTEGER NOT NULL REFERENCES baby(id),
    time TEXT NOT NULL,
    type TEXT NOT NULL,
    amount TEXT,
    note TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sleep_pauses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sleep_id INTEGER NOT NULL REFERENCES sleep_log(id),
    pause_time TEXT NOT NULL,
    resume_time TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS day_start (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    baby_id INTEGER NOT NULL REFERENCES baby(id),
    date TEXT NOT NULL,
    wake_time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(baby_id, date)
  );
`);

// Migrate: add columns if missing
try { db.exec('ALTER TABLE sleep_log ADD COLUMN mood TEXT'); } catch {}
try { db.exec('ALTER TABLE sleep_log ADD COLUMN method TEXT'); } catch {}
try { db.exec('ALTER TABLE sleep_log ADD COLUMN fall_asleep_time TEXT'); } catch {}
try { db.exec('ALTER TABLE sleep_log ADD COLUMN woke_by TEXT'); } catch {}
try { db.exec('ALTER TABLE sleep_log ADD COLUMN wake_notes TEXT'); } catch {}

/** Flush WAL to main DB file. Called after writes to ensure .db file has all data. */
export function checkpoint() {
  db.pragma('wal_checkpoint(PASSIVE)');
}

/** Full shutdown: checkpoint + close. Called on process exit. */
export function closeDb() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {}
}

export default db;
