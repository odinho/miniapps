# Babysovelogg

Baby sleep & activity tracker. Offline-first PWA with event-sourced backend, real-time sync, and a 12-hour arc visualization.

One deploy per family — all clients share the same SQLite database. No auth needed.

## Quick Start

```bash
npm install
npm run build
PORT=3200 node dist/server.js
```

Open `http://localhost:3200` in a browser. On first visit you'll be prompted to add a baby.

### Development

```bash
npm run dev    # Watches both server (tsx) and client (esbuild)
npm test       # Playwright e2e tests
```

## Features

- **Start/stop sleep tracking** — nap vs. night auto-detected
- **12-hour arc visualization** — anchored on wake-up time, shows completed sleeps, predicted naps, and bedtime
- **Morning prompt** — log wake-up time to anchor the day's schedule
- **Nap predictions** — based on age-appropriate wake windows
- **Diaper logging** — wet/dirty/both/dry with optional amount and notes
- **Sleep metadata** — mood and method tags after each sleep
- **Pause/resume** — for interrupted naps
- **Statistics** — daily summaries, weekly bar charts, trends
- **Real-time sync** — SSE pushes updates to all connected clients
- **Offline-first** — events queued in localStorage, synced on reconnect
- **PWA** — installable, service worker caches app shell
- **Auto dark/light theme** — switches by time of day

## Architecture

Event-sourced: all mutations are append-only events in SQLite. Materialized views (denormalized tables) are maintained for fast reads. Clients can queue events offline and sync later.

See [docs/architecture.md](docs/architecture.md) for details.

## Tech Stack

- **Server:** Node.js (raw `http` module), better-sqlite3
- **Client:** Vanilla TypeScript (no framework)
- **Build:** esbuild
- **Tests:** Playwright (e2e)

## Project Structure

```
server/          — Backend (HTTP server, event store, projections)
src/             — Client TypeScript
  engine/        — Schedule predictions, stats calculations, constants
  ui/            — UI components (dashboard, arc, history, stats, settings)
  sw/            — Service worker
public/          — Static assets (index.html, manifest, sw entry)
tests/           — Playwright e2e tests
dist/            — Build output (gitignored)
```

## Deployment

Designed for a single-server setup behind nginx:

```
PORT=3200 node dist/server.js
```

Use a systemd service to keep it running. See [docs/deployment.md](docs/deployment.md).

## Docs

- [Architecture](docs/architecture.md) — event sourcing, database schema, API, sync
- [Deployment](docs/deployment.md) — systemd, nginx, Hetzner setup
- [Lessons learned](LESSONS.md) — gotchas encountered during development
- [Roadmap](TODO.md) — implementation steps and status
