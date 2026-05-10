# Overnight LLM Burst Discriminator Experiment

Run: 2026-04-18 night → 2026-04-19 morning
Task: Given a burst of 3–14 near-duplicate photos with known user decisions, each variant picks the best photo(s). Matched against user ground truth.
Sample: 30 real burst/near-duplicate groups sampled from state DB (3843 user decisions available).

## Headline

**Prod (`gemini-3.1-flash-lite-preview`) still wins at 86% user match.** The best local option is `qwen3.6:35b-a3b` (MoE, 3B active) at **79% in 61s/group** with a terse prompt — viable offline fallback. **`gemma4:31b` is not worth it** — same accuracy (80%) but 8× the compute (495s/group).

## Results

### Stage A (30 groups, all variants, unbiased where complete)

| Variant | Complete | User match | Avg/group | Cost |
|---|---|---|---|---|
| **31flashlite (prod)** | 29/30 | **24/28 (86%)** | 4s | cloud $ |
| **qwen3.6:35b-a3b nothink** | 30/30 | **23/29 (79%)** | 86s | local |
| **qwen3.6:35b-a3b terse-prompt** | 30/30 | **23/29 (79%)** | **61s** | local |
| gemma4:e4b | 30/30 | 13/29 (45%) | 47s | local |
| ~~gemma4:31b dense~~ | 13/30 | 13/13 (100% *biased*) | 192s | infra-failed |
| ~~qwen3.6:35b-a3b think~~ | 6/30 | 5/6 (83% *biased*) | 163s | infra-failed |

### Stage B4 (15 groups, gemma4:31b alone with undici fix — UNBIASED)

| Variant | Complete | User match | Avg/group | Errors |
|---|---|---|---|---|
| gemma4:31b dense | 15/15 | **12/15 (80%)** | **495s** | 0 |

By size:
- small (3 photos): 3/3 (100%)
- medium (4–5): 5/6 (83%)
- large (6+): 4/6 (67%)

**Gemma4:31b's earlier 100% was selection bias.** Real quality is ~80%, on par with qwen-MoE but ~8× slower.

## Infra fix (confirmed)

Root cause of earlier failures: **undici's default 300s `headersTimeout`**. On CPU-bound Ollama generations with ≥4 images, the time from POST to first response byte routinely exceeded 300s (we measured 579s on a 14-photo gemma4:31b call). Node's fetch threw `UND_ERR_HEADERS_TIMEOUT` before any data arrived.

Fix applied in `scripts/burst_discriminator_experiment.ts`:

```ts
import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(
  new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30000 }),
);
```

Required `npm install undici` (Node 22 ships undici internally but doesn't expose its classes as a module). Stage B4 ran 15/15 groups with **zero fetch errors** at generation times up to 813s.

(Bun alternative: would need `timeout: false` in fetch init. Tested and works, but the project's `better-sqlite3` dependency isn't Bun-compatible yet, so we stayed on Node.)

## Hypothesis scorecard

### H1 — MoE (qwen-a3b) ≥ dense (gemma4:31b)
**Tied on quality, MoE dominates on cost.** Qwen-a3b 79% vs gemma4:31b 80% — statistically equivalent on 15–29 groups. But qwen averages 61–86s/group, gemma4:31b averages 495s. 8× compute for zero quality benefit — don't use gemma4:31b.

### H2 — qwen thinking > qwen no-thinking
**No.** Thinking mode hit a different failure mode: verbose `<think>` blocks consumed `num_predict=4000` before closing the JSON, truncating output. Quality signal (5/6 where it completed) is indistinguishable from no-thinking, and compute is ~10× more. Not worth deploying.

### H3 — local ≥ cloud prod
**No.** 79% (best local) vs 86% (prod) is real. Prod still wins quality by ~7pp. Local cuts cost to zero but trades accuracy.

### H4 — nvfp4 quant quality vs q4_K_M
**Untested** — Ollama's `gemma4:31b-nvfp4` manifest is macOS-gated.

### H5 — group size stability
**Yes for competitive variants.**

| Variant | Small (3) | Med (4–5) | Large (6+) |
|---|---|---|---|
| 31flashlite | 6/6 (100%) | 8/9 (89%) | 10/13 (77%) |
| qwen_nothink | 5/6 (83%) | 8/9 (89%) | 10/14 (71%) |
| qwen_terse | 5/6 (83%) | 8/9 (89%) | 10/14 (71%) |
| gemma4_e4b | 3/6 (50%) | 6/9 (67%) | 4/14 (29%) |

Top variants degrade ~10pp from small to large; gemma4:e4b falls off a cliff at 6+.

### H6 — keep-count bias (the "generous" goal)
**All LLMs are too strict.**

| | Avg picks/group |
|---|---|
| **User (truth)** | **2.07** |
| 31flashlite | 1.21 |
| qwen_nothink | 1.10 |
| qwen_terse | 1.00 |
| gemma4_e4b | 1.00 |

User keeps ~2 per group; every tested LLM returns ~1. Prompt told them to keep up to 2 "if genuinely different". The `terse` prompt was strictly more literal (always 1). **Follow-up win: rewrite the prompt to push keep-2-by-default, keep-1-only-if-truly-duplicate. This matches user's "keep more" preference.**

### H7 — subgroup type
Too few `near_duplicate` groups (3) to draw conclusions. On the 26 `burst` groups, prod/qwen are neck-and-neck (22 vs 21).

### H8 — ensemble (majority vote of prod+qwen_nothink+qwen_terse)
**No win.** 23/28 (82%) — slightly worse than prod alone (86%). The two qwen variants agree too much (they're the same model), so majority vote mostly tracks them, not prod.

### H9 — terse prompt vs full prompt on qwen
**Same accuracy, 30% faster.** Both hit 23/29 (79%). Terse ran at 59s/group vs full at 83s — same quality, less output. **If deploying qwen locally, use the terse prompt.**

### H10 — temperature=0
Not varied in this run (memory says settled). Carried forward from prior experiments.

## What I'd recommend deploying

**Tiered strategy:**

1. **Keep prod gemini-3.1-flash-lite** as the default for culling runs that matter — the +7pp accuracy beats local.
2. **Add `qwen3.6:35b-a3b` with terse prompt** as an offline/free-compute fallback for:
   - Re-runs where cost matters more than accuracy
   - Offline processing when cloud quota is exhausted
   - A cross-check signal (show user both verdicts, flag disagreements)
3. **Drop `gemma4:e4b`** — at 45% it's a coin flip, not worth the batch slot.

## Prompt fix to try next

Modify the production prompt: default to **keep 2**, only keep 1 if truly identical (rather than vice-versa). User memory says "LLM should keep too much" — current prompt is too strict. At user's 2.07 avg vs LLMs at 1.00-1.21 there's real room.

## Raw data

- Stage A final JSON (30 groups, 6 variants): `/tmp/burst-discriminator-2026-04-19T02-30-34-783Z.json`
- Stage B4 final JSON (15 groups, gemma4:31b unbiased): `/tmp/burst-discriminator-2026-04-19T08-57-05-344Z.json`
- Logs: `/tmp/overnight-bench/run-20260418-223103.log`, `/tmp/overnight-bench/stageB4-20260419-085323.log`
- Script as modified: `scripts/burst_discriminator_experiment.ts` (adds `--only`, `--preview`, streaming, think toggle, terse prompt variant, undici headersTimeout fix)
- Standalone reproducer for the timeout bug: `/tmp/overnight-bench/repro.mjs`
