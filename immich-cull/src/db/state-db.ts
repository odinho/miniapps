/**
 * Local SQLite database for persisting tool state.
 * Single source of truth: photo_decisions (per-photo keep/cull/stars).
 * Separate from Immich — this is our own state.
 */
import Database from "better-sqlite3";
import { dirname } from "path";
import { mkdirSync } from "fs";
import { createHash } from "crypto";

const SCHEMA_VERSION = 4;

export class StateDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate() {
    const currentVersion = this.db.pragma("user_version", { simple: true }) as number;

    if (currentVersion < 4) {
      this.db.exec(`
        -- Per-photo decisions: single source of truth
        CREATE TABLE IF NOT EXISTS photo_decisions (
          asset_id TEXT PRIMARY KEY,
          state TEXT,                     -- 'keep' | 'cull' | null
          user_stars INTEGER,             -- 0-5, null = no override
          source TEXT DEFAULT 'manual',   -- 'manual' | 'llm' | 'bulk'
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- View completion status (groups + batches)
        CREATE TABLE IF NOT EXISTS view_status (
          view_id TEXT PRIMARY KEY,
          view_type TEXT NOT NULL,         -- 'group' | 'batch'
          status TEXT,                     -- 'reviewed' | 'skipped' | null
          reviewed_at TEXT
        );

        -- LLM result cache
        CREATE TABLE IF NOT EXISTS llm_batch_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id TEXT NOT NULL,
          batch_fingerprint TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
          response_json TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost_estimate_usd REAL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_llm_batch ON llm_batch_runs(batch_id, batch_fingerprint, status);
      `);

      // Migrate old decisions table if it exists
      try {
        const oldDecisions = this.db.prepare(
          "SELECT group_id, keep_ids, cull_ids, skipped FROM decisions"
        ).all() as any[];
        for (const row of oldDecisions) {
          const groupId = row.group_id;
          const skipped = row.skipped === 1;
          // Migrate to view_status
          this.db.prepare(
            "INSERT OR IGNORE INTO view_status (view_id, view_type, status, reviewed_at) VALUES (?, 'group', ?, datetime('now'))"
          ).run(groupId, skipped ? 'skipped' : 'reviewed');
          // Migrate keep/cull to photo_decisions
          if (!skipped) {
            for (const id of JSON.parse(row.keep_ids)) {
              this.db.prepare(
                "INSERT OR IGNORE INTO photo_decisions (asset_id, state, source) VALUES (?, 'keep', 'manual')"
              ).run(id);
            }
            for (const id of JSON.parse(row.cull_ids)) {
              this.db.prepare(
                "INSERT OR IGNORE INTO photo_decisions (asset_id, state, source) VALUES (?, 'cull', 'manual')"
              ).run(id);
            }
          }
        }
      } catch { /* old table doesn't exist, fine */ }
    }

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  // === Per-photo decisions (single source of truth) ===

  savePhotoDecision(assetId: string, state: string | null, userStars: number | null) {
    this.db.prepare(`
      INSERT INTO photo_decisions (asset_id, state, user_stars, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(asset_id) DO UPDATE SET
        state = excluded.state, user_stars = excluded.user_stars, updated_at = datetime('now')
    `).run(assetId, state, userStars);
  }

  savePhotoDecisions(decisions: Array<{ assetId: string; state: string | null; userStars: number | null }>) {
    const stmt = this.db.prepare(`
      INSERT INTO photo_decisions (asset_id, state, user_stars, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(asset_id) DO UPDATE SET
        state = excluded.state, user_stars = excluded.user_stars, updated_at = datetime('now')
    `);
    this.db.transaction(() => {
      for (const d of decisions) stmt.run(d.assetId, d.state, d.userStars);
    })();
  }

  getPhotoDecisions(assetIds: string[]): Record<string, { state: string | null; userStars: number | null }> {
    const result: Record<string, { state: string | null; userStars: number | null }> = {};
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

  // === View status (group/batch completion tracking) ===

  setViewStatus(viewId: string, viewType: string, status: string) {
    this.db.prepare(`
      INSERT INTO view_status (view_id, view_type, status, reviewed_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(view_id) DO UPDATE SET status = excluded.status, reviewed_at = datetime('now')
    `).run(viewId, viewType, status);
  }

  clearViewStatus(viewId: string) {
    this.db.prepare("DELETE FROM view_status WHERE view_id = ?").run(viewId);
  }

  getViewStatus(viewId: string): string | null {
    const row = this.db.prepare("SELECT status FROM view_status WHERE view_id = ?").get(viewId) as any;
    return row?.status ?? null;
  }

  getViewStatuses(viewType: string): Record<string, string> {
    const rows = this.db.prepare("SELECT view_id, status FROM view_status WHERE view_type = ?").all(viewType) as any[];
    const result: Record<string, string> = {};
    for (const row of rows) result[row.view_id] = row.status;
    return result;
  }

  // === LLM Results ===

  saveLlmRun(batchId: string, fingerprint: string, model: string, promptVersion: string, responseJson: string, inputTokens: number, outputTokens: number): number {
    const cost = (inputTokens / 1e6) * 0.10 + (outputTokens / 1e6) * 0.40;
    const result = this.db.prepare(`
      INSERT INTO llm_batch_runs (batch_id, batch_fingerprint, model, prompt_version, status, response_json, input_tokens, output_tokens, cost_estimate_usd, completed_at)
      VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, datetime('now'))
    `).run(batchId, fingerprint, model, promptVersion, responseJson, inputTokens, outputTokens, cost);
    return Number(result.lastInsertRowid);
  }

  deleteLlmRun(batchId: string, fingerprint: string) {
    this.db.prepare(
      "DELETE FROM llm_batch_runs WHERE batch_id = ? AND batch_fingerprint = ?"
    ).run(batchId, fingerprint);
  }

  getLlmRun(batchId: string, fingerprint: string): { id: number; responseJson: string } | null {
    const row = this.db.prepare(
      "SELECT id, response_json FROM llm_batch_runs WHERE batch_id = ? AND batch_fingerprint = ? AND status = 'completed' ORDER BY id DESC LIMIT 1"
    ).get(batchId, fingerprint) as any;
    return row ? { id: row.id, responseJson: row.response_json } : null;
  }

  // === Stats (from photo_decisions, single source) ===

  getStats(): { photosKept: number; photosCulled: number; photosStarred: number; groupsReviewed: number; groupsSkipped: number } {
    const photos = this.db.prepare(`
      SELECT
        SUM(CASE WHEN state = 'keep' THEN 1 ELSE 0 END) as kept,
        SUM(CASE WHEN state = 'cull' THEN 1 ELSE 0 END) as culled,
        SUM(CASE WHEN user_stars > 0 THEN 1 ELSE 0 END) as starred
      FROM photo_decisions
    `).get() as any;

    const views = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'reviewed' THEN 1 ELSE 0 END) as reviewed,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
      FROM view_status WHERE view_type = 'group'
    `).get() as any;

    return {
      photosKept: photos?.kept ?? 0,
      photosCulled: photos?.culled ?? 0,
      photosStarred: photos?.starred ?? 0,
      groupsReviewed: views?.reviewed ?? 0,
      groupsSkipped: views?.skipped ?? 0,
    };
  }

  close() {
    this.db.close();
  }
}

export function batchFingerprint(assetIds: string[]): string {
  const sorted = [...assetIds].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
}
