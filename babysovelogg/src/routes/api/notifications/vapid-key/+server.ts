import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { getPublicKey } from "$lib/server/webpush.js";

export const GET: RequestHandler = () => {
  const key = getPublicKey();
  if (!key) {
    return json({ error: "notifications_not_configured" }, { status: 503 });
  }
  return json({ publicKey: key });
};
