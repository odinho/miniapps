# Notifications Plan

Drafted 2026-04-13. Captures the design space for proactive notifications — the first concrete use case being the rescue nap wake-time recommendation.

---

## Why Now

The app already computes prediction signals that would benefit from a proactive nudge instead of requiring the parent to open the app:

- **Rescue nap wake time** — `prediction.rescueNap.recommendedWakeTime` is computed server-side. If the parent isn't watching the app when that moment arrives, the baby sleeps past the light-phase window and the whole rationale for the guidance is lost.
- **Light-phase windows during extra naps** — same reasoning, but more granular.
- **Bedtime approach / nap overdue** — currently shown in the app; push would let the parent act without checking.

Rescue naps are the strongest justification right now: the recommendation is time-sensitive (fires once per event, miss the window and it's useless), low-frequency (maybe a few times a month per baby), and high-value (protects bedtime + nighttime sleep quality).

## Architecture Sketch

### Option A: Web Push (recommended)

Standards-based, works across browsers on desktop and Android. Flow:

1. Client registers a service worker and subscribes to Push via `PushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY })`.
2. Server stores the `PushSubscription` object (endpoint + keys) keyed to baby/user.
3. Server runs a scheduler (cron-ish loop or per-event timer) that inspects current `prediction` state and decides when to fire.
4. Server sends a push via `web-push` library (Node) using the stored VAPID keys.
5. Service worker receives the event, shows `self.registration.showNotification(...)`.

**Pros**: works offline (the push wakes the SW), no polling, standards-based, Chrome/Firefox/Edge all support it.
**Cons**: iOS Safari only supports Web Push from a PWA installed to home screen (16.4+). For iOS browser tabs, there's no alternative short of native.

### Option B: In-tab timers

If the app tab is open, you can just `setTimeout` to the recommended wake time and fire a `new Notification(...)` (after requesting permission). Simple, no server changes, but only fires if the tab stays open and the laptop/phone isn't asleep.

Useful as a **fallback** when Web Push permission is denied or not granted.

### Option C: Server-Sent Events (already in the app)

The existing SSE sync channel could push a "show notification now" message, and the client-side SW (or page) would call `showNotification`. But this requires the tab to be open — SSE doesn't wake a closed tab.

### Recommendation

Start with **A (Web Push)** as the primary path, with **B (in-tab)** as graceful degradation. C isn't worth building a separate path for — if the tab is open, the existing UI banner + a `Notification()` call from the page works.

## What Changes in the Codebase

### Client

- **Service worker** (`static/sw.js` or `src/service-worker/index.ts`) — register push listener, show notification on event. SvelteKit has first-class SW support via `src/service-worker/index.ts`.
- **Subscription UI** — a toggle on the settings page: "Få varsel". On enable, request permission, subscribe, POST the subscription to the server.
- **Subscription management** — handle `pushsubscriptionchange`, keep the server copy in sync.

### Server

- **`notification_subscriptions` table**:
  ```sql
  CREATE TABLE notification_subscriptions (
    id INTEGER PRIMARY KEY,
    baby_id INTEGER NOT NULL REFERENCES baby(id),
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL,
    user_agent TEXT
  );
  ```
- **`notification_schedule` table** (or in-memory timer map) — one-shot scheduled pushes:
  ```sql
  CREATE TABLE notification_schedule (
    id INTEGER PRIMARY KEY,
    baby_id INTEGER NOT NULL,
    kind TEXT NOT NULL, -- 'rescue_wake', 'bedtime_approaching', ...
    fire_at TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE, -- e.g. 'rescue_wake:slp_abc123'
    payload_json TEXT,
    sent_at TEXT,
    cancelled_at TEXT
  );
  ```
- **Scheduler loop** — a `setInterval` (~every 30s) that queries rows where `fire_at <= now AND sent_at IS NULL AND cancelled_at IS NULL`, sends the push, marks `sent_at`.
- **Trigger hooks** — every time an event is projected (e.g. `sleep.started`), recompute the prediction and upsert relevant schedule rows. Same for when the prediction inputs change via any event — reuse existing SSE trigger logic.
- **User preferences** — per-baby opt-in per notification type, plus quiet hours (e.g. no push 22:00-06:00 unless "wake alarm" type). Simple JSON column on `baby` row to start.

### Config

- VAPID keys generated once, stored in env. Public key baked into client, private key on server.

## Notification Triggers (backlog)

Ranked by value / ease.

| Trigger | Fire when | Cancel when | Priority |
|---------|-----------|-------------|----------|
| **Rescue wake** | Active nap is rescue nap, fire a few min before `recommendedWakeTime` | Sleep ends or is paused | **P0** (first MVP) |
| **Nap overtime** | `expectedNapEnd + 20 min` and still napping | Sleep ends | P1 |
| **Bedtime approaching** | `bedtime - 30 min` and baby is awake | Night sleep starts | P1 |
| **Light-phase window** | During extra nap, at each `cyclePhase.isLightPhase` boundary | Sleep ends | P2 |
| **Nap overdue** | `nextNap + 45 min` and still awake (plus sleep pressure is high) | Nap starts | P2 |
| **Morning wake not logged** | After 09:00 if no wake/sleep event today | Event logged | P3 |

Each needs:
- A **fire predicate** (what state triggers it)
- A **cancel predicate** (what state invalidates it)
- A **dedupe key** (so re-running the scheduler doesn't double-schedule)
- **Copy** (Nynorsk)

## MVP Scope

Aim for the smallest useful slice:

1. Service worker registration + Web Push subscription flow.
2. `notification_subscriptions` table + endpoints (`POST /api/notifications/subscribe`, `DELETE /api/notifications/subscribe`).
3. Settings toggle: "Varsel for reddingslur".
4. Scheduler that handles **only the rescue wake trigger** (P0).
5. Fallback: if no push subscription and the app is open on a nap screen, schedule a client-side `setTimeout` to fire an in-page `Notification`.

Everything else (other trigger types, quiet hours, per-trigger opt-in UI, iOS PWA install prompt) can be layered on after the rescue wake path is proven end-to-end.

## Open Questions

- **Single-user vs multi-user**: the app is currently single-tenant. Subscriptions can key off baby_id alone. If multi-user arrives later, we need user_id too.
- **Self-hosted deployment**: the app runs on the user's own server (openclaw). Is the server always reachable by Chrome/FCM push endpoints from the internet? If yes, Web Push works. If not, we fall back to in-tab.
- **iOS coverage**: what fraction of use is from iOS browser tabs? If significant, we need to push the "install as PWA" path.
- **Sound / vibration**: Web Push supports `vibrate` and custom sounds via the SW. For a rescue wake notification, a distinct sound would be useful — worth considering.
- **Snooze**: tapping the notification could offer "extend 5 min" which cancels + reschedules. Nice-to-have.

## Notes

- The `prediction` object already has everything needed for P0 (`rescueNap.recommendedWakeTime`). No prediction engine changes required for MVP.
- The existing SSE channel is a useful debug tool: when a notification is scheduled, include it in the state stream so the UI can show "varsel kl. 14:51" and let the parent cancel it from the active nap screen.
