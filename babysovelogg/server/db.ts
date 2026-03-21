import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "db.sqlite");

const db = new Database(dbPath);
// DELETE journal mode (SQLite default): writes go straight to the .db file.
// No -wal/-shm files to manage, backup = copy one file.
// WAL is pointless here — single server, 2-3 writes/day, no concurrent write pressure.
db.pragma("journal_mode = DELETE");
db.pragma("foreign_keys = ON");

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
try {
  db.exec("ALTER TABLE sleep_log ADD COLUMN mood TEXT");
} catch {}
try {
  db.exec("ALTER TABLE sleep_log ADD COLUMN method TEXT");
} catch {}
try {
  db.exec("ALTER TABLE sleep_log ADD COLUMN fall_asleep_time TEXT");
} catch {}
try {
  db.exec("ALTER TABLE sleep_log ADD COLUMN woke_by TEXT");
} catch {}
try {
  db.exec("ALTER TABLE sleep_log ADD COLUMN wake_notes TEXT");
} catch {}
try {
  db.exec("ALTER TABLE baby ADD COLUMN custom_nap_count INTEGER");
} catch {}
try {
  db.exec("ALTER TABLE baby ADD COLUMN potty_mode INTEGER DEFAULT 0");
} catch {}
try {
  db.exec("ALTER TABLE events ADD COLUMN client_event_id TEXT");
} catch {}
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_client_event_id ON events(client_event_id) WHERE client_event_id IS NOT NULL");
} catch {}

/** Clean shutdown. Called on process exit. */
export function closeDb() {
  try {
    db.close();
  } catch {}
}

export default db;
