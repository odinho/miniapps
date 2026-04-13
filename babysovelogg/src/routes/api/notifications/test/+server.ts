import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { db } from "$lib/server/db.js";
import type { Baby } from "$lib/types.js";
import { sendPushToBaby } from "$lib/server/webpush.js";

/** Trigger a test notification for debugging. Useful after subscribing. */
export const POST: RequestHandler = async () => {
  const baby = db.prepare("SELECT * FROM baby ORDER BY id DESC LIMIT 1").get() as Baby | undefined;
  if (!baby) return json({ error: "no_baby" }, { status: 400 });

  const result = await sendPushToBaby(baby.id, {
    title: "Babysovelogg",
    body: "Varsel verkar! 👶",
    tag: "test",
  });

  return json(result);
};
