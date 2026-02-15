# Architecture

## Event Sourcing

All mutations are stored as **events** in an append-only log (`events` table). Current state is derived by replaying events into denormalized tables (materialized views). This gives:

- Full audit trail — nothing is ever truly deleted
- Offline sync — clients queue events locally, POST them when online
- Rebuildable state — `rebuildAll()` in `server/projections.ts` replays all events from scratch

### Event Types

| Event | Description |
|-------|-------------|
| `baby.created` | New baby added (onboarding) |
| `baby.updated` | Name or birthdate changed |
| `sleep.started` | Sleep session begins |
| `sleep.ended` | Sleep session ends |
| `sleep.updated` | Edit start/end time, type, notes, mood, method |
| `sleep.manual` | Retroactive sleep entry (has both start and end) |
| `sleep.deleted` | Soft-delete a sleep (sets `deleted = 1`) |
| `sleep.tagged` | Add mood/method tags to a sleep |
| `sleep.paused` | Pause an active sleep |
| `sleep.resumed` | Resume a paused sleep |
| `diaper.logged` | Log a diaper change |
| `diaper.deleted` | Soft-delete a diaper entry |
| `day.started` | Log morning wake-up time |

Each event has: `id` (auto-increment), `type`, `payload` (JSON), `client_id` (for dedup), `timestamp`.

### Database Tables

**Source of truth:**
- `events` — append-only event log

**Materialized views (rebuilt from events):**
- `baby` — baby info
- `sleep_log` — sleep sessions with optional mood/method
- `sleep_pauses` — pause/resume records per sleep
- `diaper_log` — diaper changes
- `day_start` — daily wake-up times

See `server/db.ts` for the full schema.

## Server

Plain Node.js HTTP server (no framework). See `server/` directory:

- `index.ts` — entry point, starts HTTP server
- `db.ts` — SQLite setup and migrations
- `events.ts` — event store (append, query)
- `projections.ts` — applies events to materialized tables
- `api.ts` — route handlers and SSE broadcasting

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/state` | Full current state (baby, active sleep, today's sleeps, predictions, stats) |
| `GET` | `/api/events?since=<id>` | Event log (for sync) |
| `POST` | `/api/events` | Append event(s), returns updated state |
| `GET` | `/api/sleeps?from=&to=&limit=` | Sleep log with filters |
| `GET` | `/api/diapers?from=&to=&limit=` | Diaper log with filters |
| `GET` | `/api/stats?days=14` | Computed statistics |
| `GET` | `/api/stream` | SSE stream for real-time updates |
| `GET` | `/api/health` | Health check |
| `GET` | `/*` | Static file serving from `dist/` |

## Client

Vanilla TypeScript PWA — no framework. Built with esbuild into a single `dist/bundle.js`.

### Key Modules

- `src/main.ts` — app entry, routing, navigation
- `src/api.ts` — HTTP client for server API
- `src/sync.ts` — offline event queue + sync on reconnect
- `src/engine/` — shared logic (used by both client and server):
  - `schedule.ts` — nap prediction, wake windows, bedtime recommendations
  - `stats.ts` — daily/weekly stats calculations
  - `constants.ts` — age-based sleep constants
- `src/ui/` — UI components (all render to DOM directly):
  - `dashboard.ts` — main view with arc and controls
  - `arc.ts` — 12-hour SVG arc visualization
  - `history.ts` — sleep/diaper log with editing
  - `stats.ts` — statistics page with charts
  - `settings.ts` — baby settings / onboarding
  - `components.ts` — shared UI helpers (bottom sheets, modals)
  - `styles.ts` — CSS-in-JS, theme definitions (day/night)
  - `toast.ts` — toast notifications

### Offline Support

1. Client generates a `clientId` (stored in localStorage)
2. When offline, events are queued in localStorage
3. On reconnect, queued events are POSTed to `/api/events`
4. Server deduplicates by `client_id`

### Real-time Sync (SSE)

Server maintains a set of SSE connections. When any client posts an event, all connected clients receive the update via `GET /api/stream`. Client auto-reconnects on disconnect.

### Themes

Auto-switches between day (light pastels) and night (dark blue/purple with stars) based on time of day. Controlled via CSS custom properties.

## Prediction Engine

Located in `src/engine/schedule.ts`. Uses age-based wake window tables from `constants.ts` to predict:

- **Next nap** — based on time since last wake-up and age
- **Day's nap schedule** — all predicted naps anchored on morning wake-up time
- **Bedtime** — recommended based on last nap end and age

The 12-hour arc on the dashboard visualizes completed sleeps and predictions on a semicircular timeline.
