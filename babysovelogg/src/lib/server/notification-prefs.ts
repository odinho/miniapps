import { db } from "./db.js";

export type NotificationKind =
  | "rescue_wake"
  | "nap_ending_soon"
  | "nap_overtime"
  | "bedtime_approaching"
  | "nap_overdue"
  | "continuation_open"
  | "nap_approaching"
  | "nap_budget_cap";

export type NotificationPrefs = Record<NotificationKind, boolean>;

/** Default: all notifications on except nap_overdue (can be noisy). */
export const DEFAULT_PREFS: NotificationPrefs = {
  rescue_wake: true,
  nap_ending_soon: true,
  nap_overtime: true,
  bedtime_approaching: true,
  nap_overdue: false,
  continuation_open: true,
  nap_approaching: true,
  nap_budget_cap: true,
};

/** All notification kinds in the order they should appear in the UI. */
export const ALL_KINDS: NotificationKind[] = [
  "nap_approaching",
  "nap_budget_cap",
  "rescue_wake",
  "nap_ending_soon",
  "nap_overtime",
  "bedtime_approaching",
  "nap_overdue",
  "continuation_open",
];

export function getPrefs(babyId: number): NotificationPrefs {
  const row = db
    .prepare("SELECT prefs_json FROM notification_preferences WHERE baby_id = ?")
    .get(babyId) as { prefs_json: string } | undefined;
  if (!row) return { ...DEFAULT_PREFS };
  try {
    const parsed = JSON.parse(row.prefs_json) as Partial<NotificationPrefs>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function setPrefs(babyId: number, patch: Partial<NotificationPrefs>): NotificationPrefs {
  const current = getPrefs(babyId);
  const merged = { ...current, ...patch };
  db.prepare(
    `INSERT INTO notification_preferences (baby_id, prefs_json) VALUES (?, ?)
     ON CONFLICT(baby_id) DO UPDATE SET prefs_json = excluded.prefs_json`,
  ).run(babyId, JSON.stringify(merged));
  return merged;
}
