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

Each event has: `id` (auto-increment), `type`, `payload` (JSON), `client_id`, `client_event_id`, `timestamp`, `domain_id`.

### Database Tables

**Source of truth:**
- `events` — append-only event log

**Materialized views (rebuilt from events):**
- `baby` — baby profile (name, birthdate, potty_mode, custom_nap_count, timezone)
- `sleep_log` — sleep sessions with mood/method/woke-by metadata
- `sleep_pauses` — pause/resume records per sleep
- `diaper_log` — diaper changes and potty visits
- `day_start` — daily wake-up times

See `src/lib/server/db.ts` for the full schema.

## Server

SvelteKit with `adapter-node`. No external framework — SvelteKit handles routing, body parsing, static serving.

### Key Server Files

- `src/lib/server/db.ts` — SQLite setup (bun:sqlite), schema init
- `src/lib/server/events.ts` — Event store (append with dedup, batch transactions)
- `src/lib/server/projections.ts` — Applies events to materialized tables, `rebuildAll()`
- `src/lib/server/schemas.ts` — Valibot validation for event payloads
- `src/lib/server/state.ts` — Computes full app state from DB (baby, sleeps, predictions)
- `src/lib/server/broadcast.ts` — SSE client management

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/state` | Full current state (baby, active sleep, today's sleeps, predictions, stats) |
| `GET` | `/api/events?limit=&since=&type=&domainId=` | Event log with filtering |
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
- `ManualSleepModal.svelte` — Retroactive sleep entry modal

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

Located in `src/lib/engine/schedule.ts` with age-based priors from `constants.ts`. Adapts to the individual baby using recent sleep data.

- **Nap count** — learned from recent 5+ days (mode with >60% dominance), falls back to age default
- **Wake windows** — learned from gaps between consecutive sleeps (nap-only, excluding bedtime gap), clamped to an adapted range that widens when the baby's nap count differs from age default
- **Nap timing** — positional wake windows (1st WW typically shorter than 2nd) anchored on morning wake-up
- **Bedtime** — separate learned bedtime wake window (nap→night gap), wide sanity clamp (16:00-23:00 local)
- **Nap duration prior** — `shineDaytimeSleepMinutes(ageMonths) / resolveNapCount(ctx)`, blended with weighted-recency learned mean from recent self-wake naps. Replaces the older hardcoded ladder so a 1-nap and a 2-nap baby of the same age get sensibly different defaults.
- **Cut-short censoring** — `censorCutShortNaps` drops parent-ended naps shorter than the baby's self-wake median from duration learning, positional-duration learning, and cycle estimation. Falls back to a no-op when there are too few self-wake samples to compute a stable median. Driven by the `woke_by` field captured in the wake sheet. The median is computed over the wider 21-day window (`BabyContext.extendedSleeps`) when available so the censor can engage even for babies with few self-wakes in the recent 7 days; a per-day nap-count filter on the extended window prevents old-regime data from skewing the threshold during a 2 → 1 nap transition.
- **Population norms** — Galland 2012 regression equations and SHINE 2021 actigraphy stats in `src/lib/data/`

Backtest harness in `src/lib/engine/backtest.ts` replays historical data day-by-day and measures MAE/bias/accuracy. Golden datasets in `tests/fixtures/` (Halldis 83 days + 5 Kaggle babies). For duration-specific behavior, `tests/unit/learned-duration-scenarios.unit.ts` is a single-snapshot scenario table that visibly documents the engine's response across age, nap count, sample size, and data quality dimensions — algorithm changes produce a clear diff and pinned invariants protect production behavior.

The 12-hour arc visualizes completed sleeps and predictions on a semicircular timeline.

### Wake-time recommendations

The Prediction shape carries four kinds of "wake by" recommendation, each
emitted under different conditions:

- `expectedNapEnd` / `expectedNightEnd` — point predictions for the active
  sleep, derived from `getLearnedNapDuration` / `getLearnedNightDuration`.
- `expectedWakeRange` — ±1 SD band around the active wake point. Drives
  the active-sleep progress meter in `Arc.svelte`.
- `rescueNap.recommendedWakeTime` — cycle-aware cap when the active nap
  is an extra/rescue beyond the day's expected count (schedule.ts:914).
- `continuationWindow.{closesAt,capLatestEnd}` — after a cut-short, a
  ~25 min window during which re-induction is still likely to succeed,
  plus a cap on the comeback's end. Gated by `isDayOnTrend` so an
  already-on-trend day doesn't get pushed for more sleep.
- `postSkipPlan.rescue.{recommendedStart,latestStart,wakeBy}` — after a
  full nap is missed, recommend a rescue power-nap window.
- `napBudget.{wakeBy,recommendedDurationMin,mode,urgency,context}` —
  trend-anchored cap for the day's last nap when banked24h projects
  over a blended 7d/30d trend. Two modes: `first-contact` (cap at end
  of a full cycle, gentle introduction) and `established` (sub-cycle
  cap with a 5 min lead-time buffer once the parent has been
  cap-respecting for ~a week).

The `napBudget` rationale and evidence base (Brooks & Lack 2006,
Mednick 2003, Lassonde 2016, Nakagawa 2016, Akacem 2015, Trotti 2017)
is documented in `docs/sleep-science-research.md` §12. The four
recommendation surfaces have overlapping shape — a `WakeRecommendation
= {kind, target, reason, urgency}` discriminated union is captured as
a v2 refactor in `docs/followups.md`.

### Trend math

`dailyTrendTotalMin` on the Prediction is the blended 7d/30d daily-total
sleep, computed via `computeTrendTotalMin` in `trend.ts` (which now wraps
`computeTrendTargets` for the trend-ratchet split). Age-norm clamped to
the `SLEEP_NEEDS` range. Used by `napBudget` and rendered on the
stats/settings UI when it diverges from the learnedSchedule total by
>30 min.

The trend data fetch is a single 30-day window (server `state.ts:62`)
shared by both the strategy-hysteresis 21-day slice and the trend
math. `recentSleeps` (7-day) still drives the schedule engine's
short-horizon learning.

## Themes

Auto-switches between day (light pastels) and night (dark blue/purple with animated stars) based on time of day. Controlled via `data-theme` attribute on `<html>` and CSS custom properties. Both `[data-theme="day"]` and `[data-theme="night"]` selectors are defined explicitly.
