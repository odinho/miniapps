# Napper PWA — Baby Sleep Tracker

## Overview
Offline-first PWA replacing the Napper app. Node.js server with SQLite, event-sourced architecture, simple REST API serving both the app and data.

## Target User
Odin & Helene tracking Halldis (born 2025-06-12, currently ~8 months).

## Architecture

### Event Sourcing
All mutations are stored as **events** in an append-only event log. Current state (materialized views) is derived by replaying events, but also maintained in denormalized tables for fast reads.

**Event types:**
- `baby.created` — {name, birthdate}
- `baby.updated` — {name?, birthdate?}
- `sleep.started` — {babyId, startTime, type}
- `sleep.ended` — {sleepId, endTime}
- `sleep.updated` — {sleepId, startTime?, endTime?, type?, notes?}
- `sleep.deleted` — {sleepId}

Each event has: `id`, `type`, `payload` (JSON), `timestamp`, `clientId` (for offline sync)

**Benefits:**
- Full history/audit trail
- Offline clients queue events, sync when online
- State can always be rebuilt from events
- Simple conflict resolution (last-write-wins, manual dedup if needed)

### Stack
- **Server:** Node.js (no framework, just http module or express-minimal)
- **Database:** better-sqlite3 (server-side SQLite)
- **Client:** Vanilla TypeScript PWA (no framework)
- **Build:** esbuild for client bundle
- **Deploy:** Hetzner (hetzner.s0.no), nginx reverse proxy to Node.js

### Server API

```
GET  /                    → serves index.html
GET  /api/state           → full current state (baby + today's sleeps + stats)
GET  /api/events          → list events (with ?since=<id> for sync)
POST /api/events          → append new event(s), returns updated state
GET  /api/sleeps          → sleep log with filters (?from=&to=&limit=)
GET  /api/stats           → computed stats (weekly, averages)
```

### Database Schema

```sql
-- Append-only event log
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,  -- JSON
  client_id TEXT,         -- for dedup on sync
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Materialized state (rebuilt from events)
CREATE TABLE baby (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  birthdate TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sleep_log (
  id INTEGER PRIMARY KEY,
  baby_id INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT,
  type TEXT NOT NULL DEFAULT 'nap',
  notes TEXT,
  deleted INTEGER NOT NULL DEFAULT 0
);
```

### Client Architecture
- On load: fetch `/api/state` for current state
- All mutations: POST event to `/api/events`
- Offline: queue events in localStorage, sync on reconnect
- Service worker caches app shell for offline use
- Client generates a `clientId` (stored in localStorage) for event dedup

### File Structure
```
miniapps/napper/
├── SPEC.md
├── package.json
├── tsconfig.json
├── server/
│   ├── index.ts          -- HTTP server entry
│   ├── db.ts             -- better-sqlite3 setup, migrations
│   ├── events.ts         -- Event store: append, list, replay
│   ├── projections.ts    -- Materialize events → state tables
│   └── api.ts            -- Route handlers
├── src/                  -- Client code
│   ├── main.ts
│   ├── api.ts            -- HTTP client for server API
│   ├── sync.ts           -- Offline queue + sync logic
│   ├── engine/
│   │   ├── constants.ts
│   │   ├── schedule.ts
│   │   └── stats.ts
│   └── ui/
│       ├── components.ts
│       ├── dashboard.ts
│       ├── history.ts
│       ├── settings.ts
│       └── styles.ts
├── public/
│   ├── index.html
│   ├── manifest.json
│   └── sw.js
├── esbuild.config.mjs
└── dist/                 -- Built client output
```

### Deployment (Hetzner)
- nginx config: proxy_pass to localhost:PORT for /api/*, serve dist/ for static
- systemd service for Node.js process
- Domain: napper.s0.no (or sub-path of existing)

### Design
- Soft, calming pastels (lavender/peach/cream)
- Big sleep/wake toggle button (moon/sun)
- Mobile-first, large touch targets
- Countdown to next nap
- Today's stats at a glance
