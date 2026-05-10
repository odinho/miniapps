# Cull pipeline

How a photo in Immich ends up as kept or culled. Read top-to-bottom.

## Inputs

- **Immich library**: all photos, accessed via REST API (`IMMICH_URL` + `IMMICH_API_KEY`).
- **`data/state.db`**: user decisions, LLM run cache, view status. SQLite.
- **`data/immich-assets-cache.json`**: disk cache of asset metadata so we don't refetch the full library on every restart.

## Stage 1 — Batching

`src/batching/session-batcher.ts`.

- Phone photos: split sessions at time gaps ≥ 4 hours.
- Sub-split any session > 30 photos at the largest internal time gap.
- Non-phone (camera folders): batch by folder.
- Result: session-coherent batches, each ≤ 30 photos. One batch = "one event".

No LLM here. Pure metadata.

## Stage 2 — LLM ranking (per batch)

`src/ranking/prompt.ts` + `src/ranking/llm-client.ts`. Default model: `gemini-3.1-flash-lite-preview` (cheap Vertex AI cloud).

For each batch the LLM receives:
- All photos as inline images.
- A 92-line prompt (`SYSTEM_PROMPT`) with people-first priority, 0–5 stars, 17 category codes, subgroup detection rules, keep/cull guidance.

Returns a compact JSON response with, per photo:
- `suggestedStars` 0–5
- `categories` (up to 17 codes)
- `briefNote` — one-line description
- `similaritySubgroupId` — which burst/duplicate cluster it belongs to (if any)
- `llmKeepCull` — `"keep"` or `"cull"`

Plus `similaritySubgroups` — each with `imageIds` ordered best→worst, `recommendedKeepIds`, `cullIds`, rationale.

The raw response is cached in `state.db` keyed by `(batchId, fingerprint, model)`. No rerun until content changes.

**Multi-model**: you can run additional models against the same batch. Each is cached separately. See Stage 4 for how multiple models collaborate.

## Stage 3 — Face-coverage post-check

`src/ranking/face-coverage.ts` + `src/db/immich-face-fetcher.ts`. Pure deterministic post-processor, no LLM, runs on every `getAutoCullSummary` call.

Rule: every **named** person appearing in the batch must appear in at least one keeper. If someone is only in photos the LLM marked cull, greedy set-cover promotes the minimum number of photos back to keep.

- **Named only** — unnamed Immich clusters are ignored. Empirically they cause more harm than good (same person often split into named + unnamed clusters, triggering redundant promotions).
- **Tiebreakers**: photos covering more still-missing people > photos with more total faces > earlier in batch.
- **Disable**: set env `DISABLE_FACE_COVERAGE=1` before starting the server.

Validated on 80 graded batches:

| variant | acceptable-rate | sev-2 (regrets) |
|---|---:|---:|
| v1_prod alone | 96.2% | 3 |
| all-cluster face-cover | 95.0% | 4 (worse) |
| **named-only face-cover** | **97.5%** | **2** |

The `briefNote` on promoted photos gets `[face-cover: protects named person]` appended so it's visible in the review UI.

## Stage 4 — Auto-cull classification

`src/ranking/auto-cull.ts`: `classifyBatchForAutoCull`. Runs on the face-cover-modified image list.

Per-photo classification into one of three tiers:

| tier | criteria | wrong-cull rate (calibration) |
|---|---|---:|
| `auto-cull-high` | `llmKeepCull=cull`, stars=0, in a subgroup of ≥3, subgroup has a ≥2★ keeper, photo in bottom half of subgroup quality order | ~3.8% |
| `auto-cull` | `llmKeepCull=cull`, stars=0, in a subgroup of ≥3, subgroup has at least one keeper (other criteria weaker than HIGH) | ~9.7% |
| `review` | everything else — keepers, singletons, photos without a confident subgroup keeper | — |

Calibrated from 149 discriminating batches, 1434 photos (2024+ data, same LLM).

## Stage 5a — Single-model auto-apply

`/api/batches/auto-approve` + `/api/batches/staged-cull`.

Triggered manually from the UI or CLI. Applies `auto-cull-high` (and optionally `auto-cull`) decisions to `state.db`, marks the batch as reviewed, never touches photos with existing manual decisions.

## Stage 5b — Multi-model consensus auto-apply (opt-in)

`/api/batches/approve-confident` + `computeBatchAgreement`.

Used when you want a higher safety bar than a single model. Runs only on batches where ≥2 LLM models have each produced a result AND they **unanimously** agree on every photo's keep/cull. For those batches, decisions are applied with `source="consensus"`; otherwise the batch is left for review.

The `/api/batches` listing shows an `agreement.tier` per batch:
- `full-agreement` — ≥2 models, every photo unanimous — candidate for consensus approve.
- `partial-agreement` — ≥2 models but some photos disagree — needs review.
- `single-model` — only one LLM has run.
- `unrated` — no LLM has run yet.

## Stage 6 — Burst auto-cull (separate path)

`src/ranking/burst-auto-cull.ts`.

Pure-metadata detection of near-identical shutter bursts (same device, close timestamps, high embedding similarity). The best frame is kept, the rest are auto-culled with `source="burst-auto-cull"`. Runs independently of the LLM pipeline.

## Stage 7 — Immich writeback

`src/db/immich-writeback.ts`.

User decisions (keeps + stars) are pushed to Immich as asset ratings and metadata. Culls are staged; archival/deletion in Immich is a separate user action (we don't auto-delete).

## Known limitations

1. **Snapchat vs sleep-app screenshots**: the LLM treats both as "screenshot-like". In your review patterns:
   - **Snapchat screenshots** — you generally want kept (social memory value).
   - **Sleep-app dev screenshots** — you want culled (ephemeral work files).
   The prompt has category-specific nudges but can't reliably distinguish origin from pixels alone. Fixing this properly needs filename pattern rules or app-origin metadata. Today it's a recurring minor pain-point; not fatal to the auto-cull flow.
2. **Domain mismatch**: old scanned photos (e.g. the 2003 batch in grading) trigger the "kept fewer than ideal" mode — the prompt is tuned for personal family photos. Rare enough to leave alone.
3. **Face clustering quality**: face-coverage relies on Immich's named-person clusters. Untagged people get no protection. As you tag more people, coverage improves.
4. **Confidence self-reporting**: the LLM doesn't emit per-pick confidence today. Codex's advice is to skip it (poorly calibrated) and lean on deterministic guardrails like face-coverage instead. Kept as a future option if tail failures reappear.

## Current shipped defaults (2026-04-21)

- Production LLM: `gemini-3.1-flash-lite-preview` (~5s per batch, cloud, cheap).
- Prompt: v1 (`SYSTEM_PROMPT` in `src/ranking/prompt.ts`, 92 lines).
- Face-coverage post-check: **enabled** (named-only).
- Auto-cull tiers: HIGH and STANDARD both apply on explicit user approval.
- Multi-model consensus path: available but opt-in; most batches have a single model.
- Burst auto-cull: enabled (independent metadata-based path).

Measured on 80 graded batches: 97.5% acceptable-rate, zero severity-3/4 painful misses, Wilson 95% CI roughly 91–99%. Safe for auto-cull with light review on the remaining ~2%.
