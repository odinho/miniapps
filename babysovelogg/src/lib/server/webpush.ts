import webpush from "web-push";
import { db } from "./db.js";

/**
 * VAPID configuration. Keys must be generated once per deployment via
 * `bun scripts/generate-vapid-keys.ts` and stored as env vars:
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: or https: URL)
 *
 * The public key is safe to expose to clients; the private key must stay on the server.
 */

let configured = false;
let publicKey: string | null = null;

function configure() {
  if (configured) return;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:noreply@babysovelogg.local";
  if (!pub || !priv) {
    // eslint-disable-next-line no-console
    console.warn(
      "[webpush] VAPID keys not set — push notifications disabled. " +
        "Run `bun scripts/generate-vapid-keys.ts` and set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY.",
    );
    return;
  }
  webpush.setVapidDetails(subject, pub, priv);
  publicKey = pub;
  configured = true;
}

export function getPublicKey(): string | null {
  configure();
  return publicKey;
}

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  data?: Record<string, unknown>;
}

/**
 * Send a push to one subscription. Returns { ok: true } or { ok: false, gone: boolean }.
 * If `gone` is true, the subscription is invalid (404/410) and should be removed from DB.
 */
async function sendPush(
  sub: PushSubscriptionData,
  payload: PushPayload,
): Promise<{ ok: true } | { ok: false; gone: boolean; error: string }> {
  configure();
  if (!configured) return { ok: false, gone: false, error: "VAPID not configured" };

  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
    return { ok: true };
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number })?.statusCode ?? 0;
    const gone = statusCode === 404 || statusCode === 410;
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, gone, error: message };
  }
}

/**
 * Send a push to every subscription for a given baby. Removes subscriptions
 * that return 404/410 (unsubscribed or expired).
 */
export async function sendPushToBaby(
  babyId: number,
  payload: PushPayload,
): Promise<{ sent: number; removed: number; failed: number }> {
  const subs = db
    .prepare("SELECT * FROM notification_subscriptions WHERE baby_id = ?")
    .all(babyId) as Array<{ id: number; endpoint: string; p256dh: string; auth: string }>;

  const results = await Promise.all(
    subs.map((s) =>
      sendPush(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      ).then((result) => ({ s, result })),
    ),
  );

  let sent = 0;
  let removed = 0;
  let failed = 0;
  for (const { s, result } of results) {
    if (result.ok) {
      sent++;
    } else if (result.gone) {
      db.prepare("DELETE FROM notification_subscriptions WHERE id = ?").run(s.id);
      removed++;
    } else {
      failed++;
    }
  }

  return { sent, removed, failed };
}
