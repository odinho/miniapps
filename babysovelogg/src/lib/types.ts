// Shared domain types used by both server and client

export interface Baby {
  id: number;
  name: string;
  birthdate: string;
  created_at: string;
  custom_nap_count: number | null;
  potty_mode: number;
  track_diaper: number;
  timezone: string | null;
  target_bedtime: string | null; // "HH:MM" in 24h format, or null for follow-the-baby mode
  created_by_event_id: number | null;
  updated_by_event_id: number | null;
}

export interface SleepLogRow {
  id: number;
  baby_id: number;
  start_time: string;
  end_time: string | null;
  type: string;
  notes: string | null;
  mood: string | null;
  method: string | null;
  fall_asleep_time: string | null;
  onset_note: string | null;
  woke_by: string | null;
  wake_notes: string | null;
  wake_mood: string | null;
  deleted: number;
  domain_id: string;
  created_by_event_id: number | null;
  updated_by_event_id: number | null;
  pauses?: SleepPauseRow[];
}

export interface SleepPauseRow {
  id: number;
  sleep_id: number;
  pause_time: string;
  resume_time: string | null;
  created_by_event_id: number | null;
}

export interface DiaperLogRow {
  id: number;
  baby_id: number;
  time: string;
  type: string;
  amount: string | null;
  note: string | null;
  deleted: number;
  domain_id: string;
  created_by_event_id: number | null;
  updated_by_event_id: number | null;
}

export interface DayStartRow {
  id: number;
  baby_id: number;
  date: string;
  /**
   * Wake time as ISO. `null` when the row exists only because of a
   * `day.marked_off` event with no preceding `day.started` — the placeholder
   * midnight isn't a real wake and downstream code must not anchor on it.
   * Server normalises the placeholder away in getState before returning.
   */
  wake_time: string | null;
  created_at: string;
  created_by_event_id: number | null;
  /**
   * Off-day flag (sick, travel, growth spurt, DST adjustment). 0 = normal
   * day, 1 = off-day. Off-days are skipped from trend computation so a
   * bad week doesn't pull the engine's recommendations sideways.
   */
  off_day?: number;
  off_day_reason?: string | null;
}

/** Unified sleep entry used by both engine/schedule.ts and engine/stats.ts */
export interface SleepEntry {
  start_time: string;
  end_time: string | null;
  type: "nap" | "night";
  pauses?: SleepPause[];
  /**
   * How the sleep ended, if recorded. "self" = baby woke naturally,
   * "woken" = parent ended the sleep. The engine uses this to right-censor
   * short parent-ended naps — they're a lower bound on natural duration,
   * not a sample of it. Optional: not all rows have this populated.
   */
  woke_by?: "self" | "woken" | null;
}

export interface SleepPause {
  pause_time: string;
  resume_time: string | null;
}

/**
 * Feature toggles for the prediction engine.
 * All default to true (enabled). Set to false to disable.
 * Used for ablation testing and per-baby feature selection.
 */
export interface PredictionFeatures {
  positionalDuration: boolean;  // per-position nap durations (1st ≠ 2nd)
  habitualWake: boolean;        // circadian wake-time anchor
  habitualBedtime: boolean;     // family routine bedtime anchor
  habitualNapStart: boolean;    // circadian nap-time anchor (blend with pressure)
  cycleBias: boolean;           // soft-snap to sleep cycle boundaries
  sleepBudget: boolean;         // adjust night duration based on day's nap total
  weightedRecency: boolean;     // recency-weighted duration learning
}

export const DEFAULT_FEATURES: PredictionFeatures = {
  positionalDuration: true,
  habitualWake: true,
  habitualBedtime: true,
  habitualNapStart: true,
  cycleBias: true,
  sleepBudget: true,
  weightedRecency: true,
};

/** Everything the prediction engine needs to know about a baby. */
export interface BabyContext {
  birthdate: string;          // ISO date
  ageMonths: number;          // pre-computed age in months
  tz: string;                 // IANA timezone (e.g. "Europe/Oslo")
  customNapCount: number | null;
  recentSleeps: SleepEntry[]; // last 7 days of completed sleeps
  /**
   * Optional wider lookback (e.g. last 21 days) used only for stable estimates
   * that the 7-day window is too sparse for — currently the self-wake median
   * that drives `censorCutShortNaps`. Duration learning still uses the 7-day
   * window so the engine adapts quickly during transitions.
   */
  extendedSleeps?: SleepEntry[];
  /**
   * Long-horizon lookback (up to 30 days) used by the napBudget trend
   * computation. Falls back to extendedSleeps then recentSleeps when not
   * provided. Optional so existing callers and tests need not supply it.
   */
  trendSleeps?: SleepEntry[];
  /**
   * Local-date keys (YYYY-MM-DD in baby tz) the parent marked as off-days
   * (sick, travel, growth spurt, DST). The trend computation skips these
   * so a bad week doesn't pull the engine's recommendations sideways.
   */
  offDays?: Set<string>;
  /**
   * Pre-computed blended 7d/30d daily-total trend (minutes), or null when
   * the data is too sparse / noisy to trust. Computed once in
   * `assembleState` and threaded through so the cut-short censor's
   * cap-respect carve-out can compare day totals against the *actual*
   * daily target instead of the conservative age-band floor — keeping
   * the censor and napBudget aligned on one "near trend" definition.
   */
  trendTotalMin?: number | null;
  /**
   * Held intervention target — what `computeNapBudget` caps toward and
   * what `censorCutShortNaps`'s cap-respect carve-out compares against.
   * Diverges from `trendTotalMin` (= observed mean) once cap-following
   * begins; staying split is the entire point of the trend ratchet fix.
   * Codex 2026-05-20 design at `local/codex-trend-split-design.md`.
   */
  interventionTrendTargetMin?: number | null;
  /** Full TrendTargets object (observed + intervention + diagnostics +
   *  next state). Stashed once in `buildContext` so downstream
   *  consumers don't recompute and `Prediction.trendTargets` reads the
   *  same object the engine acted on. */
  trendTargets?: import("./engine/trend.js").TrendTargets | null;
  /**
   * Persisted trend-target state from the prior evaluation (held
   * intervention target + baseline + drift bookkeeping). Threaded into
   * `computeTrendTargets` so the cap target survives across calls
   * instead of being recomputed from the rolling window each time.
   * Null/undefined when no prior state exists or persistence is bypassed
   * (tests, backtest harness).
   */
  priorTrendTargetState?: import("./engine/trend.js").TrendTargetState | null;
  /** User-set preferred bedtime ("HH:MM"), or null for follow-the-baby mode. */
  targetBedtime?: string | null;
  features?: Partial<PredictionFeatures>;
  /** Active prediction strategy — widens wake window clamp for emerging babies. */
  strategy?: "newborn_guidance" | "emerging_rhythm" | "routine_schedule";
  /** @internal Lazy cache for prediction pipeline. Do not set manually. */
  _cache?: unknown;
  /** @internal Memoized self-wake median (minutes) over extendedSleeps. */
  _extendedSelfMedian?: number | null;
}

export interface EventRow {
  id: number;
  type: string;
  payload: string;
  client_id: string;
  client_event_id: string;
  timestamp: string;
  schema_version: number | null;
  correlation_id: string | null;
  caused_by_event_id: number | null;
  domain_id: string | null;
}
