import { closeDb } from "$lib/server/db.js";
import {
  startNotificationLoop,
  stopNotificationLoop,
} from "$lib/server/notification-scheduler.js";

// Start background notification scheduler on server boot.
// Guard so repeated HMR reloads in dev don't spawn multiple loops.
startNotificationLoop();

// Cleanup on shutdown. Bun's `httpServer.close()` callback doesn't fire
// reliably, so adapter-node's `sveltekit:shutdown` event may never
// arrive — listen on SIGTERM directly. We can't make the process exit
// (something Bun-internal keeps the loop alive), but at least the
// scheduler stops and the DB closes cleanly before systemd SIGKILLs us.
function cleanup() {
  stopNotificationLoop();
  closeDb();
}
process.on("sveltekit:shutdown", cleanup);
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
