# Architecture

## Overview

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Data Source  │────▶│   Backend    │◀───▶│   Frontend   │
│  Facet/Immich │     │  Fastify API │     │  Svelte 5    │
└──────────────┘     └──────┬───────┘     └──────────────┘
                            │
                     ┌──────┴───────┐
                     │   SQLite DB  │
                     │  state.db    │
                     └──────┬───────┘
                            │
                     ┌──────┴───────┐
                     │  LLM Client  │
                     │ Gemini/Ollama│
                     └──────────────┘
```

## Data Flow

1. **Assets** load from Facet SQLite (local testing) or Immich PostgreSQL (production)
2. **Clustering engine** groups photos by time + CLIP embedding similarity
3. **Session batcher** organizes into day/trip batches (4h gaps, min 3 photos)
4. **LLM client** sends batch images + prompt, gets back per-image assessments
5. **State DB** persists decisions, LLM results, view status
6. **Frontend** renders grid, manages 3-layer state, handles user interaction

## Backend (src/)

### Server (`server.ts`)
Fastify HTTP API. Serves batch/group endpoints, proxies LLM calls, manages state.

### Clustering (`clustering/`)
- `engine.ts` — Time-bucketed cosine similarity clustering. Groups photos within 60-min windows using CLIP embeddings.
- `union-find.ts` — Disjoint set for efficient cluster merging
- `cosine.ts` — Cosine similarity computation

### Batching (`batching/session-batcher.ts`)
Groups photos into review sessions: 4h time gaps for phone photos, folder boundaries for DSLR. Singletons merged into neighbors. Target: 3-30 photos per batch.

### LLM (`ranking/`)
- `llm-client.ts` — Handles Vertex AI (Gemini), OpenRouter, and Ollama (local). Images sent as interleaved text+image parts with index watermarks.
- `prompt.ts` — System prompt with category-specific guidance, tuned from 3000+ photo agreement analysis.
- `types.ts` — Response types, star mapping (LLM 0-5 → write-back 0-3)

### Data Adapters (`db/`)
- `state-db.ts` — SQLite for tool state (decisions, LLM runs, view status). Schema versioned.
- `facet-adapter.ts` — Reads from Facet's photo_scores_pro.db
- `immich-adapter.ts` — Reads from Immich PostgreSQL via SSH tunnel

## Frontend (web-app/src/)

### State Model (3-layer)

```
Layer 1: llmState      = deriveLlmState(batchDetail.llm, keepLevel)  // pure, reactive
Layer 2: manualOverrides = { photoId: 'keep' | 'cull' }              // sparse, user clicks
Layer 3: states         = mergeStates(ids, llmState, manualOverrides) // manual wins
```

All state derivation lives in `lib/state.ts` as pure functions with tests.

- **llmState** recomputes automatically when `keepLevel` or `batchDetail` changes
- **manualOverrides** only written by explicit user actions (click, keyboard)
- **+/−** adjusts `keepLevel` which changes `llmState` — manual overrides persist across level changes
- **Approve** saves the effective state to DB
- **Model switching** loads a different LLM result, resets manual overrides

### Components
- `App.svelte` — Main orchestrator, keyboard handling, state management
- `PhotoGrid.svelte` — Justified layout grid with keep/cull badges
- `Preview.svelte` — Fullscreen preview with swipe (mobile), touch zones
- `InfoPanel.svelte` — Sidebar with photo info, LLM assessment, subgroup rank

### Effective Stars
Stars are assigned per-subgroup, not per-photo:
- The primary keeper in each subgroup gets the max star rating across the group
- All other subgroup members get 0 stars
- Singletons keep their own rating
- When you toggle a different photo as keeper, stars transfer automatically

This makes star-based filtering useful: 2★+ shows at most one photo per moment.

## Database Schema (state.db)

### photo_decisions
Per-photo keep/cull decisions. Single source of truth.
```sql
asset_id TEXT PRIMARY KEY, state TEXT, user_stars INTEGER,
source TEXT DEFAULT 'manual', updated_at TEXT
```

### llm_batch_runs
All LLM results, preserved per-model. Newest `completed` wins.
```sql
batch_id TEXT, batch_fingerprint TEXT, model TEXT,
status TEXT ('completed'|'superseded'), response_json TEXT,
input_tokens INTEGER, output_tokens INTEGER, cost_estimate_usd REAL
```

### view_status
Tracks which batches/groups have been reviewed.
```sql
view_id TEXT PRIMARY KEY, view_type TEXT, status TEXT ('reviewed'|'skipped')
```

## LLM Integration

### Image Handling
- Images resized (1200px for cloud, 512px for local) with sharp
- Index watermark (#0, #1, ...) burned into top-left corner
- Interleaved text labels before each image: `--- Image 5: filename.jpg (16:03:53) ---`
- Sent as parts within a single Content object (critical for Vertex AI index accuracy)

### Model Routing
- Gemini 2.x models → regional Vertex AI endpoints (europe-west1)
- Gemini 3.x models → global Vertex AI endpoint (locations/global)
- Local models (gemma/llama/etc) → Ollama (/api/chat)
- Auto-detected by model name pattern

### Caching
- Results cached per (batch_id, fingerprint, model)
- Re-run invalidates only the specific model, preserving others
- All runs kept in DB (superseded, not deleted) for analysis

### Multi-Model Agreement
When 2+ models have rated a batch, the server computes per-photo consensus (unanimous keep/cull/disagree). Batches are sorted by agreement tier: full-agreement first, then partial, then single-model. The UI shows confidence overlays ("CONFIDENT KEEP/CULL") on photos where all models agree, and "?!" badges where they disagree. Bulk approval of fully-agreed batches is available via `POST /api/batches/approve-confident`.

## Tooling

- **oxlint** — Linting (correctness, suspicious, perf categories)
- **oxfmt** — Formatting
- **tsgo** — Type checking (TypeScript in Go, fast)
- **svelte-check** — Svelte-specific checks (--fail-on-warnings)
- **vitest** — Unit tests for pure state functions

`npm run check` from root runs the full pipeline for both backend and frontend.
