import type { RequestHandler } from "./$types.js";
import { addClient, removeClient } from "$lib/server/broadcast.js";

export const GET: RequestHandler = () => {
  const encoder = new TextEncoder();
  let heartbeatTimer: ReturnType<typeof setInterval>;
  let controller: ReadableStreamDefaultController;

  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl;
      addClient(controller);
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          clearInterval(heartbeatTimer);
        }
      }, 30000);
    },
    cancel() {
      removeClient(controller);
      clearInterval(heartbeatTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
};
