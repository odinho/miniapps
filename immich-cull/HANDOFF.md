## Handoff — immich-cull session 2026-04-07 to 2026-04-11

### What happened this session

Massive session: 30+ commits on feat/immich-cull. Started with UI bugs,
ended with multi-model LLM comparison and Gemma4 local inference.

### Key decisions

- 3-layer state model: llmState (reactive) > manualOverrides (user clicks) > effectiveState
- Stars are per-subgroup: primary keeper gets max, others get 0 (for useful star filtering)
- LLM star scale expanded to 0-5 (was 0-3), mapped down for write-back
- Viewing LLM suggestions is non-destructive — only Approve saves to DB
- All LLM runs preserved (superseded, not deleted) for analysis
- Gemini 3.x models need locations/global on Vertex AI (auto-detected)
- Gemma4 local model works but 58% agreement — not reliable enough for auto-cull
- gemini-3.1-flash-lite-preview is the best model: 82% agreement, 6.4% over-keep, 11.7% over-cull
- User prefers LLM to keep too much rather than lose good photos

### Architecture changes

State rearchitected from single mutable `states` map to:
  web-app/src/lib/state.ts — pure functions (deriveLlmState, mergeStates, countAtLevel, etc)
  web-app/src/lib/__tests__/state.test.ts — 21 tests
  web-app/src/App.svelte — reactive $: chains, no imperative state mutation

LLM client (src/ranking/llm-client.ts):
  - Interleaved text+image parts in single Content (fixed index misalignment)
  - Index watermark (#N) on each image
  - Three providers: vertexai, openrouter, ollama
  - expandCompactResponse exported, used by both client and server (deduplicated)
  - Handles Gemma's object-style sg.all entries
  - Strips 1-photo subgroups
  - deriveLlmState uses recommendedKeepIds (not positional first-N)

Model switcher UI:
  - Manual button (shows saved user decisions, yellow when has data)
  - Model buttons: 2.5-lite, 3.1-lite, 3-flash, gemma4
  - Green = active, yellow = cached, grey = not run
  - Click = switch to cached or run if needed
  - Shift+R = cycle through all views
  - r = re-run current model (force fresh)
  - Re-run invalidates only the specific model, not all

### Tooling added

  npm run check — full pipeline: oxlint + oxfmt + tsgo + svelte-check + vitest
  .oxlintrc.json, .oxfmtrc.json in both root and web-app
  @typescript/native-preview (tsgo) for fast type-checking
  svelte-check --fail-on-warnings

### Database state

  Schema: v6 (v5 active, v6 added auto_keep_patterns table — reverted but table remains)
  photo_decisions: 3174 entries (2169 keep, 1005 cull)
  llm_batch_runs: 480 completed (402 gemma, 45 2.5-lite, 20 3.1-lite, 13 3-flash)
  view_status: 404 reviewed batches (user went through all batches manually)
  Backup: data/state.db.backup-20260410-full

### Model comparison results (scripts/compare_models.py)

  gemini-3.1-flash-lite-preview: 82% agree, 6.4% over-keep, 11.7% over-cull (BEST)
  gemini-3-flash-preview:        75% agree, 15.9% over-keep, 9.1% over-cull (limited data)
  gemini-2.5-flash-lite:         67% agree, 20.7% over-keep, 12.7% over-cull
  gemma4:e4b:                    58% agree, 11.2% over-keep, 30.6% over-cull

  On 100k photos, 3.1-flash-lite would wrongly cull ~11,700 photos (11.7%).
  Not safe for blind auto-cull yet. Need <2-3% wrong-cull for that.

### Prompt tuning (src/ranking/prompt.ts)

  Calibrated from 3000+ photo agreement analysis.
  Category-specific: action (strict), snapchat_save (keep), screenshots (keep).
  Grouping: "very few singletons", scene-based not time-based.
  Subgroups: "single best frame" default, second only if genuinely different framing.
  Concrete JSON example added for smaller models.

### Gemma4 experiments (scripts/)

  gemma_prompt_experiment.py — tested 7 prompt variations
  gemma_two_pass.py — describe-then-decide + thinking mode
  run_all_gemma.sh — ran gemma4 on all 402 batches (6 hours)
  
  Findings: simplified prompts best (77% on easy batches). Thinking mode
  inconsistent (helps sometimes, hurts others). Image size (512 vs 800)
  has no effect. Two-pass descriptions too generic to be useful.
  Gemma's ceiling is ~58% — too small a model for this task.

### Remaining work for next session

1) CONFIDENCE-BASED AUTO-CULL: Only auto-cull when LLM says cull AND stars=0
   AND photo is in a subgroup with a clearly better alternative. Target <3%
   wrong-cull rate on a smaller cull volume. Prototype on existing data.

2) TWO-TIER MODE: Auto-cull obvious (blurry, exact dupes), flag rest for review.
   Could use the +/- keepLevel mechanism — auto-approve at aggressive level,
   present borderline cases for human review.

3) MORE 3-FLASH DATA: 7 reviewed batches have 3.1-lite but not 3-flash.
   Run those to get better 3-flash comparison: 2024-03-24-b289638120b4,
   2024-02-10-75515d02efc2, 2024-03-29-23dfb15bca68, 2024-01-13-d9e88b447969,
   2024-05-13-31e8131d9fe9, 2024-05-04-bfd62461f9ed, 2024-03-02-96641cbec175

4) IMMICH WRITE-BACK: Not started. Need soft-delete via Immich API, star
   ratings, XMP sidecars. This is the actual goal of the project.

5) FULL LIBRARY: Immich adapter works (72k images, SSH tunnel tested).
   Need to run clustering + LLM on full library. Cost estimate for
   3.1-flash-lite on 72k images: ~$15-25.

6) Snapchat saves: 99.8% keep rate on /Snapchat/Snapchat-* paths.
   Auto-keep feature was reverted (LLM still needs to process them).
   Revisit: exclude from LLM batches entirely, auto-set keep.

7) STALE DOCS: PLAN.md and LLM_INTEGRATION_PLAN.md are outdated.
   README.md and docs/architecture.md are fresh (updated this session).

### Known bugs / tech debt

- Undo can't restore undecided states (loadPhotoStates skips null)
- Undo leaves stale star ratings (only restores snapshot keys)
- No abort controller for rapid group/batch navigation (race condition)
- App.svelte is still monolithic (~500 lines) — could extract more components
- PLAN.md, LLM_INTEGRATION_PLAN.md, STAR_RATING_PHILOSOPHY.md are stale
- auto_keep_patterns table exists in DB (schema v6) but code was reverted

### How to run

  cd /home/odin/Kode/homelab/immich-cull
  npx tsx src/server.ts --local --vertex --port 3737
  cd web-app && npm run dev -- --host
  # Open http://192.168.10.88:5173

  # SSH tunnel for Immich:
  ssh -f -N -L 15432:172.20.0.2:5432 odin@192.168.10.74
  npx tsx src/server.ts --immich --vertex --port 3737

  # Analysis:
  python3 scripts/compare_models.py
  python3 scripts/gemma_prompt_experiment.py --batch BATCH_ID
