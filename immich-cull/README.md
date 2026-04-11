# immich-cull

AI-assisted photo culling tool for large personal photo libraries. Groups similar photos using CLIP embeddings, ranks them with multimodal LLMs, and presents a keyboard/touch review UI for fast keep/cull decisions.

## Why

Managing 100k+ family photos is overwhelming. Every phone burst creates 5-15 near-identical shots. The good photo is somewhere in there, but finding it means looking at every single one. Most photo management tools help you browse — none help you decide what to keep.

immich-cull solves the decision problem:
1. **Groups** similar photos automatically (CLIP similarity + time proximity)
2. **LLM ranks** each group — best expressions, sharpest focus, most interesting moment
3. **You review** with a fast UI — the LLM's suggestions are a starting point, not a verdict

The goal is to reduce 100k photos to a curated library where filtering by stars actually works — no more 7 identical shots all rated the same.

## How It Works

```
Photos (Immich/local) → CLIP Clustering → Session Batching → LLM Ranking → Review UI → Decisions
```

1. **Clustering**: Groups photos by time proximity + CLIP embedding cosine similarity. Finds bursts, duplicates, and same-scene sequences.

2. **Session Batching**: Organizes photos into day/trip sessions (4h time gaps). Each batch is one LLM call.

3. **LLM Ranking**: Multimodal LLM (Gemini or local Gemma4) assesses every photo — star rating, category, brief description, keep/cull recommendation, similarity subgroups with quality ranking.

4. **Review UI**: Svelte web app with justified grid, fullscreen preview, keyboard shortcuts, swipe on mobile. Model comparison: switch between different LLM results instantly.

5. **Decisions**: Per-photo keep/cull persisted in SQLite. Manual overrides always win over LLM suggestions.

## Quick Start

```bash
cd immich-cull
npm install
cd web-app && npm install && cd ..

# Start backend (local test data + Vertex AI)
npx tsx src/server.ts --local --vertex --port 3737

# Start frontend dev server
cd web-app && npm run dev -- --host

# Open http://localhost:5173
```

### With Immich

```bash
# SSH tunnel to Immich PostgreSQL
ssh -f -N -L 15432:<postgres-container-ip>:5432 user@immich-host

# Copy and edit .env
cp .env.example .env

# Start with Immich
npx tsx src/server.ts --immich --vertex --port 3737
```

### Model Selection

```bash
# Default (cheapest)
npx tsx src/server.ts --local --vertex --port 3737

# Better model
npx tsx src/server.ts --local --vertex --model=gemini-3.1-flash-lite-preview --port 3737

# In the UI: click model buttons to switch, Shift+R to cycle
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` `→` | Navigate images |
| `↑` `↓` | Navigate groups/batches |
| `K` | Keep selected |
| `X` | Cull selected |
| `B` | Keep selected, cull rest |
| `A` / `Enter` | Approve & next undecided |
| `S` | Skip |
| `Backspace` | Undo |
| `Space` | Toggle preview |
| `r` | Re-run current model |
| `Shift+R` | Cycle models (manual → 2.5-lite → 3.1-lite → ...) |
| `−` `+` | Adjust keep level within subgroups |
| `0`–`5` | Set star rating |
| `?` | Help |

## LLM Models

| Model | Agreement | Cost | Speed | Notes |
|-------|-----------|------|-------|-------|
| gemini-3.1-flash-lite | **82%** | $$ | ~5s/batch | Best accuracy, recommended |
| gemini-2.5-flash-lite | 67% | $ | ~3s/batch | Default, cheapest cloud |
| gemini-3-flash | 75% | $$$ | ~8s/batch | Good but expensive |
| gemma4:e4b (local) | 58% | Free | ~70s/batch | Ollama, no cloud needed |

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
- Per-photo decisions as single source of truth (not per-group)
- 3-layer state model: LLM state → manual overrides → effective state
- LLM results cached per-model in SQLite — switch between models instantly
- All LLM runs preserved (superseded, not deleted) for analysis
- Subgroup star assignment: primary keeper gets max stars, others get 0

## Data Sources

- **Facet SQLite**: Local testing with CLIP ViT-L-14 embeddings (768-dim)
- **Immich PostgreSQL**: Production mode with CLIP ViT-B-32 embeddings (512-dim), read-only

## Safety

- Read-only database access — never writes to Immich's PostgreSQL
- Culled photos will go to Immich trash (30-day recovery) — not yet implemented
- Undecided images default to keep on approve
- Undo reverses last approve/skip
- Manual decisions always override LLM suggestions

## Stack

TypeScript, Svelte 5, Vite, Fastify, sharp, better-sqlite3, @google/genai, Ollama
