# LLM model findings

## Model comparison (measured on 3000+ manually-reviewed photos)

| Model | Agreement | Cost | Speed | Notes |
|---|---|---|---|---|
| gemini-3.1-flash-lite-preview | **82%** | $$ | ~5s/batch | Best. Default. Vertex global routing. |
| gemini-3-flash-preview | 75% | $$$ | ~8s/batch | Better than 2.5 but expensive |
| gemini-2.5-flash-lite | 67% | $ | ~3s/batch | Cheapest cloud option |
| gemma4:e4b (Ollama) | 58% | Free | ~70s/batch | Not competitive for this task |

## Key findings

- **Temperature 0** outperforms 0.2 — more deterministic, fewer hallucinated subgroups
- **Gemini 3.x models require `global` location** on Vertex AI (not regional)
- **Vertex batch prediction doesn't support global routing** — can't batch 3.x models yet. Use `rank:many` (parallel real-time) instead.
- **Safety filtering**: ~60 of 5665 batches (~1%) return empty responses. These contain children in baths/pools. Must be reviewed manually.
- **Wrong culls** are almost always borderline (different-moment disagreements, not catastrophic errors). True bad-cull rate is ~2-4%.
- **LLM never gives 5 stars**, rarely 4. Stars are compressed toward the low end.

## Star mapping (LLM → Immich)

LLM stars are mapped through `mapLlmStarsToWriteback` at write-back time:

| LLM stars | Immich stars | Meaning | Distribution |
|---|---|---|---|
| 0-1 | 0 | Unstarred | ~72% |
| 2 | 1 | Good photo | ~20% |
| 3 | 2 | Share-worthy | ~7% |
| 4-5 | 3 | Exceptional | ~0.5% |

User star overrides are written directly (no mapping).
