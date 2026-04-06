# immich-cull — Plan

## Current State (2026-04-06)

Working prototype with:
- Clustering engine (time-bucketed cosine similarity on CLIP embeddings)
- Two data sources: Facet SQLite (local testing) and Immich PostgreSQL (production)
- Review UI with justified grid layout, preview mode, keyboard-driven workflow
- 340 groups from 3,173 local phone photos, 284 groups from 2,000 Immich photos
- Confirmed working with full Immich DB (72k+ images with embeddings)

## Implementation Phases

### Phase 1: Persist State (next)

The review server currently holds decisions in-memory (lost on restart).

- [ ] Add SQLite database for tool state (decisions, session history)
- [ ] Persist keep/cull decisions across server restarts
- [ ] Store undo history in SQLite
- [ ] Load/display previous decisions on group revisit (partially done: rehydration from server works, but server is in-memory)

### Phase 2: Gemini LLM Ranking

See [LLM_INTEGRATION_PLAN.md](LLM_INTEGRATION_PLAN.md) for full design.

Core implementation:
- [ ] Connect to Gemini 2.5 Flash Lite via `@google/genai`
- [ ] Send ALL images per group (no chunking — 20 images is trivial for 1M context)
- [ ] Rich structured JSON output: ranking + keep sets + categories + star suggestions + protection flags
- [ ] Store raw LLM responses + normalized rows in SQLite (versioned, fingerprinted)
- [ ] Pre-populate keep/cull suggestions in UI from LLM output
- [ ] Show LLM reasoning per image
- [ ] +/- slider: "keep top 1", "keep top 2", etc. using LLM's keepSets

Star rating integration:
- [ ] LLM suggests 0-3★ per image (never 4-5★)
- [ ] Policy layer applies folder context for existing 1★ ambiguity
- [ ] 2★+ existing ratings are hard floor
- [ ] See [STAR_RATING_PHILOSOPHY.md](STAR_RATING_PHILOSOPHY.md)

Batch processing:
- [ ] Queue all groups for LLM ranking
- [ ] Batch API support for overnight processing (~$2.56 for 5k groups on Gemini 2.5 Flash Lite)
- [ ] Progress tracking and failure handling

### Phase 3: Write-back to Immich

- [ ] Write star ratings via Immich API (`PUT /assets/{id}`)
- [ ] Move culled photos to Immich trash (30-day recovery)
- [ ] Write XMP sidecars via `exiftool-vendored`
- [ ] Create "Review Session" album in Immich for audit trail
- [ ] Dry-run mode (show what would change without applying)
- [ ] Bulk operations with progress tracking

### Phase 4: Full Library Processing

- [ ] Run clustering on all 72k+ Immich images
- [ ] Performance: binary search is O(B·logN), should handle 100k in minutes
- [ ] Memory: ~150MB for 72k × 512-dim embeddings — fits in Node heap
- [ ] SSH tunnel automation or deploy on Debian VM directly
- [ ] Process in time-range batches if needed

### Phase 5: Categories, Tags & Cleanup

- [ ] LLM categories written to Immich tags (portrait, document, receipt, screenshot, etc.)
- [ ] Auto-detect phone screenshots from path/filename
- [ ] Snapchat-from-Helene: protect meaningful personal saves
- [ ] NEF/JPG pair management: keep NEF for high-rated, keep only JPG for low-rated
- [ ] Suggest lower resolution for technical/reference photos
- [ ] Folder/roll context heuristic for 1★ ambiguity resolution

### Phase 6: Iteration & Learning

- [ ] Track user overrides as structured feedback (promoted_keep, demoted_keep, changed_star)
- [ ] Evaluate prompt versions against benchmark groups
- [ ] Cross-library 4★ curation: surface top 3★ candidates for yearly review
- [ ] Face-aware ranking (prefer photos where everyone's eyes are open)
- [ ] Learning from decisions: adjust thresholds based on approve/override patterns

## Architecture

- **TypeScript full-stack** (user preference, Immich alignment)
- **Read-only PostgreSQL** for embeddings (internal schema, pinned to Immich v2.5.2)
- **All writes through Immich API** (safe, documented, forwards-compatible)
- **Local SQLite for tool state** (decisions, LLM responses, rankings, feedback) — planned, currently in-memory
- **Gemini 2.5 Flash Lite** for ranking (~$2.56 for 5k groups via standard API)
- **Never hard-delete** — always Immich trash with 30-day recovery
- **2★+ existing ratings are hard floor** — 1★ is context-dependent (see star philosophy)

## Clustering Thresholds (all configurable in ClusterConfig)

| Parameter | Default | Purpose |
|---|---|---|
| bucketMinutes | 60 | Time window for grouping |
| bucketStride | 30 | Overlap between buckets |
| strongEdgeDistance | 0.18 | Cosine distance for "similar scene" |
| burstEdgeDistance | 0.22 | Looser threshold when time-close |
| burstTimeMinutes | 5 | Max time delta for burst edges |
| maxGroupSize | 20 | Split threshold |
| minGroupSize | 2 | Don't show singletons |
| temporalGapMinutes | 12 | Split groups at time gaps |
| topK | 12 | Neighbors to consider per asset |

## Key Documents

- [LLM_INTEGRATION_PLAN.md](LLM_INTEGRATION_PLAN.md) — Full Gemini integration design (prompt, schema, storage, slider)
- [STAR_RATING_PHILOSOPHY.md](STAR_RATING_PHILOSOPHY.md) — Revised 0-5★ scale and migration from old system
- [README.md](README.md) — Quick start and keyboard shortcuts
