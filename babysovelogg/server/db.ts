import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const dbPath = path.join(process.cwd(), 'napper.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

// Migrate: add mood/method columns if missing
try { db.exec('ALTER TABLE sleep_log ADD COLUMN mood TEXT'); } catch {}
try { db.exec('ALTER TABLE sleep_log ADD COLUMN method TEXT'); } catch {}

export default db;
