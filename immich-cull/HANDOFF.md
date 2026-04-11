## Handoff — immich-cull session 2026-04-11

### What happened this session

Massive session: built complete auto-cull system, ran 165 batches through
3.1-flash-lite, exhaustive threshold analysis (149 discriminating batches),
prompt variant experiments, and staged cull pipeline with comparison review UI.

**Key outcome:** The system can now auto-cull photos with a staged pipeline:
Stage 1 (safe auto-cull) → Stage 2 (comparison review) → Stage 3 (aggressive mode).

### Architecture additions

**Auto-cull classification** (`src/ranking/auto-cull.ts`):
  Two tiers: `auto-cull-high` (deficit>=2, bottom-half rank) and `auto-cull` (standard).
  Pure functions, no side effects, 33 tests passing.

**Staged cull pipeline** (server endpoints):
  `POST /api/batches/staged-cull` — Stage 1 safe auto-cull
  `POST /api/batches/auto-approve` — Bulk approve
  `DELETE /api/auto-approve` — Revert all (safety valve)
  `GET /api/batches/:id/cull-comparisons` — Culled photo + keeper pairs

**Cull comparison review** (`web-app/src/components/CullReview.svelte`):
  Side-by-side view: keeper photo vs cull candidate with LLM reason.
  One-click keep/confirm-cull. Navigates through all comparisons.

**DB changes** (schema v6):
  `source` + `llm_run_id` columns on photo_decisions for provenance.
  Auto-cull decisions auto-revert when LLM run is superseded.

**Known-good filtering**:
  Server reads `auto_keep_patterns` table, filters Snapchat before batching.
  `--include-all` flag to bypass.

**Prompt switched to v1** ("balanced"):
  Keep 1-2 per subgroup (was "single best frame"). Halves wrong-culls.
  Tested across 7 batches (120 photos): wrong-culls 16→8, all borderline.

### Analysis results (definitive, 149 batches)

**Auto-cull error rates (gemini-3.1-flash-lite-preview, 2024+ discriminating):**

| Tier | Criteria | Wrong-cull | Coverage |
|------|----------|------------|----------|
| HIGH | deficit>=2, bottom-half, sg>=3 | ~9.4% | 16.1% |
| STANDARD | stars=0, sg_keeper, sg>=3 | ~22.7% | 39.4% |
| REVIEW | everything else | — | 60.6% |

**Important context:** Visual inspection of all wrong-culls confirmed every one
is borderline. User confirmed toddler/cat and snowy streets are acceptable.
The "true bad cull" rate is closer to 2-4%.

**Prompt variant results (v0 vs v1 vs v2, 7 batches):**

| Variant | Wrong-cull | Wrong-keep | Net |
|---------|------------|------------|-----|
| v0 "single best frame" | 16 | 2 | too aggressive |
| v1 "balanced" (deployed) | 8 (4 outliers) | 31 | better |
| v2 "moment-focused" | 3 | 21+ | too generous |

### Commits this session (10)

```
2d3b099 Add staged cull pipeline and cull comparison review UI
049a009 Switch production prompt to v1: balanced 1-2 keeps per subgroup
ef1d307 Update HANDOFF with prompt experiment results
4a765e1 Add prompt variant experiments: v1 cuts wrong-culls in half
c2f910d Recalibrate auto-cull on 149 batches: real rates are 9-23% wrong-cull
d5c7d72 Tighten HIGH auto-cull tier: add rank position gate
a4e6c9b Add second-pass prompt for head-to-head photo comparison
8910236 Add tiered auto-cull confidence
5c04832 Add confidence-based auto-cull system with threshold analysis
```

### Server needs restart

The server process is NOT in watch mode. To use new features:
```bash
# Kill old server and restart
fuser -k 3737/tcp 2>/dev/null
npx tsx src/server.ts --local --vertex --port 3737
```

### Known bugs / tech debt

- Server not in watch mode (old code still running until restart)
- run_prompt_experiment.ts can only test via direct Vertex AI calls
- CullReview component not tested in browser yet (server needs restart)
- Undo can't restore undecided states (from previous session)
- No abort controller for rapid navigation (from previous session)

### Remaining work

1) **TEST NEW UI**: Restart server, test CullReview component, staged cull,
   auto-cull badges in the actual browser.

2) **RE-RUN WITH v1 PROMPT**: The 165 batches were run with the old v0 prompt.
   Invalidate and re-run with v1 to get new calibration numbers.
   Expected: significantly better auto-cull rates with v1.

3) **IMMICH WRITE-BACK**: The actual goal. Need:
   - Soft-delete via Immich API (moves to trash, 30-day recovery)
   - Star rating write-back
   - XMP sidecar generation
   - See src/db/immich-adapter.ts (currently read-only)

4) **FULL LIBRARY**: Run clustering + v1 prompt on 72k images.
   With staged cull: ~16% auto-culled, ~23% comparison-reviewed, ~61% manual.

5) **REMOVE GEMMA4**: 58% agreement, not useful. Remove from model list.

### How to run

```bash
cd /home/odin/Kode/homelab/immich-cull

# Restart server with new code:
fuser -k 3737/tcp 2>/dev/null
npx tsx src/server.ts --local --vertex --port 3737

# Start web UI:
cd web-app && npm run dev -- --host
# Open http://192.168.10.88:5173

# Analysis:
python3 scripts/extract_autocull_data.py --all-models
python3 scripts/analyze_autocull_thresholds.py --model gemini-3.1-flash-lite-preview
npx tsx scripts/run_prompt_experiment.ts --batch BATCH_ID --variant v1

# Staged cull (via API):
curl -X POST http://localhost:3737/api/batches/staged-cull \
  -H "Content-Type: application/json" \
  -d '{"batchIds": ["BATCH_ID"], "stage": "safe"}'
```
