## Handoff — immich-cull session 2026-04-11

### What happened this session

Built a complete confidence-based auto-cull system with exhaustive threshold
analysis. Ran gemini-3.1-flash-lite-preview on 215+ batches (up from 20).
Key finding: auto-cull works well on discriminating reviews but must filter
out bulk-kept batches (Snapchat, old photos).

### Auto-cull system (new)

**Architecture:**
- `src/ranking/auto-cull.ts` — pure classification: `auto-cull-high`, `auto-cull`, `review`
- Server: GET /api/batches includes auto-cull stats, POST /api/batches/auto-approve
- Frontend: orange AUTO badges, per-batch auto-approve button, sidebar stats
- DB: `source` + `llm_run_id` columns for provenance, auto-revert on run supersession

**Tiered auto-cull criteria (all require: LLM says cull, stars=0, in subgroup, sg has keeper):**
- **HIGH confidence** (keeper >= 2 stars): ~3.8% wrong-cull, ~34% coverage
- **STANDARD** (keeper < 2 stars): ~9.7% wrong-cull, ~56% coverage
- **Review**: everything else (singletons, stars > 0, small subgroups)

**Smart layered strategy** (sub-5% error):
- L1: keeper>=2 stars — 3.8% error, 33.6% coverage
- L1+L2a: safe categories (portrait, pet, screenshot, food) — 4.7% error, 40.9% coverage
- L2b: action/landscape — 20.7% error, needs review

### Critical analysis finding

**Batch era matters enormously:**
- 1970 batches (no-date Snapchat): 100% user keep — auto-cull is 100% wrong
- 2015-2022 batches: 94% user keep — almost no culling done
- 2024+ batches: 37% user keep — real discriminating review

Auto-cull should ONLY be calibrated on discriminating reviews (keep rate < 90%).
The known-good filtering (auto_keep_patterns table) handles the Snapchat issue.

### Analysis scripts

- `scripts/extract_autocull_data.py` — extracts enriched LLM data to JSON cache (needs server once)
- `scripts/analyze_autocull_thresholds.py` — tests 54+ strategies against cache (instant, no server)
- `scripts/expand_31lite_coverage.sh` — runs 3.1-flash-lite on reviewed batches
- `scripts/run_3flash_batches.sh` — runs 3-flash on specific batches

### Wrong-cull patterns (from 9 wrong culls in S4+sz>=3 on 2024 data)

1. **User keeps more variants** (3/9): same_scene subgroup, user kept 4 of 5 nearly identical
2. **User values different photo than LLM** (4/9): user chose the "moment" over technical quality
3. **User kept one extra from burst** (2/9): action shots, car window landscapes

All borderline, zero severe (no user-starred photos wrongly culled).

### Second-pass system (designed, not yet implemented)

For photos in the "review" tier, head-to-head comparison:
- Show keeper + cull candidate side by side
- Binary keep/remove decision with confidence
- Use thinking-enabled model for higher accuracy
- Prompt: `src/ranking/second-pass-prompt.ts`

### Database state

Schema: v6 (added source + llm_run_id columns)
photo_decisions: 3174 entries, all source='manual'
llm_batch_runs: 530+ completed (expanding — running 3.1-flash-lite on 145 more 2024 batches)
auto_keep_patterns: 1 entry (/Snapchat/Snapchat-)

### Known-good filtering (new)

Server now reads `auto_keep_patterns` table and filters assets before batching.
`--include-all` flag bypasses. Currently filters Snapchat paths.

### Stale docs archived

PLAN.md, LLM_INTEGRATION_PLAN.md, STAR_RATING_PHILOSOPHY.md → docs/archive/
README.md and docs/architecture.md are current.

### Key decisions this session

- Two-tier auto-cull (high/standard) instead of single threshold
- Auto-cull decisions bound to llm_run_id, auto-reverted on supersession
- Dropped auto-keep tier (system defaults to keep, no need to automate)
- Archive stale docs, don't delete (preserves design rationale)
- Use auto_keep_patterns DB table instead of hardcoded regex
- Analysis must filter to discriminating batches (keep rate < 90%)

### Remaining work

1) EXPAND DATA: Running 3.1-flash-lite on 145 more 2024+ batches (in progress).
   Will give ~165 discriminating batches for calibration.

2) SECOND-PASS IMPLEMENTATION: Wire up head-to-head comparison for review tier.
   Could use thinking mode on Gemini or Claude Sonnet as oracle.

3) IMMICH WRITE-BACK: Not started. Need soft-delete via Immich API, star
   ratings, XMP sidecars. This is the actual goal of the project.

4) FULL LIBRARY: Run clustering + 3.1-flash-lite on full 72k image library.
   With auto-cull, user reviews ~48% of culls instead of all.

5) REMOVE GEMMA4: Only 58% agreement, not useful. Remove from model list or
   deprioritize. Keep data for multi-model ensemble analysis.

### How to run

  cd /home/odin/Kode/homelab/immich-cull
  npx tsx src/server.ts --local --vertex --port 3737
  cd web-app && npm run dev -- --host
  # Open http://192.168.10.88:5173

  # Analysis:
  python3 scripts/extract_autocull_data.py --all-models  # needs server
  python3 scripts/analyze_autocull_thresholds.py --model gemini-3.1-flash-lite-preview
  python3 scripts/compare_models.py
