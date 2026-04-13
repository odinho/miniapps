/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

const sw = self as unknown as ServiceWorkerGlobalScope;

interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  data?: Record<string, unknown>;
}

sw.addEventListener("install", () => {
  sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload: PushPayload;
  try {
    payload = event.data.json() as PushPayload;
  } catch {
    payload = { title: "Babysovelogg", body: event.data.text() };
  }

  event.waitUntil(
    sw.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag ?? "babysovelogg",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(({ icon: "/favicon.png", badge: "/favicon.png", data: payload.data }) as any),
    }),
  );
});

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const allClients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Focus an existing tab if there is one; else open a new one
      const existing = allClients.find((c) => c.url.includes(sw.registration.scope));
      if (existing) {
        await existing.focus();
      } else {
        await sw.clients.openWindow("/");
      }
    })(),
  );
});

// Handle subscription expiry — client refreshes subscription on next app open
sw.addEventListener("pushsubscriptionchange", () => {
  // No-op here; client will detect missing subscription and re-subscribe.
});
