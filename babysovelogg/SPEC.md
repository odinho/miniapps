# Napper PWA — Original Design Spec

> **Note:** This was the original design document. For current architecture, see [docs/architecture.md](docs/architecture.md).

## Overview
Offline-first PWA for baby sleep tracking. Node.js server with SQLite, event-sourced architecture, simple REST API serving both the app and data.

## Target User
Parents tracking a baby's sleep patterns — one deploy per family.

## Design
- Soft, calming pastels (day) / deep dark blue with stars (night)
- Auto-switching day/night theme based on time
- 12-hour arc visualization showing sleeps and predictions
- Big sleep toggle on dashboard
- Mobile-first, large touch targets
- Countdown to next nap in arc center
