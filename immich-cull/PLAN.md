# immich-cull — Plan

## Current State (2026-04-06)

Working prototype with:
- Clustering engine (time-bucketed cosine similarity on CLIP embeddings)
- Two data sources: Facet SQLite (local testing) and Immich PostgreSQL (production)
- Review UI with justified grid layout, preview mode, keyboard-driven workflow
- 340 groups from 3,173 local phone photos, 284 groups from 2,000 Immich photos

## Phase 1: Polish Review UI (in progress)

- [x] Justified layout filling viewport
- [x] EXIF rotation fix
- [x] Selection, preview mode, filmstrip
- [x] Keep/cull visual states
- [x] Backspace undo
- [x] No upscaling beyond native pixels
- [ ] Persist decisions to disk (survive server restart)
- [ ] Show group context: folder name, date range in header
- [ ] Touch/swipe support for phone usage

## Phase 2: Gemini LLM Ranking

- [ ] Connect to Gemini Flash Lite via `@google/genai`
- [ ] For each group, send preview images with prompt asking for comparative ranking
- [ ] Return structured JSON: ordered ranking with reasoning per image
- [ ] Map LLM ranking to "+/-" slider: keep 1, keep 2, keep 3... (user adjusts threshold)
- [ ] Pre-populate keep/cull suggestions from LLM before user reviews
- [ ] Show LLM reasoning per image in the UI
- [ ] Batch mode: rank all groups overnight via Gemini Batch API (~$2-5 for full library)
- [ ] Respect existing star ratings as constraints (don't suggest culling 3+ star images)

### LLM Prompt Design
- Send 3-8 preview JPEGs per group
- Ask: "Rank these photos. For each, explain why keep or cull. Consider sharpness, composition, facial expressions, moment captured, uniqueness."
- Response: `{ranking: [{id, rank, keep, reason}], bestId, confidence}`
- For groups >8: tournament reduction (chunks of 6, keep top 2, finals)

### Star Rating Strategy (from LLM rankings)
- Existing ratings are sacred, never auto-downgrade
- Rank 1 winner: 3★ (if group ≥ 3, confidence ≥ 0.75) else 2★
- Rank 2: 2★ (if confidence ≥ 0.70) else 1★
- Others: 1★ if distinct, else trash candidate
- Never auto-assign 4-5★

## Phase 3: Immich Integration (Write-back)

- [ ] Write star ratings via Immich API (`PUT /assets/{id}`)
- [ ] Move culled photos to Immich trash (30-day recovery)
- [ ] Write XMP sidecars via `exiftool-vendored`
- [ ] Create "Review Session" album in Immich for audit trail
- [ ] Bulk operations with progress tracking
- [ ] Dry-run mode (show what would change without applying)

## Phase 4: Full Library Processing

- [ ] Run clustering on all 72k+ Immich images
- [ ] Performance: binary search is O(B*logN), should handle 100k in minutes
- [ ] Memory: ~200MB for 72k × 512-dim embeddings — fits in Node heap
- [ ] Process in time-range batches if needed (e.g., year by year)
- [ ] SSH tunnel automation or deploy on Debian VM directly

## Phase 5: Categories & Tags

- [ ] LLM categorization during ranking: document, receipt, screenshot, Snapchat-from-Helene, etc.
- [ ] Auto-tag phone screenshots (detectable from path/filename)
- [ ] Suggest lower resolution for technical/reference photos (house construction, etc.)
- [ ] NEF/JPG pair management: keep NEF for high-rated, keep only JPG for low-rated
- [ ] Write tags to Immich via API

## Phase 6: Advanced Features

- [ ] Image resize for low-value images (save space without deleting)
- [ ] Cross-day event clustering (same location over multiple days)
- [ ] Face-aware ranking (prefer photos where everyone's eyes are open)
- [ ] Learning from user decisions: adjust thresholds based on approve/override patterns
- [ ] Export decisions as CSV/JSON for external tools

## Architecture Decisions

- **TypeScript full-stack** (user preference, Immich alignment)
- **Read-only PostgreSQL** for embeddings (internal schema, pinned to Immich v2.5.2)
- **All writes through Immich API** (safe, documented, forwards-compatible)
- **Local SQLite for tool state** (decisions, rankings, undo history) — planned, currently in-memory Map
- **Gemini Flash Lite for ranking** (~$2-5 for full library via Batch API)
- **Never hard-delete** — always Immich trash with 30-day recovery
- **Existing ratings are sacred** — never auto-downgrade

## Thresholds (configurable)

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
