import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types.js";
import { sendPushToFamily } from "$lib/server/webpush.js";

/** Trigger a test notification for debugging. Useful after subscribing. Sends
 *  to every device in the family (the DB is a single family). */
export const POST: RequestHandler = async () => {
  const result = await sendPushToFamily({
    title: "Babysovelogg",
    body: "Varsel verkar! 👶",
    tag: "test",
  });

  return json(result);
};
