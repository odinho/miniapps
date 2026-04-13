import { startNotificationLoop } from "$lib/server/notification-scheduler.js";

// Start background notification scheduler on server boot.
// Guard so repeated HMR reloads in dev don't spawn multiple loops.
startNotificationLoop();
