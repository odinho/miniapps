# Babysovelogg

Baby sleep & activity tracker. Offline-first PWA with event-sourced backend, real-time sync, and a 12-hour arc visualization.

One deploy per family — all clients share the same SQLite database. No auth needed.

## Quick Start

```bash
bun install
bun run build
PORT=3200 node build/index.js
```

Open `http://localhost:3200`. On first visit you'll be prompted to add a baby.

### Development

```bash
bun run dev          # SvelteKit dev server with HMR
bun run test:unit    # Vitest unit tests (405 tests)
bun run test:e2e     # Playwright E2E tests (112 tests, requires build first)
bun run lint         # oxlint
bun run typecheck    # svelte-check
```

### CLI

There's a CLI for scripting and AI agents:

```bash
npx tsx cli/baby.ts              # Quick status
npx tsx cli/baby.ts nap          # Start a nap
npx tsx cli/baby.ts up --mood happy  # Baby woke up
npx tsx cli/baby.ts --help       # All commands
```

Reads/writes the SQLite database directly — no server required.

## Features

- **Start/stop sleep tracking** — nap vs. night auto-detected by time of day and nap count
- **12-hour arc visualization** — anchored on wake-up time, shows completed sleeps, predicted naps, and bedtime
- **Morning prompt** — log wake-up time to anchor the day's schedule
- **Nap predictions** — based on age-appropriate wake windows
- **Diaper/potty logging** — wet/dirty/both/dry, or potty training mode (pee/poo/nothing)
- **Sleep metadata** — mood and method tags after each sleep, wake-up info
- **Undo** — toast with "Angre" button after starting or ending sleep
- **Pause/resume** — for interrupted naps
- **Statistics** — daily summaries, weekly bar charts, trends
- **History** — full log with inline editing, manual sleep entry
- **Real-time sync** — SSE pushes updates to all connected clients
- **Offline-first** — events queued in localStorage, synced on reconnect
- **PWA** — installable, service worker caches app shell
- **Auto dark/light theme** — switches by time of day, stars at night

## Tech Stack

- **Framework:** SvelteKit 5 with `adapter-node`
- **Database:** better-sqlite3 (raw SQL, no ORM)
- **Validation:** Valibot
- **Tests:** Playwright (E2E), Vitest (unit + integration)
- **Lint:** oxlint
- **Language:** TypeScript, Nynorsk Norwegian UI

## Project Structure

```
src/
  routes/            — SvelteKit pages and API routes
    +page.svelte     — Dashboard (arc, timer, sleep button)
    +layout.svelte   — App shell (nav bar, theme, SSE init)
    history/         — Sleep/diaper log with editing
    stats/           — Statistics with bar charts
    settings/        — Baby settings, onboarding, import
    events/          — Debug event viewer
    api/             — REST + SSE endpoints
  lib/
    components/      — Svelte components (Arc, Timer, SleepButton, modals, sheets)
    stores/          — Reactive state (app.svelte.ts, sync.svelte.ts)
    engine/          — Pure logic (schedule, stats, classification, constants)
    server/          — Server-only (db, events, projections, schemas, broadcast)
cli/                 — CLI tool (baby.ts)
tests/
  unit/              — Vitest unit tests (.unit.ts)
  integration/       — Vitest integration tests (.test.ts)
  *.e2e.ts           — Playwright E2E tests
  fixtures.ts        — Shared test harness
static/              — PWA manifest, icons
```

## Architecture

Event-sourced: all mutations are append-only events in SQLite. Materialized views (denormalized tables) are rebuilt from events. Clients can queue events offline and sync later.

See [docs/architecture.md](docs/architecture.md) for details.

## Deployment

SvelteKit with `adapter-node` builds to `build/index.js`:

```bash
bun run build
PORT=3200 node build/index.js
```

See [docs/deployment.md](docs/deployment.md) for systemd + nginx setup.

## Docs

- [Architecture](docs/architecture.md) — event sourcing, database schema, API, sync
- [Testing](docs/testing.md) — test philosophy, layers, harness patterns
- [Deployment](docs/deployment.md) — systemd, nginx, production setup
