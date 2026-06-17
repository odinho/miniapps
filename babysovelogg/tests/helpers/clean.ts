import type { SqliteDb } from "$lib/server/db.js";

/**
 * Reset all projection/event tables to a clean slate. Shared by the
 * integration harness (`beforeEach`) and the Playwright/bun fixtures
 * (`resetDb`) so the two can never drift.
 *
 * FK enforcement is disabled for the duration so rows can be deleted in
 * any order — notification_* tables reference baby(id), so deleting baby
 * first would otherwise fail whenever those rows exist.
 */
export function cleanAll(db: SqliteDb): void {
  db.exec("PRAGMA foreign_keys = OFF");

  // The night-waking migration test re-creates sleep_pauses inline; drop it
  // defensively so leftovers don't bleed across tests.
  db.exec("DROP TABLE IF EXISTS sleep_pauses");

  db.prepare("DELETE FROM notification_schedule").run();
  db.prepare("DELETE FROM notification_subscriptions").run();
  db.prepare("DELETE FROM notification_preferences").run();
  db.prepare("DELETE FROM night_waking").run();
  db.prepare("DELETE FROM diaper_log").run();
  db.prepare("DELETE FROM sleep_log").run();
  db.prepare("DELETE FROM day_start").run();
  db.prepare("DELETE FROM baby").run();
  db.prepare("DELETE FROM events").run();

  // Reset the singleton family row — timezone / mode_override / sync_mode
  // would otherwise leak between tests.
  db.prepare(
    "UPDATE family SET timezone = NULL, mode_override = NULL, sync_mode = NULL, updated_by_event_id = NULL WHERE id = 1",
  ).run();

  // sqlite_sequence may not exist if no AUTOINCREMENT table has been written yet.
  try {
    db.prepare("DELETE FROM sqlite_sequence").run();
  } catch {
    // no AUTOINCREMENT rows yet — nothing to reset
  }

  db.exec("PRAGMA foreign_keys = ON");
}
