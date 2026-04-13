import { db } from "./db.js";
import { sendPushToBaby } from "./webpush.js";
import type { Baby, SleepLogRow } from "$lib/types.js";
import type { Prediction } from "$lib/stores/app.svelte.js";

/** Looser shape than AppState — accepts server-side state where activeSleep may be undefined. */
export interface ReconcileInput {
  baby: Baby | null;
  activeSleep: SleepLogRow | null | undefined;
  prediction: Prediction | null;
}

/** Pre-notify offset: fire this many minutes before the recommended wake time. */
const PRE_NOTIFY_MIN = 2;

interface NotificationRow {
  id: number;
  baby_id: number;
  kind: string;
  fire_at: string;
  dedupe_key: string;
  payload_json: string;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Called after every state update. Upserts/cancels notification rows based on
 * current state. Idempotent — re-running with the same state is a no-op.
 */
export function reconcileNotifications(state: ReconcileInput): void {
  const baby = state.baby;
  if (!baby) return;

  const active = state.activeSleep;
  const rescue = state.prediction?.rescueNap;

  if (active && active.type === "nap" && !active.end_time && rescue) {
    const dedupeKey = `rescue_wake:${active.domain_id}`;
    const fireAtMs = new Date(rescue.recommendedWakeTime).getTime() - PRE_NOTIFY_MIN * 60_000;
    const fireAt = new Date(fireAtMs).toISOString();
    const payload = {
      title: "Reddingslur – vekking snart",
      body: `Tilrådd å vekka kl. ${formatTime(rescue.recommendedWakeTime)} (lett fase)`,
      tag: dedupeKey,
      data: { kind: "rescue_wake", sleepDomainId: active.domain_id },
    };

    db.prepare(
      `INSERT INTO notification_schedule (baby_id, kind, fire_at, dedupe_key, payload_json)
       VALUES (?, 'rescue_wake', ?, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         fire_at = excluded.fire_at,
         payload_json = excluded.payload_json,
         cancelled_at = NULL
       WHERE notification_schedule.sent_at IS NULL`,
    ).run(baby.id, fireAt, dedupeKey, JSON.stringify(payload));
  } else {
    // No active rescue nap — cancel any pending rescue wake rows for this baby
    db.prepare(
      `UPDATE notification_schedule
       SET cancelled_at = datetime('now')
       WHERE baby_id = ? AND kind = 'rescue_wake'
         AND sent_at IS NULL AND cancelled_at IS NULL`,
    ).run(baby.id);
  }
}

/**
 * Find notifications whose fire_at has passed and send them.
 * Returns the number of notifications actually sent.
 */
export async function fireDueNotifications(now: Date = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const due = db
    .prepare(
      `SELECT * FROM notification_schedule
       WHERE fire_at <= ? AND sent_at IS NULL AND cancelled_at IS NULL
       ORDER BY fire_at ASC LIMIT 100`,
    )
    .all(nowIso) as NotificationRow[];

  const results = await Promise.all(
    due.map(async (row) => {
      try {
        const payload = JSON.parse(row.payload_json);
        const result = await sendPushToBaby(row.baby_id, payload);
        db.prepare("UPDATE notification_schedule SET sent_at = datetime('now') WHERE id = ?").run(
          row.id,
        );
        return result.sent > 0;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[notification-scheduler] send failed", { id: row.id, err });
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

let loopHandle: ReturnType<typeof setInterval> | null = null;

/** Start the background loop (call once at server startup). */
export function startNotificationLoop(intervalMs = 30_000): void {
  if (loopHandle) return;
  loopHandle = setInterval(() => {
    fireDueNotifications().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[notification-loop]", err);
    });
  }, intervalMs);
}

export function stopNotificationLoop(): void {
  if (loopHandle) {
    clearInterval(loopHandle);
    loopHandle = null;
  }
}
