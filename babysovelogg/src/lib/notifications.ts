/**
 * Client-side Web Push subscription helpers. Handles permission, SW registration,
 * subscription, and unsubscription. Designed to be idempotent — calling subscribe()
 * repeatedly won't create duplicates server-side thanks to the ON CONFLICT upsert.
 */

export type NotificationStatus =
  | "unsupported"
  | "permission-default"
  | "permission-denied"
  | "not-subscribed"
  | "subscribed";

export function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isSupported()) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.ready);
}

export async function getStatus(): Promise<NotificationStatus> {
  if (!isSupported()) return "unsupported";
  if (Notification.permission === "denied") return "permission-denied";
  if (Notification.permission === "default") return "permission-default";
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "subscribed" : "not-subscribed";
}

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

export async function subscribe(): Promise<{ ok: boolean; error?: string }> {
  if (!isSupported()) return { ok: false, error: "unsupported" };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, error: "permission_denied" };

  const reg = await getRegistration();
  if (!reg) return { ok: false, error: "no_registration" };

  // Fetch VAPID public key from server
  const keyRes = await fetch("/api/notifications/vapid-key");
  if (!keyRes.ok) return { ok: false, error: "vapid_key_fetch_failed" };
  const { publicKey } = (await keyRes.json()) as { publicKey: string };

  // Subscribe (or reuse existing subscription)
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const subJson = sub.toJSON();
  const res = await fetch("/api/notifications/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscription: {
        endpoint: subJson.endpoint,
        keys: { p256dh: subJson.keys?.p256dh, auth: subJson.keys?.auth },
      },
      userAgent: navigator.userAgent,
    }),
  });
  if (!res.ok) return { ok: false, error: "server_subscribe_failed" };
  return { ok: true };
}

export async function unsubscribe(): Promise<{ ok: boolean }> {
  if (!isSupported()) return { ok: false };
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return { ok: true };

  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await fetch("/api/notifications/subscribe", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  return { ok: true };
}

export async function sendTest(): Promise<unknown> {
  const res = await fetch("/api/notifications/test", { method: "POST" });
  return res.json();
}
