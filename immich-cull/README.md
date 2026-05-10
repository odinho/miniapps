# immich-cull

AI-assisted photo culling tool for Immich. Organizes photos into session batches, ranks them with multimodal LLMs, and presents a keyboard/touch review UI for fast keep/cull decisions.

## Why

Managing 100k+ family photos is overwhelming. Every phone burst creates 5-15 near-identical shots. The good photo is somewhere in there, but finding it means looking at every single one. Most photo management tools help you browse — none help you decide what to keep.

immich-cull solves the decision problem:

1. **Batches** photos by day/trip sessions automatically
2. **LLM ranks** each batch — best expressions, sharpest focus, most interesting moment
3. **You review** with a fast UI — the LLM's suggestions are a starting point, not a verdict

The goal is to reduce 100k photos to a curated library where filtering by stars actually works — no more 7 identical shots all rated the same.

## How It Works

```
Immich API → Session Batching → LLM Ranking → Review UI → Decisions → Immich Write-back
```

1. **Session Batching**: Organizes photos into day/trip sessions (4h time gaps). Each batch is one LLM call.

2. **LLM Ranking**: Multimodal LLM (Gemini or local Gemma4) assesses every photo — star rating, category, brief description, keep/cull recommendation, similarity subgroups with quality ranking.

3. **Review UI**: Svelte web app with justified grid, fullscreen preview, keyboard shortcuts, swipe on mobile. Model comparison: switch between different LLM results instantly.

4. **Decisions**: Per-photo keep/cull persisted in SQLite. Manual overrides always win over LLM suggestions.

## Quick Start

```bash
cd immich-cull
npm install
cd web-app && npm install && cd ..

# Set IMMICH_URL and IMMICH_API_KEY in .env
cp .env.example .env

# Start backend (Vertex AI for LLM)
npm start

# Start frontend dev server
cd web-app && npm run dev -- --host

# Open http://localhost:5173
```

### Model Selection

```bash
# Default (cheapest)
npm start

# Better model
npx tsx src/server.ts --vertex --model=gemini-3.1-flash-lite-preview --port 3737

# In the UI: click model buttons to switch, Shift+R to cycle
```

## Keyboard Shortcuts

| Key           | Action                                            |
| ------------- | ------------------------------------------------- |
| `←` `→`       | Navigate images                                   |
| `↑` `↓`       | Navigate batches                                  |
| `K`           | Keep selected                                     |
| `X`           | Cull selected                                     |
| `B`           | Keep selected, cull rest                          |
| `A` / `Enter` | Approve & next undecided                          |
| `S`           | Skip                                              |
| `Backspace`   | Undo                                              |
| `Space`       | Toggle preview                                    |
| `r`           | Re-run current model                              |
| `Shift+R`     | Cycle models (manual → 2.5-lite → 3.1-lite → ...) |
| `−` `+`       | Adjust keep level within subgroups                |
| `0`–`5`       | Set star rating                                   |
| `?`           | Help                                              |

## LLM Models

| Model                 | Agreement | Cost | Speed      | Notes                      |
| --------------------- | --------- | ---- | ---------- | -------------------------- |
| gemini-3.1-flash-lite | **82%**   | $$   | ~5s/batch  | **Default**, best accuracy |
| gemini-2.5-flash-lite | 67%       | $    | ~3s/batch  | Cheapest cloud             |
| gemini-3-flash        | 75%       | $$$  | ~8s/batch  | Good but expensive         |
| gemma4:e4b (local)    | 58%       | Free | ~70s/batch | Ollama, no cloud needed    |

Agreement rates measured against manual decisions on 3000+ photos.

## Development

```bash
# Full check (lint + format + typecheck + svelte-check + tests)
npm run check

# Individual tools
npm run lint          # oxlint
npm run fmt           # oxfmt (write)
npm run fmt:check     # oxfmt (check only)
npm run typecheck     # tsgo

# Frontend
cd web-app
npm run lint
npm run fmt:check
npm run check         # svelte-check --fail-on-warnings
npm run test          # vitest
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full picture.

**Key design decisions:**

- Per-photo decisions as single source of truth (not per-batch)
- 3-layer state model: LLM state → manual overrides → effective state
- LLM results cached per-model in SQLite — switch between models instantly
- All LLM runs preserved (superseded, not deleted) for analysis
- Subgroup star assignment: primary keeper gets max stars, others get 0

## Bulk LLM processing

For a few batches, use the UI. For many:

```bash
# Parallel real-time (simple, same cost)
npm run rank:many -- --count 500 --concurrent 8

# Vertex batch prediction (~50% cheaper, async, needs a GCS bucket)
# See docs/batch-mode.md
npm run rank:batch:submit -- --bucket gs://tagrdevin-immich-cull-batch
npm run rank:batch:status
```

## Auto-keep patterns

Regex patterns in `auto_keep_patterns` exclude matching assets from batching (auto-kept). Matched against asset path and filename. Requires server restart.

```bash
sqlite3 data/state.db "INSERT INTO auto_keep_patterns (pattern, description) VALUES ('/Snapchat/', 'Snapchat saves');"
```

## Safety

- Read-only Immich access (only reads via REST API)
- Undecided images default to keep on approve
- Undo reverses last approve/skip
- Manual decisions always override LLM suggestions

### Write-back to Immich

Writes culled photos to Immich trash (30-day recovery), sets star ratings, and tags LLM-rated photos with `ai:rated`. Always dry-run first.

```bash
# Dry run (see what would change):
curl -X POST http://localhost:3737/api/immich/writeback \
  -H "Content-Type: application/json" -d '{"dryRun":true}'

# Execute:
curl -X POST http://localhost:3737/api/immich/writeback \
  -H "Content-Type: application/json" -d '{"dryRun":false}'
```

## Stack

TypeScript, Svelte 5, Vite, Fastify, sharp, better-sqlite3, @google/genai, Ollama
