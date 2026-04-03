// Shared domain types used by both server and client

export interface Baby {
  id: number;
  name: string;
  birthdate: string;
  created_at: string;
  custom_nap_count: number | null;
  potty_mode: number;
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
  wake_time: string;
  created_at: string;
  created_by_event_id: number | null;
}

/** Unified sleep entry used by both engine/schedule.ts and engine/stats.ts */
export interface SleepEntry {
  start_time: string;
  end_time: string | null;
  type: "nap" | "night";
  pauses?: SleepPause[];
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
  features?: Partial<PredictionFeatures>;
  /** Active prediction strategy — widens wake window clamp for emerging babies. */
  strategy?: "newborn_guidance" | "emerging_rhythm" | "routine_schedule";
  /** @internal Lazy cache for prediction pipeline. Do not set manually. */
  _cache?: unknown;
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
