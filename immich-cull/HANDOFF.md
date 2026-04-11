## Handoff — immich-cull session 2026-04-11

### What happened this session

Built a complete confidence-based auto-cull system with exhaustive threshold
analysis. Ran gemini-3.1-flash-lite-preview on 165 batches (up from 20).
The big finding: **prompt improvement is higher leverage than threshold tuning**.
The LLM's "single best frame" philosophy doesn't match the user's "keep distinct
moments" approach, causing ~10-23% wrong-cull rates that can't be threshold-tuned away.

### Auto-cull system (new)

**Architecture:**
- `src/ranking/auto-cull.ts` — pure classification: `auto-cull-high`, `auto-cull`, `review`
- Server: GET /api/batches includes auto-cull stats, POST /api/batches/auto-approve
- Frontend: orange AUTO badges, per-batch auto-approve button, sidebar stats
- DB: `source` + `llm_run_id` columns for provenance, auto-revert on run supersession
- Second-pass prompt designed: `src/ranking/second-pass-prompt.ts` (head-to-head comparison)

**Calibrated on 149 discriminating batches (1434 photos, 2024+ data):**

| Tier | Criteria | Wrong-cull | Coverage |
|------|----------|------------|----------|
| HIGH | deficit>=2, bottom-half rank, sg>=3 | 9.4% | 16.1% |
| STANDARD | stars=0, sg_keeper, sg>=3 | 22.7% | 39.4% |
| REVIEW | everything else | — | 60.6% |

**Best sub-10% strategies found:**
- S4+sz>=3+deficit>=2: 9.7% wrong-cull, 17.1% coverage
- S4+sz>=3+bottom_half+deficit>=2: 9.4%, 16.1%
- S4+sz>=3+bottom_third+deficit>=2: 8.1%, 13.3%

**Critical findings from expanded data (149 vs 20 batches):**
- Small sample (20 batches) showed 2-4% wrong-cull → real rate is 8-10%
- Codex identified counting bug in multi-model analysis (now fixed)
- No threshold strategy gets below 8% with meaningful coverage
- The "single best frame" prompt is the root cause of wrong culls

### Wrong-cull patterns (from looking at actual photos)

Examined the wrong-cull photos visually. They show:
1. **Different moments in same interaction** — child looking at cat vs reaching for cat
2. **Different compositions** — child looking up in tunnel vs looking at camera
3. **Multiple variants user values** — 4 of 5 snowy street views kept

The LLM correctly identifies "redundancy" but the user values storytelling progression.
This is a prompt alignment issue, not a threshold issue.

### Prompt improvement (highest priority for next session)

The current prompt says: "Default to keeping ONLY the single best frame per subgroup."
This is too aggressive. The user keeps 2-3 frames from same scene when they show:
- Different expressions (smiling vs laughing)
- Different action stages (walking vs reaching)
- Different framings that add context

**Prompt variants designed** (in `scripts/test_prompt_variants.py`):
- v0_current: single best frame (current)
- v1_generous_subgroups: 1-2 default, 2-3 for large subgroups
- v2_moment_focused: keep different moments separately
- v3_conservative_cull: 60-70% keep, only cull clearly redundant

**Test batches identified** (high disagreement, diverse content):
1. 2024-02-10-75515d02efc2 — ball pit + snowy streets (8 disagreements, 7 categories)
2. 2024-05-10-b4523b5454de — toddler + cat (6 disagreements)
3. 2024-01-19-c53da31d70ea — sledding (5 disagreements)
4. 2024-05-04-bfd62461f9ed — conference + kids (4 disagreements)
5. 2024-01-20-2e6b7895301b — snowy walk (3 disagreements)
6. 2024-03-24-b289638120b4 — playground tunnel (3 disagreements)

### Batch era analysis

**1970 batches** (no-date Snapchat): 100% user keep — auto-cull impossible, use known-good filter
**2015-2022 batches**: 94% user keep — not useful for calibration
**2024+ batches**: 55% user cull rate — discriminating reviews, calibration-worthy

Auto-cull must be calibrated ONLY on discriminating batches (keep rate < 90%).

### Analysis scripts

- `scripts/extract_autocull_data.py` — extracts enriched LLM data to JSON cache
- `scripts/analyze_autocull_thresholds.py` — tests 54+ strategies against cache
- `scripts/test_prompt_variants.py` — prompt variant testing framework
- `scripts/expand_31lite_coverage.sh` — runs 3.1-flash-lite on reviewed batches
- `scripts/run_3flash_batches.sh` — runs 3-flash on specific batches

### Codex review findings (incorporated)

1. Small-sample overfit: 20-batch strategies looked 2-4% but real rates are 8-10%
2. Multi-model ensemble had double-counting bug (same photo counted per model)
3. sg_confidence always 0.8 (default) — confidence gates are no-ops
4. best_deficit + rank_frac combo is strongest structural signal
5. Category exclusions help marginally but prompt fix is the real lever

### Database state

Schema: v6 (source + llm_run_id columns added)
photo_decisions: 3174 entries, all source='manual'
llm_batch_runs: 675 completed (165 are 3.1-flash-lite)
auto_keep_patterns: 1 entry (/Snapchat/Snapchat-)
Backup: data/state.db.backup-20260410-full

### Known-good filtering (new)

Server reads `auto_keep_patterns` table, filters before batching.
`--include-all` bypasses. Filters Snapchat paths.

### Stale docs archived

PLAN.md, LLM_INTEGRATION_PLAN.md, STAR_RATING_PHILOSOPHY.md → docs/archive/

### Remaining work

1) **PROMPT TUNING** (highest priority): Test v1-v3 prompt variants on 2 test batches.
   Expected to reduce wrong-cull at source. Then re-calibrate thresholds.

2) **SECOND-PASS IMPLEMENTATION**: Head-to-head comparison for borderline cases.
   Prompt designed but not yet wired to LLM client.

3) **IMMICH WRITE-BACK**: Not started. Soft-delete via API, star ratings, XMP.

4) **FULL LIBRARY**: Run on 72k images. Auto-cull handles ~17-40% of culls.

5) **REMOVE GEMMA4**: 58% agreement, not useful. Remove from model list.

### How to run

  cd /home/odin/Kode/homelab/immich-cull
  npx tsx src/server.ts --local --vertex --port 3737
  cd web-app && npm run dev -- --host
  # Open http://192.168.10.88:5173

  # Analysis:
  python3 scripts/extract_autocull_data.py --all-models
  python3 scripts/analyze_autocull_thresholds.py --model gemini-3.1-flash-lite-preview
  python3 scripts/test_prompt_variants.py --all-test-batches
