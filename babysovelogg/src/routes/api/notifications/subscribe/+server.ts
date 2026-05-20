import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db.js";
import { safeJson } from "$lib/server/request-helpers.js";
import type { Baby } from "$lib/types.js";

interface SubscribeBody {
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  userAgent?: string;
}

export const POST: RequestHandler = async ({ request }) => {
  const baby = db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as Baby | undefined;
  if (!baby) return json({ error: "no_baby" }, { status: 400 });

  const body = await safeJson<SubscribeBody>(request);
  if (!body) return json({ error: "invalid_json" }, { status: 400 });

  const { subscription, userAgent } = body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return json({ error: "invalid_subscription" }, { status: 400 });
  }

  db.prepare(
    `INSERT INTO notification_subscriptions (baby_id, endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       baby_id = excluded.baby_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = excluded.user_agent`,
  ).run(baby.id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent ?? null);

  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ request }) => {
  const body = await safeJson<{ endpoint?: string }>(request);
  if (!body) return json({ error: "invalid_json" }, { status: 400 });
  if (!body.endpoint) return json({ error: "endpoint_required" }, { status: 400 });

  const result = db
    .prepare("DELETE FROM notification_subscriptions WHERE endpoint = ?")
    .run(body.endpoint);

  return json({ ok: true, deleted: result.changes });
};
