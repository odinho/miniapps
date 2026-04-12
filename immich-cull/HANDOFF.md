## Handoff — immich-cull sessions 2026-04-11 to 2026-04-12

### What happened

Two massive sessions: built complete auto-cull system, ran 165+ batches through
3.1-flash-lite, exhaustive threshold analysis, prompt experiments, staged cull
pipeline, Immich API integration, and write-back module. **The system is now
end-to-end functional with the full 72k Immich library.**

### Current state

Server running in `--immich-api` mode against production Immich (v2.5.2):
```bash
npx tsx src/server.ts --immich-api --vertex --port 3737
```
- 72,685 assets loaded via REST API
- 5,824 session batches (4,318 DSLR folder + 1,506 phone time-gap)
- Fresh state.db (no decisions yet on Immich data)
- Facet test data backed up to `data/state.db.facet-backup-20260412`
- Images served via Immich thumbnail proxy (no filesystem access needed)

### Architecture

**Data flow:**
  Immich API → asset listing → time-based batching → LLM ranking →
  auto-cull classification → staged review → write-back to Immich

**Server modes:**
  `--local` — Facet SQLite + local filesystem (development)
  `--immich` — Immich PostgreSQL + filesystem (SSH tunnel, CLIP clustering)
  `--immich-api` — Immich REST API only (no tunnel, no CLIP, LLM does grouping)

**Key modules:**
  `src/db/immich-api-adapter.ts` — REST API: search/metadata, thumbnails, originals
  `src/db/immich-writeback.ts` — trash, ratings, tags via Immich API
  `src/ranking/auto-cull.ts` — tiered classification (auto-cull-high/auto-cull/review)
  `src/ranking/prompt.ts` — v1 "balanced" prompt (50-60% keep, 1-2 per subgroup)
  `src/ranking/second-pass-prompt.ts` — head-to-head comparison (designed, not wired)
  `web-app/src/components/AutoCullReview.svelte` — full-page cull comparison view
  `web-app/src/components/StarsReview.svelte` — star rating inspection page
  `web-app/src/components/CullReview.svelte` — per-batch cull comparison overlay

**DB schema v7:**
  `photo_decisions` — state, user_stars, source, llm_run_id, star_source
  `llm_batch_runs` — per-model LLM results with supersession
  `auto_keep_patterns` — regex patterns for known-good filtering
  `view_status` — group/batch completion tracking

### Auto-keep patterns

See README.md. Current pattern: `/Snapchat/Snapchat-` (filters ~2000 assets).

### Auto-cull calibration (from Facet test data)

Calibrated on 149 discriminating batches (1434 photos, 2024+, 3.1-flash-lite).

| Tier | Criteria | Wrong-cull | Coverage |
|------|----------|------------|----------|
| HIGH | deficit>=2, bottom-half rank, sg>=3 | ~9.4% | 16.1% |
| STANDARD | stars=0, sg_keeper, sg>=3 | ~22.7% | 39.4% |

Visual inspection of ALL wrong culls: every one is borderline. User confirmed
toddler/cat and snowy streets are acceptable culls. True "bad cull" ~2-4%.

**Prompt v1 tested on 12 batches (156 photos):** Halves wrong-culls vs v0.
The remaining wrong-culls are mostly different-moment disagreements (LLM picks
technical quality, user values storytelling).

**IMPORTANT: These numbers are from the Facet test set. Need to re-validate
on the full Immich library — DSLR photos may behave differently.**

### Star rating mapping (shift-1)

LLMs never give 5★ and rarely 4★. Shift-1 mapping:
  LLM 0-1 → 0★ Immich (72%, unstarred)
  LLM 2   → 1★ Immich (20%, good photo)
  LLM 3   → 2★ Immich (7%, share-worthy)
  LLM 4-5 → 3★ Immich (0.5%, exceptional)

Stars tracked with `star_source='llm'|'user'`. LLM stars can be bulk-cleared
via `clearLlmStars()`. Write-back tags LLM-rated photos with `ai:rated` in Immich.

### Immich write-back (ready, not yet executed)

```bash
# Dry run:
curl -X POST http://localhost:3737/api/immich/writeback \
  -H "Content-Type: application/json" -d '{"dryRun":true}'

# Execute (trash culled, set stars, tag ai:rated):
curl -X POST http://localhost:3737/api/immich/writeback \
  -H "Content-Type: application/json" -d '{"dryRun":false}'
```

Write-back is read-only by default (dryRun:true). Trash goes to Immich's
30-day recovery, never permanent delete.

### UI tabs

1. **Batches** — browse/review batches, run LLM, approve decisions
2. **Auto Review** — full-page cull comparison across ALL batches
3. **Stars** — inspect star ratings at each level with thumbnails
4. **Groups** — legacy clustering view (empty in API mode)

Sidebar: Open batches first → Done collapsed → Show More pagination

### Remaining work (priority order)

1) **RUN LLM ON IMMICH BATCHES**: Start with a sample of 10-20 diverse batches
   to validate the v1 prompt works well on DSLR photos. Check cull rate and
   whether the auto-cull tiers look right on production data.

2) **VALIDATE AUTO-CULL ON PRODUCTION**: The calibration numbers are from
   Facet test data. Need to review a few auto-cull decisions on real Immich
   photos to build confidence before scaling up.

3) **SCALE UP LLM**: Once validated, run 3.1-flash-lite on all 5,824 batches.
   Cost estimate: ~$15-30 on Vertex AI (~72k images × ~$0.0002-0.0004/image).

4) **EXECUTE WRITE-BACK**: After enough batches reviewed, do the actual
   trash + star write-back to Immich. Start with dry-run, verify counts.

5) **LLM IMAGE ACCESS**: Currently the LLM client reads images from filesystem
   via `resolveFilePath`. In API mode, images need to be fetched from Immich
   thumbnails instead. The `rankBatch` function needs updating for this.
   (The preview/full endpoints already proxy correctly.)

6) **PROMPT TUNING ON DSLR**: DSLR photos are higher quality and may need
   different prompt calibration. The current prompt was tuned on phone photos.

7) **STAR CALIBRATION**: Check the Stars tab to verify the shift-1 mapping
   looks right. The 9 three-star photos (LLM 4★) should be truly exceptional.

### Known issues

- `resolveFilePath` in LLM client doesn't work for API mode (needs Immich thumbnail proxy)
- CullReview component not model-aware (always uses default model)
- Cull comparisons endpoint shows all culls, not just review-tier
- Recursive pagination in API adapter could theoretically stack overflow on huge libraries
- 556 batches with 1-2 photos (wasteful for LLM) — should be merged or auto-kept

### Commits this session (20)

```
73485d5 Improve sidebar: split open/done, show-more pagination
caea381 Fix UX: default to batches, limit sidebar, auto-load
410f0ec Add --immich-api mode: fetch photos via REST API, proxy thumbnails
2834844 Switch to shift-1 star mapping and add star inspection endpoint
fc2fda3 Tag LLM-rated photos in Immich with 'ai:rated'
04bee86 Backfill LLM stars: 428→1250 photos get Immich stars
c2468f2 Use mapLlmStarsToWriteback for star write-back
8bf7d48 Add Immich API adapter and star rating provenance
759cd3d Add Immich write-back module for trashing culled photos
2132a5a Add Auto Review and Stars tabs as full top-level pages
2d3b099 Add staged cull pipeline and cull comparison review UI
049a009 Switch production prompt to v1: balanced 1-2 keeps per subgroup
(+ 8 earlier commits: analysis, auto-cull system, prompt experiments)
```

### How to run

```bash
cd /home/odin/Kode/homelab/immich-cull

# Immich API mode (production):
npx tsx src/server.ts --immich-api --vertex --port 3737

# Local Facet mode (testing):
cp data/state.db.facet-backup-20260412 data/state.db
npx tsx src/server.ts --local --vertex --port 3737

# Web UI:
cd web-app && npm run dev -- --host
# Open http://192.168.10.88:5173

# Check everything:
npm run check
```
