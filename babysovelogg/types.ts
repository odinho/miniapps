// Shared domain types used by both server and client

export interface Baby {
  id: number;
  name: string;
  birthdate: string;
  created_at: string;
  custom_nap_count: number | null;
  potty_mode: number;
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
  woke_by: string | null;
  wake_notes: string | null;
  deleted: number;
  pauses?: SleepPauseRow[];
}

export interface SleepPauseRow {
  id: number;
  sleep_id: number;
  pause_time: string;
  resume_time: string | null;
}

export interface DiaperLogRow {
  id: number;
  baby_id: number;
  time: string;
  type: string;
  amount: string | null;
  note: string | null;
  deleted: number;
}

export interface DayStartRow {
  id: number;
  baby_id: number;
  date: string;
  wake_time: string;
  created_at: string;
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

export interface EventRow {
  id: number;
  type: string;
  payload: string;
  client_id: string | null;
  client_event_id: string | null;
  timestamp: string;
}
