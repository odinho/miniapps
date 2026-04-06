/**
 * Local SQLite database for persisting tool state.
 * Stores decisions, undo history, and (future) LLM results.
 * Separate from Immich — this is our own state.
 */
import Database from "better-sqlite3";
import { dirname } from "path";
import { mkdirSync } from "fs";
import { createHash } from "crypto";

export interface StoredDecision {
  groupId: string;
  keep: string[];
  cull: string[];
  skipped: boolean;
  selectedIndex: number;
  decidedAt: string;
}

const SCHEMA_VERSION = 3;

export class StateDb {
  private db: Database.Database;
  saveDecision: (groupId: string, keep: string[], cull: string[], skipped: boolean, selectedIndex: number) => void;
  undo: (groupId: string) => { previousSelectedIndex: number | null };

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.saveDecision = this._initSaveDecision();
    this.undo = this._initUndo();
  }

  private migrate() {
    const currentVersion = this.db.pragma("user_version", { simple: true }) as number;

    if (currentVersion < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS decisions (
          group_id TEXT PRIMARY KEY,
          keep_ids TEXT NOT NULL,
          cull_ids TEXT NOT NULL,
          skipped INTEGER NOT NULL DEFAULT 0,
          selected_index INTEGER NOT NULL DEFAULT 0,
          decided_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS undo_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id TEXT NOT NULL,
          prev_keep_ids TEXT,
          prev_cull_ids TEXT,
          prev_skipped INTEGER,
          prev_selected_index INTEGER,
          undone INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_undo_group ON undo_log(group_id, undone);
      `);
    }

    if (currentVersion < 2) {
      // LLM result tables for Phase 2
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS llm_batch_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id TEXT NOT NULL,
          batch_fingerprint TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
          request_meta TEXT,
          response_json TEXT,
          error_message TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost_estimate_usd REAL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_llm_batch ON llm_batch_runs(batch_id, batch_fingerprint, status);

        CREATE TABLE IF NOT EXISTS llm_image_assessments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          llm_run_id INTEGER NOT NULL REFERENCES llm_batch_runs(id),
          batch_id TEXT NOT NULL,
          image_id TEXT NOT NULL,
          suggested_stars INTEGER NOT NULL,
          categories TEXT NOT NULL,
          protect_from_cull INTEGER NOT NULL DEFAULT 0,
          protection_reason TEXT NOT NULL DEFAULT 'no_special_protection',
          brief_note TEXT NOT NULL DEFAULT '',
          similarity_subgroup_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_llm_image ON llm_image_assessments(image_id, llm_run_id);

        CREATE TABLE IF NOT EXISTS llm_similarity_subgroups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          llm_run_id INTEGER NOT NULL REFERENCES llm_batch_runs(id),
          batch_id TEXT NOT NULL,
          subgroup_id TEXT NOT NULL,
          image_ids TEXT NOT NULL,
          subgroup_type TEXT NOT NULL,
          recommended_keep_count INTEGER NOT NULL,
          recommended_keep_ids TEXT NOT NULL,
          cull_ids TEXT NOT NULL,
          rationale TEXT NOT NULL DEFAULT '',
          confidence REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    }

    if (currentVersion < 3) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS photo_decisions (
          asset_id TEXT PRIMARY KEY,
          state TEXT,                     -- 'keep' | 'cull' | null
          user_stars INTEGER,             -- 0-5, null = no override
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    }

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  // === Decisions (transactional) ===

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

  private _initSaveDecision() { return this.db.transaction(
    (groupId: string, keep: string[], cull: string[], skipped: boolean, selectedIndex: number) => {
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
          keep_ids = excluded.keep_ids, cull_ids = excluded.cull_ids,
          skipped = excluded.skipped, selected_index = excluded.selected_index,
          updated_at = datetime('now')
      `).run(groupId, JSON.stringify(keep), JSON.stringify(cull), skipped ? 1 : 0, selectedIndex);
    }
  ); }

  deleteDecision(groupId: string) {
    this.db.prepare("DELETE FROM decisions WHERE group_id = ?").run(groupId);
  }

  private _initUndo() { return this.db.transaction((groupId: string): { previousSelectedIndex: number | null } => {
    const entry = this.db.prepare(
      "SELECT id, prev_keep_ids, prev_cull_ids, prev_skipped, prev_selected_index FROM undo_log WHERE group_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1"
    ).get(groupId) as any;
    if (!entry) return { previousSelectedIndex: null };

    this.db.prepare("UPDATE undo_log SET undone = 1 WHERE id = ?").run(entry.id);

    if (entry.prev_keep_ids === null) {
      this.deleteDecision(groupId);
    } else {
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
  }); }

  // === LLM Results ===

  saveLlmRun(batchId: string, fingerprint: string, model: string, promptVersion: string, responseJson: string, inputTokens: number, outputTokens: number): number {
    const cost = (inputTokens / 1e6) * 0.10 + (outputTokens / 1e6) * 0.40;
    const result = this.db.prepare(`
      INSERT INTO llm_batch_runs (batch_id, batch_fingerprint, model, prompt_version, status, response_json, input_tokens, output_tokens, cost_estimate_usd, completed_at)
      VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, datetime('now'))
    `).run(batchId, fingerprint, model, promptVersion, responseJson, inputTokens, outputTokens, cost);
    return Number(result.lastInsertRowid);
  }

  getLlmRun(batchId: string, fingerprint: string): { id: number; responseJson: string } | null {
    const row = this.db.prepare(
      "SELECT id, response_json FROM llm_batch_runs WHERE batch_id = ? AND batch_fingerprint = ? AND status = 'completed' ORDER BY id DESC LIMIT 1"
    ).get(batchId, fingerprint) as any;
    return row ? { id: row.id, responseJson: row.response_json } : null;
  }

  // === Per-photo decisions (shared across all views) ===

  savePhotoDecision(assetId: string, state: string | null, userStars: number | null) {
    this.db.prepare(`
      INSERT INTO photo_decisions (asset_id, state, user_stars, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(asset_id) DO UPDATE SET
        state = excluded.state,
        user_stars = excluded.user_stars,
        updated_at = datetime('now')
    `).run(assetId, state, userStars);
  }

  savePhotoDecisions(decisions: Array<{ assetId: string; state: string | null; userStars: number | null }>) {
    const stmt = this.db.prepare(`
      INSERT INTO photo_decisions (asset_id, state, user_stars, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(asset_id) DO UPDATE SET
        state = excluded.state,
        user_stars = excluded.user_stars,
        updated_at = datetime('now')
    `);
    const batch = this.db.transaction(() => {
      for (const d of decisions) stmt.run(d.assetId, d.state, d.userStars);
    });
    batch();
  }

  getPhotoDecisions(assetIds: string[]): Record<string, { state: string | null; userStars: number | null }> {
    const result: Record<string, { state: string | null; userStars: number | null }> = {};
    // SQLite has a limit on placeholders, batch in chunks
    for (let i = 0; i < assetIds.length; i += 500) {
      const chunk = assetIds.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT asset_id, state, user_stars FROM photo_decisions WHERE asset_id IN (${placeholders})`
      ).all(...chunk) as any[];
      for (const row of rows) {
        result[row.asset_id] = { state: row.state, userStars: row.user_stars };
      }
    }
    return result;
  }

  getAllPhotoDecisionStats(): { kept: number; culled: number; starred: number } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN state = 'keep' THEN 1 ELSE 0 END) as kept,
        SUM(CASE WHEN state = 'cull' THEN 1 ELSE 0 END) as culled,
        SUM(CASE WHEN user_stars > 0 THEN 1 ELSE 0 END) as starred
      FROM photo_decisions
    `).get() as any;
    return { kept: row?.kept ?? 0, culled: row?.culled ?? 0, starred: row?.starred ?? 0 };
  }

  // === Stats ===

  getStats(): { decided: number; skipped: number; photosKept: number; photosCulled: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as decided,
        SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END) as skipped
      FROM decisions
    `).get() as any;

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

/** Create a stable fingerprint for a batch based on its asset IDs */
export function batchFingerprint(assetIds: string[]): string {
  const sorted = [...assetIds].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
}
