/**
 * Local SQLite database for persisting tool state.
 * Stores decisions, undo history, and session tracking.
 * Separate from Immich — this is our own state.
 */
import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { mkdirSync } from "fs";

export interface StoredDecision {
  groupId: string;
  keep: string[];
  cull: string[];
  skipped: boolean;
  selectedIndex: number;
  decidedAt: string;
}

export interface SessionStats {
  sessionId: string;
  startedAt: string;
  groupsReviewed: number;
  groupsSkipped: number;
  photosKept: number;
  photosCulled: number;
}

export class StateDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        group_id TEXT PRIMARY KEY,
        keep_ids TEXT NOT NULL,          -- JSON array of asset IDs
        cull_ids TEXT NOT NULL,          -- JSON array of asset IDs
        skipped INTEGER NOT NULL DEFAULT 0,
        selected_index INTEGER NOT NULL DEFAULT 0,
        decided_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS undo_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        prev_keep_ids TEXT,             -- JSON array, null if no prior decision
        prev_cull_ids TEXT,
        prev_skipped INTEGER,
        prev_selected_index INTEGER,
        undone INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_group_index INTEGER NOT NULL DEFAULT 0,
        groups_reviewed INTEGER NOT NULL DEFAULT 0,
        groups_skipped INTEGER NOT NULL DEFAULT 0,
        photos_kept INTEGER NOT NULL DEFAULT 0,
        photos_culled INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  // === Decisions ===

  getDecision(groupId: string): StoredDecision | null {
    const row = this.db.prepare(
      "SELECT group_id, keep_ids, cull_ids, skipped, selected_index, decided_at FROM decisions WHERE group_id = ?"
    ).get(groupId) as any;
    if (!row) return null;
    return {
      groupId: row.group_id,
      keep: JSON.parse(row.keep_ids),
      cull: JSON.parse(row.cull_ids),
      skipped: row.skipped === 1,
      selectedIndex: row.selected_index,
      decidedAt: row.decided_at,
    };
  }

  getAllDecisions(): Map<string, StoredDecision> {
    const rows = this.db.prepare(
      "SELECT group_id, keep_ids, cull_ids, skipped, selected_index, decided_at FROM decisions"
    ).all() as any[];
    const map = new Map<string, StoredDecision>();
    for (const row of rows) {
      map.set(row.group_id, {
        groupId: row.group_id,
        keep: JSON.parse(row.keep_ids),
        cull: JSON.parse(row.cull_ids),
        skipped: row.skipped === 1,
        selectedIndex: row.selected_index,
        decidedAt: row.decided_at,
      });
    }
    return map;
  }

  saveDecision(groupId: string, keep: string[], cull: string[], skipped: boolean, selectedIndex: number) {
    // Save previous state for undo
    const prev = this.getDecision(groupId);
    this.db.prepare(`
      INSERT INTO undo_log (group_id, prev_keep_ids, prev_cull_ids, prev_skipped, prev_selected_index)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      groupId,
      prev ? JSON.stringify(prev.keep) : null,
      prev ? JSON.stringify(prev.cull) : null,
      prev ? (prev.skipped ? 1 : 0) : null,
      prev ? prev.selectedIndex : null,
    );

    this.db.prepare(`
      INSERT INTO decisions (group_id, keep_ids, cull_ids, skipped, selected_index, decided_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(group_id) DO UPDATE SET
        keep_ids = excluded.keep_ids,
        cull_ids = excluded.cull_ids,
        skipped = excluded.skipped,
        selected_index = excluded.selected_index,
        updated_at = datetime('now')
    `).run(groupId, JSON.stringify(keep), JSON.stringify(cull), skipped ? 1 : 0, selectedIndex);
  }

  deleteDecision(groupId: string) {
    this.db.prepare("DELETE FROM decisions WHERE group_id = ?").run(groupId);
  }

  /** Pop the last undo entry for a group and restore the previous decision (or delete if none). */
  undo(groupId: string): { previousSelectedIndex: number | null } {
    const entry = this.db.prepare(
      "SELECT id, prev_keep_ids, prev_cull_ids, prev_skipped, prev_selected_index FROM undo_log WHERE group_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1"
    ).get(groupId) as any;
    if (!entry) return { previousSelectedIndex: null };

    // Mark as undone
    this.db.prepare("UPDATE undo_log SET undone = 1 WHERE id = ?").run(entry.id);

    if (entry.prev_keep_ids === null) {
      // No prior decision existed — delete
      this.deleteDecision(groupId);
    } else {
      // Restore previous
      this.db.prepare(`
        INSERT INTO decisions (group_id, keep_ids, cull_ids, skipped, selected_index, decided_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(group_id) DO UPDATE SET
          keep_ids = excluded.keep_ids, cull_ids = excluded.cull_ids,
          skipped = excluded.skipped, selected_index = excluded.selected_index,
          updated_at = datetime('now')
      `).run(groupId, entry.prev_keep_ids, entry.prev_cull_ids, entry.prev_skipped, entry.prev_selected_index);
    }

    return { previousSelectedIndex: entry.prev_selected_index };
  }

  // === Stats ===

  getStats(): { decided: number; skipped: number; photosKept: number; photosCulled: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as decided,
        SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END) as skipped,
        0 as photos_kept,
        0 as photos_culled
      FROM decisions
    `).get() as any;

    // Count individual photos
    const keepCull = this.db.prepare(`
      SELECT
        SUM(json_array_length(keep_ids)) as kept,
        SUM(json_array_length(cull_ids)) as culled
      FROM decisions WHERE skipped = 0
    `).get() as any;

    return {
      decided: row.decided,
      skipped: row.skipped,
      photosKept: keepCull.kept || 0,
      photosCulled: keepCull.culled || 0,
    };
  }

  close() {
    this.db.close();
  }
}
