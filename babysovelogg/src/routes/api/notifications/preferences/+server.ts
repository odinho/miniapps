import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { resolveBaby } from "$lib/server/db.js";
import { safeJson } from "$lib/server/request-helpers.js";
import {
  getPrefs,
  setPrefs,
  ALL_KINDS,
  type NotificationKind,
  type NotificationPrefs,
} from "$lib/server/notification-prefs.js";

export const GET: RequestHandler = ({ url }) => {
  const baby = resolveBaby(url);
  if (!baby) return json({ error: "no_baby" }, { status: 400 });
  return json({ prefs: getPrefs(baby.id), kinds: ALL_KINDS });
};

export const PUT: RequestHandler = async ({ request, url }) => {
  const baby = resolveBaby(url);
  if (!baby) return json({ error: "no_baby" }, { status: 400 });

  const body = await safeJson<Partial<NotificationPrefs>>(request);
  if (!body) return json({ error: "invalid_json" }, { status: 400 });

  const patch: Partial<NotificationPrefs> = {};
  for (const key of Object.keys(body) as NotificationKind[]) {
    if (ALL_KINDS.includes(key) && typeof body[key] === "boolean") {
      patch[key] = body[key];
    }
  }
  const merged = setPrefs(baby.id, patch);
  return json({ prefs: merged });
};
