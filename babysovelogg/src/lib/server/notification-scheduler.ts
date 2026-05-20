import { db } from "./db.js";
import { sendPushToBaby } from "./webpush.js";
import { getPrefs, type NotificationKind } from "./notification-prefs.js";
import { isoToDateInTz } from "$lib/tz.js";
import type { Baby, SleepLogRow } from "$lib/types.js";
import type { Prediction } from "$lib/stores/app.svelte.js";

/** Pre-notify offset: fire this many minutes before end-of-nap / bedtime. */
const PRE_NOTIFY_MIN = 2;
/** Minutes past expected end before "nap overtime" fires. */
const OVERTIME_OFFSET_MIN = 20;
/** Minutes before bedtime to fire bedtime_approaching. */
const BEDTIME_APPROACH_MIN = 30;
/** Minutes before predicted nap to fire nap_approaching wind-down notice. */
const NAP_APPROACH_MIN = 30;
/** Minutes past nextNap before "nap overdue" fires. */
const OVERDUE_OFFSET_MIN = 30;

/** Looser shape than AppState — accepts server-side state where activeSleep may be undefined. */
export interface ReconcileInput {
  baby: Baby | null;
  activeSleep: SleepLogRow | null | undefined;
  prediction: Prediction | null;
}

interface NotificationRow {
  id: number;
  baby_id: number;
  kind: string;
  fire_at: string;
  dedupe_key: string;
  payload_json: string;
  attempts: number;
}

// Bound transient retries: at most 3 tries, and never more than ~5 min past
// the original fire_at — by then the notification is stale anyway and the
// parent would rather not see an old alert pop up. With the 30s poll loop
// this means a failed push gets ~3 quick attempts and then drops.
const SEND_MAX_ATTEMPTS = 3;
const SEND_MAX_AGE_MS = 5 * 60 * 1000;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function upsert(
  babyId: number,
  kind: NotificationKind,
  fireAtMs: number,
  dedupeKey: string,
  payload: { title: string; body: string; data?: Record<string, unknown> },
): void {
  const fireAt = new Date(fireAtMs).toISOString();
  const payloadJson = JSON.stringify({ ...payload, tag: dedupeKey });
  db.prepare(
    `INSERT INTO notification_schedule (baby_id, kind, fire_at, dedupe_key, payload_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO UPDATE SET
       fire_at = excluded.fire_at,
       payload_json = excluded.payload_json,
       cancelled_at = NULL
     WHERE notification_schedule.sent_at IS NULL`,
  ).run(babyId, kind, fireAt, dedupeKey, payloadJson);
}

function cancelByKind(babyId: number, kind: NotificationKind): void {
  db.prepare(
    `UPDATE notification_schedule
     SET cancelled_at = datetime('now')
     WHERE baby_id = ? AND kind = ?
       AND sent_at IS NULL AND cancelled_at IS NULL`,
  ).run(babyId, kind);
}

/**
 * Called after every state update. Upserts/cancels notification rows based on
 * current state and per-baby preferences. Idempotent.
 */
export function reconcileNotifications(state: ReconcileInput): void {
  const baby = state.baby;
  if (!baby) return;
  const prefs = getPrefs(baby.id);

  const active = state.activeSleep ?? null;
  const pred = state.prediction;
  const isNappingActive = !!(active && active.type === "nap" && !active.end_time);
  const isAwake = !active || !!active.end_time;
  const tz = baby.timezone ?? "UTC";

  // ── Nap budget cap (trend-anchored) ─────────────────────────────
  // Fires when the engine recommends a cap and it's `firm` urgency
  // (i.e. uncapped overshoot > tolerance). Fires 5 min before wakeBy so
  // the parent has lead time to get to the baby. Skipped silently when
  // pref is off.
  //
  // Dedupe is *stable per active nap* — keyed on domain_id, not wakeBy.
  // wakeBy can drift forward across reconciles (engine recomputes), and
  // when the elapsed-clamp pushes wakeBy to now+1 it becomes timestamp-
  // valued garbage. With wakeBy in the dedupe, every reconcile inserts a
  // fresh past-due row and fireDueNotifications spams the parent. With
  // stable dedupe, ON CONFLICT updates fire_at on the same row, and once
  // sent the WHERE sent_at IS NULL clause prevents re-firing.
  if (
    prefs.nap_budget_cap &&
    isNappingActive &&
    active &&
    pred?.napBudget &&
    pred.napBudget.urgency === "firm"
  ) {
    const wakeByMs = new Date(pred.napBudget.wakeBy).getTime();
    const fireAt = wakeByMs - 5 * 60_000;
    const dedupe = `nap_budget_cap:${active.domain_id}`;
    upsert(baby.id, "nap_budget_cap", fireAt, dedupe, {
      title: "Vekk for å treffe trenden",
      body: `Tilrådd kapping kl. ${formatTime(pred.napBudget.wakeBy)} – dagens søvn er på veg over snittet`,
      data: { kind: "nap_budget_cap", sleepDomainId: active.domain_id },
    });
  } else {
    cancelByKind(baby.id, "nap_budget_cap");
  }

  // ── Rescue wake ─────────────────────────────────────────────────
  if (prefs.rescue_wake && isNappingActive && active && pred?.rescueNap) {
    const dedupe = `rescue_wake:${active.domain_id}`;
    const fireAt =
      new Date(pred.rescueNap.recommendedWakeTime).getTime() - PRE_NOTIFY_MIN * 60_000;
    upsert(baby.id, "rescue_wake", fireAt, dedupe, {
      title: "Reddingslur – vekking snart",
      body: `Tilrådd å vekka kl. ${formatTime(pred.rescueNap.recommendedWakeTime)} (lett fase)`,
      data: { kind: "rescue_wake", sleepDomainId: active.domain_id },
    });
  } else {
    cancelByKind(baby.id, "rescue_wake");
  }

  // ── Nap ending soon ─────────────────────────────────────────────
  // Skip when rescue wake or nap_budget cap is active — don't double-notify.
  // Both rescue and napBudget already carry a wake-time recommendation;
  // adding "ending soon" on top creates two pushes for the same active nap
  // with potentially-conflicting times.
  if (
    prefs.nap_ending_soon &&
    isNappingActive &&
    active &&
    pred?.expectedNapEnd &&
    !pred.rescueNap &&
    !pred.napBudget
  ) {
    const dedupe = `nap_ending_soon:${active.domain_id}`;
    const fireAt = new Date(pred.expectedNapEnd).getTime() - PRE_NOTIFY_MIN * 60_000;
    upsert(baby.id, "nap_ending_soon", fireAt, dedupe, {
      title: "Luren sluttar snart",
      body: `Forventa vaknetid kl. ${formatTime(pred.expectedNapEnd)} – lett fase no`,
      data: { kind: "nap_ending_soon", sleepDomainId: active.domain_id },
    });
  } else {
    cancelByKind(baby.id, "nap_ending_soon");
  }

  // ── Nap overtime ────────────────────────────────────────────────
  if (prefs.nap_overtime && isNappingActive && active && pred?.expectedNapEnd) {
    const dedupe = `nap_overtime:${active.domain_id}`;
    const fireAt = new Date(pred.expectedNapEnd).getTime() + OVERTIME_OFFSET_MIN * 60_000;
    upsert(baby.id, "nap_overtime", fireAt, dedupe, {
      title: "Luren er over forventa",
      body: `Starta kl. ${formatTime(active.start_time)} – sjekk om ho bør vekkast`,
      data: { kind: "nap_overtime", sleepDomainId: active.domain_id },
    });
  } else {
    cancelByKind(baby.id, "nap_overtime");
  }

  // ── Bedtime approaching ─────────────────────────────────────────
  if (prefs.bedtime_approaching && isAwake && pred?.bedtime) {
    const bedtimeMs = new Date(pred.bedtime).getTime();
    const fireAt = bedtimeMs - BEDTIME_APPROACH_MIN * 60_000;
    const localDate = isoToDateInTz(new Date(bedtimeMs).toISOString(), tz);
    const dedupe = `bedtime_approaching:${localDate}`;
    upsert(baby.id, "bedtime_approaching", fireAt, dedupe, {
      title: "Leggetid snart",
      body: `Forventa kl. ${formatTime(pred.bedtime)}`,
      data: { kind: "bedtime_approaching" },
    });
  } else if (active && active.type === "night") {
    // Night sleep started — cancel any pending bedtime_approaching
    cancelByKind(baby.id, "bedtime_approaching");
  }

  // ── Nap approaching (wind-down) ─────────────────────────────────
  // 30 min before predicted nap so the parent has time to wind down
  // (lower stim, get to where the baby naps, etc.). Skip when napsAllDone
  // (bedtime_approaching covers that case).
  //
  // Rescue-after-skip exception: when napSkipped fires the engine sets
  // napsAllDone=true and collapses nextNap to bedtime, so the normal nap
  // notification would suppress. Fire a rescue-flavoured wind-down anchored
  // on the rescue window's earliest start instead — otherwise the parent
  // loses both the in-app skipped state and the push that would have nudged
  // them to act on it.
  const rescuePlan = pred?.postSkipPlan?.kind === "rescue" ? pred.postSkipPlan : null;
  const napFireTarget = rescuePlan ? rescuePlan.recommendedStart : pred?.nextNap;
  const napCanFire = isAwake && (rescuePlan ? true : pred?.nextNap && !pred.napsAllDone);
  if (prefs.nap_approaching && napCanFire && napFireTarget) {
    const napMs = new Date(napFireTarget).getTime();
    const fireAt = napMs - NAP_APPROACH_MIN * 60_000;
    const dedupe = rescuePlan
      ? `nap_approaching:rescue:${rescuePlan.recommendedStart}`
      : `nap_approaching:${napFireTarget}`;
    upsert(baby.id, "nap_approaching", fireAt, dedupe, {
      title: rescuePlan ? "Reddingslur snart" : "Snart lurtid",
      body: rescuePlan
        ? `Hoppa over morgonluren. Vurder å legge henne ned ca. kl. ${formatTime(napFireTarget)}.`
        : `Forventa kl. ${formatTime(napFireTarget)} — byrj å vinde ned.`,
      data: { kind: "nap_approaching", nextNap: napFireTarget },
    });
  } else {
    cancelByKind(baby.id, "nap_approaching");
  }

  // ── Continuation window opens ───────────────────────────────────
  // Fire immediately when the parent ends a too-short nap so they aren't
  // relying on having the dashboard open to see the banner. Dedup by the
  // closesAt timestamp — if the same window keeps reconciling we don't
  // re-send. Cancel when no longer applicable (window closed, baby is
  // sleeping again, etc).
  if (prefs.continuation_open && isAwake && pred?.continuationWindow) {
    const cw = pred.continuationWindow;
    const dedupe = `continuation_open:${cw.closesAt}`;
    upsert(baby.id, "continuation_open", Date.now(), dedupe, {
      title: "Forleng luren",
      body: `Førre lur var altfor kort. Prøv å la henne sove att — vindauget stenger ${formatTime(cw.closesAt)}.`,
      data: { kind: "continuation_open", closesAt: cw.closesAt, capLatestEnd: cw.capLatestEnd },
    });
  } else {
    cancelByKind(baby.id, "continuation_open");
  }

  // ── Nap overdue ─────────────────────────────────────────────────
  if (
    prefs.nap_overdue &&
    isAwake &&
    pred?.nextNap &&
    !pred.napsAllDone
  ) {
    const nextNapMs = new Date(pred.nextNap).getTime();
    const fireAt = nextNapMs + OVERDUE_OFFSET_MIN * 60_000;
    const localDate = isoToDateInTz(new Date(nextNapMs).toISOString(), tz);
    const dedupe = `nap_overdue:${localDate}:${pred.expectedNapCount - (pred.predictedNaps?.length ?? 0)}`;
    upsert(baby.id, "nap_overdue", fireAt, dedupe, {
      title: "Lur er forsinka",
      body: `Venta kl. ${formatTime(pred.nextNap)} – søvntrykk byggjer seg opp`,
      data: { kind: "nap_overdue" },
    });
  } else if (isNappingActive) {
    // Nap started — cancel any pending overdue for this session
    cancelByKind(baby.id, "nap_overdue");
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
        const attempts = (row.attempts ?? 0) + 1;
        // Terminal: every send either succeeded or removed a dead subscription.
        if (result.failed === 0) {
          db.prepare(
            "UPDATE notification_schedule SET sent_at = datetime('now'), attempts = ? WHERE id = ?",
          ).run(attempts, row.id);
        } else {
          // Transient failure. Give up if we've tried too many times or the
          // fire_at is past its staleness window — otherwise leave for retry.
          const tooStale = now.getTime() - new Date(row.fire_at).getTime() > SEND_MAX_AGE_MS;
          const exhausted = attempts >= SEND_MAX_ATTEMPTS;
          if (exhausted || tooStale) {
            db.prepare(
              "UPDATE notification_schedule SET cancelled_at = datetime('now'), attempts = ? WHERE id = ?",
            ).run(attempts, row.id);
          } else {
            db.prepare("UPDATE notification_schedule SET attempts = ? WHERE id = ?").run(
              attempts,
              row.id,
            );
          }
        }
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

