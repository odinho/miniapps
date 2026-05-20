import { db } from "./db.js";
import type {
  TrendTargetState,
  TrendTargetSource,
  TrendTargetConfidence,
} from "$lib/engine/trend.js";

export type { TrendTargetState, TrendTargetSource, TrendTargetConfidence };

export function getTrendTargetState(babyId: number): TrendTargetState | null {
  const row = db
    .prepare(
      `SELECT target_min, baseline_min, source, confidence,
              natural_support_streak, updated_at
       FROM trend_target_state WHERE baby_id = ?`,
    )
    .get(babyId) as
      | {
          target_min: number;
          baseline_min: number;
          source: string;
          confidence: string;
          natural_support_streak: number;
          updated_at: string;
        }
      | undefined;
  if (!row) return null;
  if (row.source !== "observed-initial" && row.source !== "natural-days" && row.source !== "manual-reset") {
    return null;
  }
  if (row.confidence !== "low" && row.confidence !== "medium" && row.confidence !== "high") {
    return null;
  }
  return {
    targetMin: row.target_min,
    baselineMin: row.baseline_min,
    source: row.source,
    confidence: row.confidence,
    naturalSupportStreak: row.natural_support_streak,
    updatedAt: row.updated_at,
  };
}

export function setTrendTargetState(babyId: number, state: TrendTargetState): void {
  db.prepare(
    `INSERT INTO trend_target_state
       (baby_id, target_min, baseline_min, source, confidence, natural_support_streak, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(baby_id) DO UPDATE SET
       target_min = excluded.target_min,
       baseline_min = excluded.baseline_min,
       source = excluded.source,
       confidence = excluded.confidence,
       natural_support_streak = excluded.natural_support_streak,
       updated_at = excluded.updated_at`,
  ).run(
    babyId,
    state.targetMin,
    state.baselineMin,
    state.source,
    state.confidence,
    state.naturalSupportStreak,
    state.updatedAt,
  );
}

/** Manual reset — wipes the held baseline, forcing re-initialization
 *  on the next compute pass. Exposed for tests, debug routes, and a
 *  future user-facing "reset target" affordance. */
export function clearTrendTargetState(babyId: number): void {
  db.prepare("DELETE FROM trend_target_state WHERE baby_id = ?").run(babyId);
}
