# Architecture

## Overview

SvelteKit 5 PWA with an event-sourced SQLite backend. The server runs on Node.js via `adapter-node`. All clients share one SQLite database per family — no auth, no user accounts.

```
Browser (Svelte 5)  ──POST──▶  SvelteKit API routes  ──▶  Event store (SQLite)
         ◀──SSE───             ◀─ broadcast ─              ▶ Projections (SQLite)
```

## Event Sourcing

All mutations are stored as **events** in an append-only log (`events` table). Current state is derived by replaying events into denormalized tables (materialized views). This gives:

- Full audit trail — nothing is ever truly deleted
- Offline sync — clients queue events locally, POST them when online
- Rebuildable state — `rebuildAll()` replays all events from scratch
- Deduplication — `(client_id, client_event_id)` is unique

### Event Types

| Event | Description |
|-------|-------------|
| `baby.created` | New baby added (onboarding) |
| `baby.updated` | Name, birthdate, nap count, or potty mode changed |
| `sleep.started` | Sleep session begins (nap or night) |
| `sleep.ended` | Sleep session ends |
| `sleep.updated` | Edit start/end time, type, notes, mood, method, woke-by |
| `sleep.manual` | Retroactive sleep entry (has both start and end) |
| `sleep.deleted` | Soft-delete a sleep (sets `deleted = 1`) |
| `sleep.restarted` | Undo end-sleep (clears `end_time` back to NULL) |
| `sleep.tagged` | Add mood/method/fall-asleep-time tags to a sleep |
| `sleep.paused` | Pause an active sleep |
| `sleep.resumed` | Resume a paused sleep |
| `diaper.logged` | Log a diaper change or potty visit |
| `diaper.updated` | Edit type, amount, or note |
| `diaper.deleted` | Soft-delete a diaper entry |
| `day.started` | Log morning wake-up time |

Each event has: `id` (auto-increment), `type`, `payload` (JSON), `client_id`, `client_event_id`, `timestamp`, `domain_id`.

### Database Tables

**Source of truth:**
- `events` — append-only event log

**Materialized views (rebuilt from events):**
- `baby` — baby profile (name, birthdate, potty_mode, custom_nap_count)
- `sleep_log` — sleep sessions with mood/method/woke-by metadata
- `sleep_pauses` — pause/resume records per sleep
- `diaper_log` — diaper changes and potty visits
- `day_start` — daily wake-up times

See `src/lib/server/db.ts` for the full schema.

## Server

SvelteKit with `adapter-node`. No external framework — SvelteKit handles routing, body parsing, static serving.

### Key Server Files

- `src/lib/server/db.ts` — SQLite setup (better-sqlite3), schema init
- `src/lib/server/events.ts` — Event store (append with dedup, batch transactions)
- `src/lib/server/projections.ts` — Applies events to materialized tables, `rebuildAll()`
- `src/lib/server/schemas.ts` — Valibot validation for event payloads
- `src/lib/server/state.ts` — Computes full app state from DB (baby, sleeps, predictions)
- `src/lib/server/broadcast.ts` — SSE client management

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/state` | Full current state (baby, active sleep, today's sleeps, predictions, stats) |
| `GET` | `/api/events?limit=&offset=` | Event log with pagination |
| `POST` | `/api/events` | Append event(s), returns updated state + broadcasts via SSE |
| `GET` | `/api/sleeps?from=&to=&limit=` | Sleep log with filters |
| `GET` | `/api/diapers?from=&to=&limit=` | Diaper log with filters |
| `GET` | `/api/wakeups?from=&to=` | Wake-up times |
| `GET` | `/api/stream` | SSE stream for real-time updates |
| `GET` | `/api/export` | Full data export (JSON) |
| `POST` | `/api/import/napper` | Import CSV from Napper app |
| `POST` | `/api/admin/rebuild` | Rebuild all projections from events |

## Client

SvelteKit 5 with Svelte's runes (`$state`, `$derived`, `$effect`). No external state management — app state lives in two stores.

### Stores

- `src/lib/stores/app.svelte.ts` — Single source of truth for UI state (`AppState`: baby, activeSleep, todaySleeps, stats, prediction, diaperCount, todayWakeUp)
- `src/lib/stores/sync.svelte.ts` — SSE connection, event sending (online/offline), queue flushing

### Components

- `Arc.svelte` — 12-hour semicircular timeline (SVG). Shows completed sleeps, active sleep bubble, predicted naps, bedtime endpoint.
- `Timer.svelte` — Countdown/countup display in arc center
- `SleepButton.svelte` — Start/end sleep toggle
- `TagSheet.svelte` — Bottom sheet for mood/method/fall-asleep-time after starting sleep
- `WakeUpSheet.svelte` — Bottom sheet for woke-by/notes after ending sleep
- `DiaperForm.svelte` — Diaper/potty logging form
- `EditSleepModal.svelte` — Full sleep edit modal (from history or arc tap)
- `EditDiaperModal.svelte` — Diaper/potty edit modal

### Pages

- `/` — Dashboard (arc, timer, button, summary stats, morning prompt)
- `/history` — Chronological log with inline editing and manual entry
- `/stats` — Bar charts and weekly trends
- `/settings` — Baby profile, onboarding, nap count, potty mode, Napper import
- `/events` — Debug event viewer (raw event log)

## Offline Support

1. Client generates a `clientId` (stored in localStorage)
2. When online, events are POSTed to `/api/events` and server returns updated state
3. When offline, events are queued in localStorage and state is updated optimistically
4. On reconnect, queued events are flushed to the server
5. Server deduplicates by `(client_id, client_event_id)`

Optimistic updates use `applyOptimisticEvent()` in `src/lib/offline-queue.ts` — a pure function that mirrors server-side projections for the client state.

**Note:** `structuredClone` doesn't work on Svelte 5 `$state` proxies. The optimistic updater uses `JSON.parse(JSON.stringify(state))` instead.

## Real-time Sync (SSE)

The server maintains a set of SSE connections via `src/lib/server/broadcast.ts`. When any client posts events, all connected clients receive the updated state as an SSE `update` event. The stream sends an initial comment (`:`) to flush headers and reliably trigger the browser's `open` event.

Client auto-reconnects with exponential backoff (1s → 30s max). A 1-second suppression window after local mutations prevents SSE updates from overwriting optimistic state.

## Prediction Engine

Located in `src/lib/engine/schedule.ts`. Uses age-based wake window tables from `constants.ts` to predict:

- **Next nap** — based on time since last wake-up and age
- **Day's nap schedule** — all predicted naps anchored on morning wake-up time
- **Bedtime** — recommended based on last nap end and age

The 12-hour arc visualizes completed sleeps and predictions on a semicircular timeline.

## Themes

Auto-switches between day (light pastels) and night (dark blue/purple with animated stars) based on time of day. Controlled via `data-theme` attribute on `<html>` and CSS custom properties. Both `[data-theme="day"]` and `[data-theme="night"]` selectors are defined explicitly.
