# Notifications

Web Push notifications for time-sensitive sleep guidance. Implemented 2026-04-13.

## How It Works

Standard Web Push — no third-party gateway. The browser vendor (FCM / Mozilla / Apple) delivers the push for free.

**Server** sends pushes via the `web-push` npm library using VAPID keys. A background loop (30s interval) fires due notifications. State changes trigger `reconcileNotifications()` which upserts/cancels scheduled rows based on current prediction state.

**Client** registers a service worker (`src/service-worker/index.ts`) that handles `push` events and shows `showNotification`. Subscription management is in `src/lib/notifications.ts`.

### Key files

| File | Role |
|------|------|
| `src/lib/server/webpush.ts` | VAPID config, `sendPush`, `sendPushToBaby` |
| `src/lib/server/notification-scheduler.ts` | `reconcileNotifications` (trigger logic), `fireDueNotifications` (send loop) |
| `src/lib/server/notification-prefs.ts` | Per-trigger opt-in prefs (JSON column on `notification_preferences` table) |
| `src/lib/notifications.ts` | Client-side subscribe/unsubscribe, prefs API, trigger labels |
| `src/service-worker/index.ts` | Push event handler, notification click → focus/open tab |
| `src/hooks.server.ts` | Starts the notification loop on server boot |
| `src/routes/api/notifications/` | Endpoints: `vapid-key`, `subscribe`, `preferences`, `test` |

### Database tables

- `notification_subscriptions` — one row per device (endpoint + p256dh + auth keys)
- `notification_schedule` — one-shot scheduled pushes (dedupe-keyed, cancelled/sent tracking)
- `notification_preferences` — per-baby JSON prefs for which triggers are enabled

## Triggers

| Trigger | Kind | Fires | Default | Cancel |
|---------|------|-------|---------|--------|
| Rescue wake | `rescue_wake` | 2 min before `rescueNap.recommendedWakeTime` | on | sleep ends |
| Nap ending soon | `nap_ending_soon` | 2 min before `expectedNapEnd` (non-rescue naps) | on | sleep ends |
| Nap overtime | `nap_overtime` | 20 min after `expectedNapEnd` | on | sleep ends |
| Bedtime approaching | `bedtime_approaching` | 30 min before `bedtime` (baby awake) | on | night sleep starts |
| Nap overdue | `nap_overdue` | 30 min after `nextNap` (baby awake, naps not done) | **off** | nap starts |

`rescue_wake` and `nap_ending_soon` are mutually exclusive — rescue naps get only the rescue trigger.

Each trigger uses a unique `dedupe_key` so re-running reconciliation is idempotent. The scheduler cancels pending rows when conditions change (e.g. sleep ends → cancel all nap-related rows).

## Setup

Generate VAPID keys (once per deployment):

```bash
bun scripts/generate-vapid-keys.ts
```

Add to env:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

The server needs outbound HTTPS to push endpoints (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`).

Users subscribe in Settings → "Varsel" → "Slå på varsel". Per-trigger checkboxes appear after subscribing.

## Future Work

- **Morning wake not logged** — needs a time-based trigger (cron-style) rather than state-change-based. The scheduler loop could check clock conditions.
- **Quiet hours** — don't fire between 22:00–06:00 (except "wake alarm" types).
- **Snooze** — tapping notification offers "+5 min" which reschedules.
- **Sound / vibration** — distinct sounds per trigger type.
- **iOS PWA install prompt** — Web Push on iOS only works from installed PWAs (16.4+).
- **Multi-user** — currently single-tenant. If multi-user arrives, subscriptions need a user_id.
