import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { getCurrentBaby } from "$lib/server/db.js";
import { sendPushToBaby } from "$lib/server/webpush.js";

/** Trigger a test notification for debugging. Useful after subscribing. */
export const POST: RequestHandler = async () => {
  const baby = getCurrentBaby();
  if (!baby) return json({ error: "no_baby" }, { status: 400 });

  const result = await sendPushToBaby(baby.id, {
    title: "Babysovelogg",
    body: "Varsel verkar! 👶",
    tag: "test",
  });

  return json(result);
};
