import type { Baby, SleepLogRow, DayStartRow, DiaperLogRow } from "../types.js";
import type { DayStats } from "./engine/stats.js";
import type { PredictedNap } from "./engine/schedule.js";

const BASE = ""; // Same origin

let _onMutation: (() => void) | null = null;
export function setMutationHook(fn: () => void) {
  _onMutation = fn;
}

export interface AppState {
  baby: Baby | null;
  activeSleep: SleepLogRow | null;
  todaySleeps: SleepLogRow[];
  stats: DayStats | null;
  prediction: { nextNap: string; bedtime: string; predictedNaps: PredictedNap[] | null } | null;
  ageMonths?: number;
  diaperCount?: number;
  lastDiaperTime?: string | null;
  todayWakeUp?: DayStartRow;
}

export interface EventPayload {
  type: string;
  payload: Record<string, unknown>;
  clientId?: string;
}

export async function getDiapers(opts?: { limit?: number }): Promise<DiaperLogRow[]> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  const res = await fetch(`${BASE}/api/diapers?${params}`);
  return res.json();
}

export async function getState(): Promise<AppState> {
  const res = await fetch(`${BASE}/api/state`);
  return res.json();
}

export async function postEvents(
  events: EventPayload[],
): Promise<{ events: EventPayload[]; state: AppState }> {
  if (_onMutation) _onMutation();
  const res = await fetch(`${BASE}/api/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

export async function getStatsData(): Promise<SleepLogRow[]> {
  const from = new Date(Date.now() - 30 * 86400000).toISOString();
  const res = await fetch(`${BASE}/api/sleeps?from=${encodeURIComponent(from)}&limit=500`);
  return res.json();
}

export async function getSleeps(opts?: {
  from?: string;
  to?: string;
  limit?: number;
}): Promise<SleepLogRow[]> {
  const params = new URLSearchParams();
  if (opts?.from) params.set("from", opts.from);
  if (opts?.to) params.set("to", opts.to);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const res = await fetch(`${BASE}/api/sleeps?${params}`);
  return res.json();
}
