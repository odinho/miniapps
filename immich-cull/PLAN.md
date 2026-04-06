# immich-cull — Plan

## Current State (2026-04-06)

Working prototype with:
- Clustering engine (time-bucketed cosine similarity on CLIP embeddings)
- Two data sources: Facet SQLite (local testing) and Immich PostgreSQL (production)
- Review UI with justified grid layout, preview mode, keyboard-driven workflow
- Confirmed working with full Immich DB (72k+ images with embeddings)

## Implementation Phases

### Phase 0: Calibration & Onboarding (before LLM)

Before running the LLM on thousands of groups, establish ground truth.

- [ ] User manually reviews ~50 groups across different types (portraits, landscapes, docs, screenshots)
- [ ] Record decisions as benchmark set for LLM evaluation
- [ ] User tags ~10 representative folders as "old workflow" or "new workflow" for 1★ heuristic
- [ ] Internalize the new 0-5★ scale before the tool starts suggesting
- [ ] ~30 minutes of work, saves weeks of prompt iteration

### Phase 1: Persist State (next)

The review server currently holds decisions in-memory (lost on restart).

- [ ] Add SQLite database for tool state
- [ ] Persist decisions (keep/cull per group) across server restarts
- [ ] Store undo history
- [ ] Session tracking: "you reviewed 120 groups today, approved 95, culled 340 photos"
- [ ] Progress indicator: "2000 of 5000 groups reviewed"
- [ ] "Pick up where you left off" — trivial resumption for returning after days/weeks

### Phase 2: Gemini LLM Ranking

See [LLM_INTEGRATION_PLAN.md](LLM_INTEGRATION_PLAN.md) and [docs/batching-strategy-v2.md](docs/batching-strategy-v2.md).

**Batching**: day/trip-sized sessions, not similarity groups.
- [ ] Session batcher: 4h time gaps for phone photos, DSLR folder boundaries for organized photos
- [ ] Sub-split sessions >150 photos at largest internal gap
- [ ] Target: 10-150 photos per batch, ~2500 batches for 100k photos

**LLM integration** (one call per day-batch):
- [ ] Connect to Gemini 2.5 Flash Lite via `@google/genai`
- [ ] Every photo gets: star rating (0-3), categories, brief note, protection flags
- [ ] LLM identifies similarity subgroups within batch + ranks them + recommends keep/cull
- [ ] Store raw responses + normalized rows + policy-applied output in SQLite
- [ ] Cost: ~$8.66 for 100k photos (100% coverage)

**UI integration**:
- [ ] Pre-populate keep/cull from LLM's similarity subgroup recommendations
- [ ] Default workflow: LLM recommends → user hits `A` → next (minimal decisions)
- [ ] Show LLM briefNote per image on hover
- [ ] Show batchSummary in header ("Christmas Eve 2020 — family dinner, gifts")
- [ ] CLIP similarity groups for UI layout within day-batches

**Auto-approve** (critical for ADD-friendly workflow):
- [ ] High-confidence subgroups auto-approved (pairs: keep-one when clearly better)
- [ ] Summary of auto-approved decisions for spot-checking
- [ ] Cuts review workload by 60-80%
- [ ] Never auto-cull-all groups of 3+ (user never does this)

**Star ratings** (every photo, not just grouped ones):
- [ ] LLM suggests 0-3★ per image (never 4-5★)
- [ ] Policy layer for existing 1★ ambiguity
- [ ] 2★+ existing ratings are hard floor
- [ ] See [STAR_RATING_PHILOSOPHY.md](STAR_RATING_PHILOSOPHY.md)

**Calibration data** (143 manual decisions):
- 48% keep rate overall, LLM should not be aggressive
- Pairs: default keep-1 (72%), keep-both when distinct (14%)
- Groups 3+: never cull-all, keep-all 12% of time
- Budget prompt iteration at ~$15 total (1.5 full runs)

### Phase 3: Full Library Processing

Run before write-back — build against real data, not test set.

- [ ] Run clustering on all 72k+ Immich images
- [ ] Performance: binary search is O(B·logN), should handle 100k in minutes
- [ ] Memory: ~150MB for 72k × 512-dim embeddings
- [ ] SSH tunnel automation or deploy on Debian VM directly
- [ ] Aggregate dashboard before any writes: star distribution histogram, cull count, category breakdown, lowest-confidence groups

### Phase 4: Write-back to Immich

Built against full-library data (not test set).

- [ ] Soft-delete first: mark culled in SQLite, don't move to Immich trash until user finalizes batch
  (Immich trash expires in 30 days; review might take months)
- [ ] Write star ratings via Immich API (`PUT /assets/{id}`)
- [ ] Finalize batch: move soft-deleted to Immich trash
- [ ] Write XMP sidecars via `exiftool-vendored`
- [ ] Create "Review Session" album in Immich for audit trail
- [ ] Dry-run mode (show what would change without applying)
- [ ] Rollback capability using audit trail (undo bulk star changes)
- [ ] Rate-limit Immich API calls for bulk operations

### Phase 5a: Categories & Tags (safe metadata)

- [ ] Write LLM categories to Immich tags
- [ ] Auto-detect phone screenshots from path/filename
- [ ] Snapchat-from-Helene: protect meaningful personal saves
- [ ] Folder/roll context heuristic for 1★ ambiguity
- [ ] Singleton strategy: batch ungrouped photos by date, run lighter LLM pass for star ratings

### Phase 5b: File Operations (higher risk, separate phase)

- [ ] NEF/JPG pair management: keep NEF for high-rated, keep only JPG for low-rated
- [ ] Suggest lower resolution for technical/reference photos
- [ ] Always dry-run first, require explicit confirmation

### Phase 6: Iteration & Learning

- [ ] Track user overrides as structured feedback (promoted_keep, demoted_keep, changed_star)
- [ ] Evaluate prompt versions against Phase 0 benchmark groups
- [ ] Re-add TechnicalFlags if model accuracy validates it
- [ ] Cross-library 4★ curation: surface top 3★ candidates for yearly review
- [ ] Auto-approve threshold tuning based on override rates
- [ ] Category-specific prompt refinements
- [ ] "Batch actions by category" UX (e.g., "delete these 47 screenshots")

## Architecture

- **TypeScript full-stack** (user preference, Immich alignment)
- **Read-only PostgreSQL** for embeddings (internal schema, pinned to Immich v2.5.2)
  - Startup health check validates expected schema exists
  - Plan for Immich API reading if it becomes available
- **All writes through Immich API** (safe, documented, forwards-compatible)
- **Local SQLite for tool state**: decisions, LLM responses (raw + policy-applied), feedback, sessions
- **Gemini 2.5 Flash Lite** for ranking (~$2.56 base for 5k groups, budget $15 for iteration)
- **Soft-delete before Immich trash** — no data loss during extended review periods
- **2★+ existing ratings are hard floor** — 1★ is context-dependent
- **Auto-approve high-confidence groups** — minimize decisions for ADD-friendly workflow

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

- [LLM_INTEGRATION_PLAN.md](LLM_INTEGRATION_PLAN.md) — Full Gemini integration design
- [STAR_RATING_PHILOSOPHY.md](STAR_RATING_PHILOSOPHY.md) — Revised 0-5★ scale
- [README.md](README.md) — Quick start and keyboard shortcuts

## Key Risks & Mitigations

| Risk | Mitigation |
|---|---|
| LLM systematic aesthetic bias | Random 5% spot-check after auto-approve batches |
| Clustering groups unrelated photos | groupCoherence field lets LLM flag it |
| 80% folder heuristic is wrong | Manual folder tagging during onboarding, validate before bulk apply |
| Immich schema changes on upgrade | Startup health check, schema adapter isolation |
| Immich trash expires before review done | Soft-delete in SQLite first, finalize batch explicitly |
| Decision fatigue (5000 groups) | Auto-approve 60-80% of high-confidence groups |
| Tool abandoned after 3 sessions | Trivial resumption UX, session summaries, progress bars |
| Singletons never reviewed | Phase 5a: batch by date, lighter LLM pass |
