# LLM model findings

## Model comparison (measured on 3000+ manually-reviewed photos)

| Model                         | Agreement | Cost | Speed      | Notes                                 |
| ----------------------------- | --------- | ---- | ---------- | ------------------------------------- |
| gemini-3.1-flash-lite-preview | **82%**   | $$   | ~5s/batch  | Best. Default. Vertex global routing. |
| gemini-3-flash-preview        | 75%       | $$$  | ~8s/batch  | Better than 2.5 but expensive         |
| gemini-2.5-flash-lite         | 67%       | $    | ~3s/batch  | Cheapest cloud option                 |
| gemma4:e4b (Ollama)           | 58%       | Free | ~70s/batch | Not competitive for this task         |

## Key findings

- **Temperature 0** outperforms 0.2 — more deterministic, fewer hallucinated subgroups. Applied to all production paths (Vertex AI, OpenRouter, Ollama).
- **Thinking mode**: LOW helps 3-flash (3.8% wrong-cull — half of any other variant). HIGH hurts both flash-lite and 3-flash (overthinks, more aggressive culling). Gemma4 thinking can't be controlled in Ollama 0.20.7.
- **Multi-model agreement**: When `31flashlite_temp0` and `3flash_think_low` agree on cull, wrong-cull rate drops well below either model alone. The `/api/batches/:id/agreement` endpoint computes per-photo consensus across models.
- **Gemma4:e4b is not competitive** (~48% agreement). Keeps almost everything. Image resolution (512-1024px) has no effect — Ollama normalizes to ~269 vision tokens regardless.
- **Gemini 3.x models require `global` location** on Vertex AI (not regional)
- **Vertex batch prediction doesn't support global routing** — can't batch 3.x models yet. Use `rank:many` (parallel real-time) instead.
- **Safety filtering**: ~60 of 5665 batches (~1%) return empty responses. These contain children in baths/pools. Must be reviewed manually.
- **Wrong culls** are almost always borderline (different-moment disagreements, not catastrophic errors). True bad-cull rate is ~2-4%.
- **LLM never gives 5 stars**, rarely 4. Stars are compressed toward the low end.

## Multi-model agreement (2026-04-14 experiment)

Tested 11 variants on 260 photos across 10 diverse batches:

| Variant               | Agree% | WrongCull% | Best for                                 |
| --------------------- | ------ | ---------- | ---------------------------------------- |
| 31flashlite_temp0     | 71.2%  | 9.6%       | Overall accuracy, speed                  |
| 3flash_think_low      | 69.9%  | 3.8%       | Safety (fewest wrong culls)              |
| 31flashlite_think_low | 71.9%  | 10.8%      | Slightly better agree%, more wrong culls |
| 3flash_think_high     | 63.7%  | 10.5%      | Not recommended (overthinks)             |

Recommended pair: `gemini-3.1-flash-lite-preview` + `gemini-3-flash-preview` (with thinking LOW). Batches where both agree can be bulk-approved via `POST /api/batches/approve-confident`.

## Auto-cull tier calibration (Facet test set, 149 batches / 1434 photos)

| Tier     | Criteria                            | Wrong-cull | Coverage |
| -------- | ----------------------------------- | ---------- | -------- |
| HIGH     | deficit>=2, bottom-half rank, sg>=3 | ~9.4%      | 16.1%    |
| STANDARD | stars=0, sg_keeper, sg>=3           | ~22.7%     | 39.4%    |

Prompt v1 ("balanced, 1-2 keeps per subgroup") halves wrong-culls vs v0. Remaining wrong-culls are mostly different-moment disagreements (LLM picks technical quality, user values storytelling). These numbers are from the Facet test set and need re-validation on DSLR-heavy Immich data.

## Star mapping (LLM → Immich)

LLM stars are mapped through `mapLlmStarsToWriteback` at write-back time:

| LLM stars | Immich stars | Meaning      | Distribution |
| --------- | ------------ | ------------ | ------------ |
| 0-1       | 0            | Unstarred    | ~72%         |
| 2         | 1            | Good photo   | ~20%         |
| 3         | 2            | Share-worthy | ~7%          |
| 4-5       | 3            | Exceptional  | ~0.5%        |

User star overrides are written directly (no mapping).
