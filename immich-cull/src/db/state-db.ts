/**
 * Local SQLite database for persisting tool state.
 * Single source of truth: photo_decisions (per-photo keep/cull/stars).
 * Separate from Immich — this is our own state.
 */
import Database from "better-sqlite3";
import { dirname } from "path";
import { mkdirSync } from "fs";
import { createHash } from "crypto";

const SCHEMA_VERSION = 7;

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
    const currentVersion = this.db.pragma("user_version", {
      simple: true,
    }) as number;

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

        -- View completion status (batches)
        CREATE TABLE IF NOT EXISTS view_status (
          view_id TEXT PRIMARY KEY,
          view_type TEXT NOT NULL,         -- 'batch'
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
        const oldDecisions = this.db
          .prepare("SELECT group_id, keep_ids, cull_ids, skipped FROM decisions")
          .all() as any[];
        for (const row of oldDecisions) {
          const groupId = row.group_id;
          const skipped = row.skipped === 1;
          // Migrate to view_status
          this.db
            .prepare(
              "INSERT OR IGNORE INTO view_status (view_id, view_type, status, reviewed_at) VALUES (?, 'group', ?, datetime('now'))",
            )
            .run(groupId, skipped ? "skipped" : "reviewed");
          // Migrate keep/cull to photo_decisions
          if (!skipped) {
            for (const id of JSON.parse(row.keep_ids)) {
              this.db
                .prepare(
                  "INSERT OR IGNORE INTO photo_decisions (asset_id, state, source) VALUES (?, 'keep', 'manual')",
                )
                .run(id);
            }
            for (const id of JSON.parse(row.cull_ids)) {
              this.db
                .prepare(
                  "INSERT OR IGNORE INTO photo_decisions (asset_id, state, source) VALUES (?, 'cull', 'manual')",
                )
                .run(id);
            }
          }
        }
      } catch {
        /* old table doesn't exist, fine */
      }
    }

    if (currentVersion < 5) {
      // Add 'superseded' to status CHECK constraint — SQLite requires table recreate
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS llm_batch_runs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id TEXT NOT NULL,
          batch_fingerprint TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'superseded')),
          request_meta TEXT,
          response_json TEXT,
          error_message TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost_estimate_usd REAL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );
        INSERT INTO llm_batch_runs_new (id, batch_id, batch_fingerprint, model, prompt_version, status, response_json, input_tokens, output_tokens, cost_estimate_usd, created_at, completed_at)
        SELECT id, batch_id, batch_fingerprint, model, prompt_version, status, response_json, input_tokens, output_tokens, cost_estimate_usd, created_at, completed_at FROM llm_batch_runs;
        DROP TABLE llm_batch_runs;
        ALTER TABLE llm_batch_runs_new RENAME TO llm_batch_runs;
        CREATE INDEX IF NOT EXISTS idx_llm_batch ON llm_batch_runs(batch_id, batch_fingerprint, status);
      `);
    }

    if (currentVersion < 6) {
      // Add source and llm_run_id columns for auto-cull provenance.
      // The CREATE TABLE in v4 migration includes source, but CREATE TABLE IF NOT EXISTS
      // doesn't alter existing tables — so existing DBs lack the column.
      const cols = this.db.prepare("PRAGMA table_info(photo_decisions)").all() as Array<{
        name: string;
      }>;
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("source")) {
        this.db.exec("ALTER TABLE photo_decisions ADD COLUMN source TEXT DEFAULT 'manual'");
      }
      if (!colNames.has("llm_run_id")) {
        this.db.exec("ALTER TABLE photo_decisions ADD COLUMN llm_run_id INTEGER");
      }
    }

    if (currentVersion < 7) {
      // Add star_source to distinguish LLM-set stars from user-confirmed stars
      const cols = this.db.prepare("PRAGMA table_info(photo_decisions)").all() as Array<{
        name: string;
      }>;
      if (!new Set(cols.map((c) => c.name)).has("star_source")) {
        this.db.exec("ALTER TABLE photo_decisions ADD COLUMN star_source TEXT DEFAULT 'user'");
      }

      // Ensure auto_keep_patterns table exists
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS auto_keep_patterns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern TEXT NOT NULL UNIQUE,
          description TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    }

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  // === Per-photo decisions (single source of truth) ===

  savePhotoDecision(assetId: string, state: string | null, userStars: number | null) {
    this.db
      .prepare(
        `
      INSERT INTO photo_decisions (asset_id, state, user_stars, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(asset_id) DO UPDATE SET
        state = excluded.state, user_stars = excluded.user_stars, updated_at = datetime('now')
    `,
      )
      .run(assetId, state, userStars);
  }

  savePhotoDecisions(
    decisions: Array<{
      assetId: string;
      state: string | null;
      userStars: number | null;
      starSource?: string;
    }>,
    source: string = "manual",
    llmRunId?: number,
  ) {
    const stmt = this.db.prepare(`
      INSERT INTO photo_decisions (asset_id, state, user_stars, source, llm_run_id, star_source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(asset_id) DO UPDATE SET
        state = excluded.state, user_stars = excluded.user_stars,
        source = excluded.source, llm_run_id = excluded.llm_run_id,
        star_source = excluded.star_source,
        updated_at = datetime('now')
    `);
    this.db.transaction(() => {
      for (const d of decisions)
        stmt.run(d.assetId, d.state, d.userStars, source, llmRunId ?? null, d.starSource ?? "user");
    })();
  }

  /** Save auto decisions safely — never overwrites existing rows. Returns count inserted. */
  saveAutoDecisions(decisions: Array<{ assetId: string; state: string }>, source: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO photo_decisions (asset_id, state, source, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(asset_id) DO NOTHING
    `);
    let inserted = 0;
    this.db.transaction(() => {
      for (const d of decisions) {
        const r = stmt.run(d.assetId, d.state, source);
        if (r.changes > 0) inserted++;
      }
    })();
    return inserted;
  }

  getPhotoDecisions(
    assetIds: string[],
  ): Record<string, { state: string | null; userStars: number | null }> {
    const result: Record<string, { state: string | null; userStars: number | null }> = {};
    for (let i = 0; i < assetIds.length; i += 500) {
      const chunk = assetIds.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT asset_id, state, user_stars FROM photo_decisions WHERE asset_id IN (${placeholders})`,
        )
        .all(...chunk) as any[];
      for (const row of rows) {
        result[row.asset_id] = { state: row.state, userStars: row.user_stars };
      }
    }
    return result;
  }

  // === View status (group/batch completion tracking) ===

  setViewStatus(viewId: string, viewType: string, status: string) {
    this.db
      .prepare(
        `
      INSERT INTO view_status (view_id, view_type, status, reviewed_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(view_id) DO UPDATE SET status = excluded.status, reviewed_at = datetime('now')
    `,
      )
      .run(viewId, viewType, status);
  }

  clearViewStatus(viewId: string) {
    this.db.prepare("DELETE FROM view_status WHERE view_id = ?").run(viewId);
  }

  getViewStatus(viewId: string): string | null {
    const row = this.db
      .prepare("SELECT status FROM view_status WHERE view_id = ?")
      .get(viewId) as any;
    return row?.status ?? null;
  }

  getRecentlyReviewed(viewType: string, limit: number = 3): string[] {
    return (
      this.db
        .prepare(
          "SELECT view_id FROM view_status WHERE view_type = ? AND status = 'reviewed' ORDER BY reviewed_at DESC LIMIT ?",
        )
        .all(viewType, limit) as any[]
    ).map((r) => r.view_id);
  }

  getViewStatuses(viewType: string): Record<string, string> {
    const rows = this.db
      .prepare("SELECT view_id, status FROM view_status WHERE view_type = ?")
      .all(viewType) as any[];
    const result: Record<string, string> = {};
    for (const row of rows) result[row.view_id] = row.status;
    return result;
  }

  // === LLM Results ===

  saveLlmRun(
    batchId: string,
    fingerprint: string,
    model: string,
    promptVersion: string,
    responseJson: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    const cost = (inputTokens / 1e6) * 0.1 + (outputTokens / 1e6) * 0.4;
    const result = this.db
      .prepare(
        `
      INSERT INTO llm_batch_runs (batch_id, batch_fingerprint, model, prompt_version, status, response_json, input_tokens, output_tokens, cost_estimate_usd, completed_at)
      VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, datetime('now'))
    `,
      )
      .run(
        batchId,
        fingerprint,
        model,
        promptVersion,
        responseJson,
        inputTokens,
        outputTokens,
        cost,
      );
    return Number(result.lastInsertRowid);
  }

  deleteLlmRun(batchId: string, fingerprint: string) {
    this.db
      .prepare("DELETE FROM llm_batch_runs WHERE batch_id = ? AND batch_fingerprint = ?")
      .run(batchId, fingerprint);
  }

  /** Mark existing runs as superseded (keeps history, getLlmRun ignores them).
   *  Also reverts any auto-cull decisions based on the superseded runs. */
  invalidateLlmRun(batchId: string, fingerprint: string, model?: string) {
    // Find run IDs before superseding so we can revert auto-cull decisions
    const whereClause = model
      ? "batch_id = ? AND batch_fingerprint = ? AND model = ? AND status = 'completed'"
      : "batch_id = ? AND batch_fingerprint = ? AND status = 'completed'";
    const params = model ? [batchId, fingerprint, model] : [batchId, fingerprint];

    const runs = this.db
      .prepare(`SELECT id FROM llm_batch_runs WHERE ${whereClause}`)
      .all(...params) as Array<{ id: number }>;

    // Supersede the runs
    this.db
      .prepare(`UPDATE llm_batch_runs SET status = 'superseded' WHERE ${whereClause}`)
      .run(...params);

    // Revert auto-cull decisions that depended on these runs
    for (const run of runs) {
      this.invalidateAutoDecisionsForRun(run.id);
    }
  }

  getLlmRun(
    batchId: string,
    fingerprint: string,
    model?: string,
  ): { id: number; responseJson: string; model: string } | null {
    const row = model
      ? (this.db
          .prepare(
            "SELECT id, response_json as responseJson, model FROM llm_batch_runs WHERE batch_id = ? AND batch_fingerprint = ? AND model = ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
          )
          .get(batchId, fingerprint, model) as any)
      : (this.db
          .prepare(
            "SELECT id, response_json as responseJson, model FROM llm_batch_runs WHERE batch_id = ? AND batch_fingerprint = ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
          )
          .get(batchId, fingerprint) as any);
    return row ? { id: row.id, responseJson: row.responseJson, model: row.model } : null;
  }

  /** Get the latest completed run for each model that has rated this batch */
  getAllLlmRuns(
    batchId: string,
    fingerprint: string,
  ): Array<{ id: number; responseJson: string; model: string }> {
    // Latest run per model via GROUP BY on the most-recent id
    const rows = this.db
      .prepare(
        `SELECT r.id, r.response_json as responseJson, r.model
         FROM llm_batch_runs r
         INNER JOIN (
           SELECT model, MAX(id) as max_id
           FROM llm_batch_runs
           WHERE batch_id = ? AND batch_fingerprint = ? AND status = 'completed'
           GROUP BY model
         ) latest ON r.id = latest.max_id
         ORDER BY r.model`,
      )
      .all(batchId, fingerprint) as Array<{
      id: number;
      responseJson: string;
      model: string;
    }>;
    return rows;
  }

  /** Fast batch-level model counts for all batches (single query). */
  getBatchModelCounts(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT batch_id || ':' || batch_fingerprint as key,
                COUNT(DISTINCT model) as model_count
         FROM llm_batch_runs
         WHERE status = 'completed'
         GROUP BY batch_id, batch_fingerprint`,
      )
      .all() as Array<{ key: string; model_count: number }>;
    return new Map(rows.map((r) => [r.key, r.model_count]));
  }

  /** Get list of models with completed results for a batch */
  getLlmModels(batchId: string, fingerprint: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT model FROM llm_batch_runs WHERE batch_id = ? AND batch_fingerprint = ? AND status = 'completed' ORDER BY model",
      )
      .all(batchId, fingerprint) as Array<{ model: string }>;
    return rows.map((r) => r.model);
  }

  // === Stats (from photo_decisions, single source) ===

  getStats(): {
    photosKept: number;
    photosCulled: number;
    photosStarred: number;
  } {
    const photos = this.db
      .prepare(
        `
      SELECT
        SUM(CASE WHEN state = 'keep' THEN 1 ELSE 0 END) as kept,
        SUM(CASE WHEN state = 'cull' THEN 1 ELSE 0 END) as culled,
        SUM(CASE WHEN user_stars > 0 THEN 1 ELSE 0 END) as starred
      FROM photo_decisions
    `,
      )
      .get() as any;

    return {
      photosKept: photos?.kept ?? 0,
      photosCulled: photos?.culled ?? 0,
      photosStarred: photos?.starred ?? 0,
    };
  }

  /** Get all culled asset IDs. */
  getCulledAssetIds(): string[] {
    return (
      this.db.prepare("SELECT asset_id FROM photo_decisions WHERE state = 'cull'").all() as any[]
    ).map((r) => r.asset_id);
  }

  /** Get all decided photos for write-back. */
  getAllDecisions(): Array<{
    assetId: string;
    state: string;
    userStars: number | null;
    starSource: string | null;
  }> {
    return this.db
      .prepare(
        "SELECT asset_id as assetId, state, user_stars as userStars, star_source as starSource FROM photo_decisions WHERE state IS NOT NULL",
      )
      .all() as Array<{
      assetId: string;
      state: string;
      userStars: number | null;
      starSource: string | null;
    }>;
  }

  /** Save LLM-derived star ratings (marked as source='llm'). */
  saveLlmStars(ratings: Array<{ assetId: string; stars: number }>) {
    const stmt = this.db.prepare(`
      UPDATE photo_decisions SET user_stars = ?, star_source = 'llm', updated_at = datetime('now')
      WHERE asset_id = ? AND (user_stars IS NULL OR star_source = 'llm')
    `);
    this.db.transaction(() => {
      for (const r of ratings) stmt.run(r.stars, r.assetId);
    })();
  }

  /** Clear all LLM-set star ratings (reset to null). */
  clearLlmStars(): number {
    const r = this.db
      .prepare(
        "UPDATE photo_decisions SET user_stars = NULL, star_source = NULL WHERE star_source = 'llm'",
      )
      .run();
    return r.changes;
  }

  // === Auto-cull provenance ===

  /** Revert auto-cull decisions. Returns count of reverted. */
  revertAutoCullDecisions(llmRunId?: number): number {
    if (llmRunId) {
      const r = this.db
        .prepare("DELETE FROM photo_decisions WHERE source = 'auto-cull' AND llm_run_id = ?")
        .run(llmRunId);
      return r.changes;
    }
    const r = this.db.prepare("DELETE FROM photo_decisions WHERE source = 'auto-cull'").run();
    return r.changes;
  }

  /** When an LLM run is superseded, revert any auto-cull decisions based on it. */
  invalidateAutoDecisionsForRun(llmRunId: number): number {
    return this.revertAutoCullDecisions(llmRunId);
  }

  /** Revert all consensus-approved decisions */
  revertConsensusDecisions(): number {
    const r = this.db.prepare("DELETE FROM photo_decisions WHERE source = 'consensus'").run();
    return r.changes;
  }

  /** Get the source of decisions for multiple assets */
  getDecisionSources(assetIds: string[]): Record<string, string | null> {
    const result: Record<string, string | null> = {};
    for (let i = 0; i < assetIds.length; i += 500) {
      const chunk = assetIds.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT asset_id, source FROM photo_decisions WHERE asset_id IN (${placeholders})`)
        .all(...chunk) as Array<{ asset_id: string; source: string }>;
      for (const row of rows) result[row.asset_id] = row.source;
    }
    return result;
  }

  /** Revert all burst/duplicate auto-cull decisions */
  revertBurstAutoCullDecisions(): number {
    const r = this.db
      .prepare(
        "DELETE FROM photo_decisions WHERE source IN ('burst-auto-cull', 'immich-duplicate')",
      )
      .run();
    return r.changes;
  }

  /** Get auto-keep patterns from the DB table. */
  getAutoKeepPatterns(): Array<{
    pattern: string;
    description: string | null;
  }> {
    return this.db.prepare("SELECT pattern, description FROM auto_keep_patterns").all() as Array<{
      pattern: string;
      description: string | null;
    }>;
  }

  close() {
    this.db.close();
  }
}

export function batchFingerprint(assetIds: string[]): string {
  const sorted = [...assetIds].toSorted();
  return createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
}
