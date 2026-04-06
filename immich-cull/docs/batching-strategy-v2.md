# Batching Strategy v2: Day/Trip Batches Instead of Similarity Groups

## Problem Statement

The current approach clusters photos by CLIP embedding similarity + time proximity into groups of 2-20, then sends each group to the LLM for comparative ranking. This has a fundamental coverage problem:

- **Singletons never get LLM treatment.** The clustering engine reports 60%+ of photos as singletons (photos that don't closely match anything else). These photos never receive star ratings, categories, or any LLM review.
- **The grouping unit is arbitrary.** Why should LLM access be gated by visual similarity? A unique landscape photo deserves a star rating just as much as the 5th-best photo in a burst of 12 selfies.
- **"Culling" only makes sense for similar photos**, but rating, categorizing, and flagging make sense for everything.

The insight: **similarity groups are a UI concern (showing comparable photos together), not an LLM batching concern.** The LLM should see ALL photos, batched by natural time boundaries.

---

## 1. Recommended Batching Strategy

### Primary batching unit: time-gap sessions

Batch photos into **sessions** — contiguous sequences of photos where the gap between consecutive shots is under a threshold. This naturally produces "day" or "trip" or "outing" sized chunks.

**Recommended gap threshold: 4 hours (adaptive)**

Rationale:
- A 4-hour gap cleanly separates morning/afternoon sessions, different outings on the same day, and multi-day trips with overnight gaps.
- Shorter gaps (1-2h) over-split: lunch breaks, charging pauses, and transit gaps would fragment a single outing.
- Longer gaps (8h+) under-split: an entire vacation day with multiple distinct activities becomes one unwieldy batch.
- The DSLR folder structure (e.g., `20030403-Munin`, `20201224-xmas-eve`) already represents exactly this concept. For DSLR photos with folder metadata, the folder IS the batch — no time-gap heuristic needed.

**Adaptive refinement:**
- For photos with DSLR-style folder paths (`YYYYMMDD-name`), use the folder as the batch boundary. This is the strongest signal available and avoids any heuristic.
- For phone photos in Immich's timeline (no folder structure), use the 4-hour gap.
- If a 4-hour-gap session exceeds 150 photos, sub-split at the largest internal gap that produces chunks of 50-150. This keeps LLM quality high without arbitrary fixed limits.

### Handling large batches

The Gemini context window (1M tokens) easily fits 300+ images at 256 tokens each (76,800 tokens). The question is not capacity but **quality**: can the LLM meaningfully rate 300 images in one pass?

**Evidence suggests diminishing quality above ~50-80 images for per-image star ratings.** The model must produce structured JSON with individual ratings and reasons for each image. At 300 images, the output alone is substantial, and attention to individual images likely degrades. This is analogous to how humans cannot meaningfully rank 300 items in one pass.

**Recommended batch size limits:**

| Batch size | Strategy |
|---|---|
| 1-80 photos | Single LLM call. Sweet spot for quality. |
| 81-150 photos | Single LLM call is acceptable but sub-splitting at natural gaps may improve quality. Monitor output quality in practice. |
| 150-300 photos | Sub-split at largest internal time gap into chunks of 50-150. |
| 300+ photos | Rare. Sub-split aggressively. These are likely multi-day vacations without overnight gaps in metadata. |

### How DSLR folders serve as natural batch boundaries

The user's ~58k DSLR photos are organized in folders like:
- `20030403-Munin` (a specific trip/event)
- `20201224-xmas-eve` (a specific occasion)
- `20210815-cabin` (a multi-day stay)

These folders ARE the batching unit. They represent the photographer's own mental grouping of "one session of shooting." The tool should detect DSLR folder patterns and use them directly:

```
if path matches /\d{8}-\w+/:
    batch = folder
else:
    batch = time-gap session (4h threshold)
```

This is simpler, more reliable, and more semantically meaningful than any time-gap heuristic for the DSLR portion of the library.

---

## 2. Two-Pass vs One-Pass

### Recommendation: One-pass with structured output that serves both needs

Do NOT separate "rating/categorization" from "cull ranking." Instead, send day-batches to the LLM with a prompt that asks for three things in a single call:

1. **Per-image assessment** (star rating, category, protection flags) — applies to ALL photos including singletons
2. **Similarity subgroup identification** — the LLM identifies clusters of similar/near-duplicate photos within the batch
3. **Within-subgroup ranking** — for each identified similarity cluster, rank the photos and recommend keep/cull

**Why one pass, not two:**

- **Cost efficiency.** Image tokens dominate cost. Sending the same images twice doubles the cost for marginal quality gain.
- **Context advantage.** When the LLM sees the entire day, it has better context for star ratings. A technically decent landscape photo that's the only landscape in a day of selfies deserves different treatment than a decent landscape among 20 landscape attempts.
- **Simplicity.** One pipeline, one set of stored results, one prompt to iterate. The user has ADD — two passes means two things to understand, configure, and debug.
- **The LLM can find similarity subgroups.** Modern multimodal LLMs are perfectly capable of identifying "these 5 photos are the same scene" within a batch. We don't need CLIP clustering to define groups for the LLM; CLIP clustering becomes a UI assist and a validation signal.

**When two passes might be warranted (future consideration):**

- If the single-pass output quality for cull ranking is measurably worse than a dedicated similarity-group pass (test this empirically after v1).
- For groups of 150+ photos where the single pass may degrade. In that case: Pass 1 for star ratings + categories on the full batch, Pass 2 for detailed cull ranking on LLM-identified or CLIP-identified similarity subgroups only.

### The one-pass output structure

```ts
interface DayBatchResponse {
  batchId: string;
  batchSize: number;
  dateRange: string;
  batchSummary: string;           // "Christmas Eve 2020 — family dinner, gift opening, kids playing"
  overallConfidence: number;

  // Every photo gets these (the singleton problem is solved)
  images: ImageAssessment[];

  // LLM-identified similarity subgroups within this batch
  similaritySubgroups: SimilaritySubgroup[];
}

interface ImageAssessment {
  imageId: string;
  suggestedStars: 0 | 1 | 2 | 3;
  categories: LlmCategory[];
  protectFromCull: boolean;
  protectionReason: ProtectionReason;
  briefNote: string;              // "Sharp portrait, good expression" — short, for UI hover
  similaritySubgroupId: string | null;  // null = singleton, unique photo
}

interface SimilaritySubgroup {
  subgroupId: string;
  imageIds: string[];             // ordered by rank (best first)
  subgroupType: "burst" | "near_duplicate" | "same_scene" | "same_subject";
  recommendedKeepCount: number;
  recommendedKeepIds: string[];
  cullIds: string[];
  rationale: string;
  confidence: number;
}
```

This cleanly separates the two concerns:
- **ImageAssessment**: every photo gets rated and categorized (no more singleton gap)
- **SimilaritySubgroup**: similar photos get comparative ranking and cull recommendations (the existing workflow's strength)

---

## 3. Prompt Redesign

### Current prompt (similarity-group focused)

The current prompt says: *"You are ranking a small group of visually similar photos for a photo culling workflow."* It assumes the input is a pre-clustered set of similar images and asks for a strict ranking.

### New prompt (day-batch focused)

The prompt must shift from "rank these similar photos" to "review this session of photos." Here is a draft template:

```text
System:
You are reviewing a batch of photos from a single photography session (one day, trip, or outing).

Your job is to:
1. Assess EVERY photo individually — suggest a star rating and category.
2. Identify groups of similar or near-duplicate photos within the batch.
3. For each similarity group, rank the photos and recommend which to keep vs cull.

Star rating scale (0-3, you never assign 4 or 5):
- 0★: Processed, unremarkable. Generic, redundant, or purely functional.
- 1★: Good photo. Would pick this one out when scrolling. Nice moment, light, composition, or useful reference.
- 2★: Share-worthy. Genuinely good, would show to someone.
- 3★: Session highlight. Best photo(s) of this batch. Would feature in a trip recap.

Important rules:
- Assess EVERY image. Do not skip any.
- For star ratings, judge relative to this session/batch. Every batch should have a distribution — not all 0★, not all 2★.
- Existing star ratings of 2★+ are protected: never suggest lower than the existing rating.
- Technical/documentation images, receipts, screenshots: judge by usefulness, not beauty.
- Snapchat saves or partner-shared personal content: protect if meaningful, even if quality is low.
- When identifying similarity subgroups, be inclusive: if 3+ photos look like the same scene/moment/subject, group them.
- Within similarity subgroups, rank by: sharpness, expression, composition, timing, uniqueness of moment.
- Recommend keeping extras when photos capture genuinely different moments or angles.
- The user's philosophy: "Keeping a few extra isn't high cost. This is mostly about culling what we never will need anyway." Be conservative — only recommend culling when the image is clearly redundant given what's being kept.
- Return valid JSON only, matching the provided schema exactly.

User:
Session metadata:
{
  "batchId": "{{batchId}}",
  "batchSize": {{batchSize}},
  "dateRange": "{{dateRange}}",
  "folderName": "{{folderName}}",  // e.g. "20201224-xmas-eve" or null for phone photos
  "contextHints": {{contextHintsJson}}
}

Images in chronological order:
{{imagesMetadataJson}}

Now review the attached images and return JSON matching the schema.
```

### Key prompt differences from v1

| Aspect | v1 (similarity-group) | v2 (day-batch) |
|---|---|---|
| Input framing | "visually similar photos" | "photos from a single session" |
| Primary task | Strict ranking of similar photos | Individual assessment + similarity detection |
| Singletons | Never seen by LLM | Always assessed |
| Star ratings | Suggested as secondary output | Primary output for every photo |
| Similarity groups | Pre-computed, LLM validates | LLM identifies from scratch |
| Cull recommendations | Main output | Output for LLM-identified subgroups only |
| Batch size | 2-20 | 10-150 |
| Context available | Only similar photos | Full session context |

### Prompt sizing at different batch sizes

| Batch size | Image tokens | Prompt + schema text | Output estimate | Total tokens |
|---|---|---|---|---|
| 20 photos | 5,120 | ~2,000 | ~3,000 | ~10,000 |
| 50 photos | 12,800 | ~2,000 | ~7,000 | ~22,000 |
| 100 photos | 25,600 | ~2,000 | ~14,000 | ~42,000 |
| 150 photos | 38,400 | ~2,000 | ~21,000 | ~61,000 |

All well within the 1M token context. Output token costs are higher per-token than input, but the absolute amounts are modest.

---

## 4. Cost Analysis

### Gemini 2.5 Flash Lite pricing

- Input: $0.10 / 1M tokens
- Output: $0.40 / 1M tokens (estimated for structured JSON)
- Image: 256 tokens/image (input)

### Day-batch approach: 100k photos

**Estimating batch count:**

Assume 100k photos produce roughly 2,000-3,000 day-batches (average 33-50 photos per batch). This is a reasonable estimate: some days have 1-3 photos (phone shots), others have 200+ (events/trips).

Conservative estimate using 2,500 batches at 40 photos average:

| Component | Calculation | Cost |
|---|---|---|
| Image input tokens | 100,000 photos * 256 tokens | 25,600,000 tokens |
| Prompt text input | 2,500 batches * 2,000 tokens | 5,000,000 tokens |
| Total input | | 30,600,000 tokens |
| Input cost | 30.6M / 1M * $0.10 | **$3.06** |
| Output tokens | ~140 tokens/photo * 100k | 14,000,000 tokens |
| Output cost | 14M / 1M * $0.40 | **$5.60** |
| **Total** | | **$8.66** |

### Current similarity-group approach: comparison

The v1 plan estimated ~5,000 groups covering ~20,000 photos (the 40% that are in groups of 2+). The remaining 60% (singletons) were unprocessed.

| Component | Calculation | Cost |
|---|---|---|
| Image input tokens | 20,000 photos * 256 tokens | 5,120,000 tokens |
| Prompt text input | 5,000 groups * 1,500 tokens | 7,500,000 tokens |
| Total input | | 12,620,000 tokens |
| Input cost | 12.62M / 1M * $0.10 | **$1.26** |
| Output tokens | ~300 tokens/group * 5,000 | 1,500,000 tokens |
| Output cost | 1.5M / 1M * $0.40 | **$0.60** |
| **Total for 40% of library** | | **$1.86** |
| **Projected if covering 100%** | ~$4.65 (extrapolated) | |

### Cost comparison summary

| Approach | Photos covered | Total cost (100k library) | Cost per photo |
|---|---|---|---|
| v1: similarity groups only | ~40% (20k) | ~$1.86 | $0.000093 |
| v1 + singleton pass (Phase 5a) | ~100% (100k) | ~$4.65 (estimated) | $0.0000465 |
| **v2: day-batches** | **100% (100k)** | **~$8.66** | **$0.0000866** |

The day-batch approach costs roughly **$8.66 for the entire 100k library** — about $4-7 more than v1. This is well within the stated budget of $15 for development iteration. In production, this is a one-time cost (with caching for unchanged photos).

**The marginal cost of covering singletons is essentially zero.** The cost increase comes from richer per-image output (every photo gets a star rating + category + note), not from the batching change itself.

### Budget for iteration

At ~$9 per full-library pass, the $15 development budget allows:
- 1 full production run
- Multiple partial runs on sample batches (10-50 batches at ~$0.03 each)
- A/B prompt comparison on benchmark groups

This is comfortably affordable.

---

## 5. Calibration Analysis: 143 Manual Decisions

### Raw data from state.db

All 143 decisions were non-skipped (skipped=0), covering 540 total photos.

| Metric | Value |
|---|---|
| Total decisions | 143 |
| Total photos reviewed | 540 |
| Total kept | 260 (48.1%) |
| Total culled | 280 (51.9%) |
| Average group size | 3.78 |
| Average kept per group | 1.82 |
| Average culled per group | 1.96 |

### Decision type distribution

| Type | Count | % |
|---|---|---|
| Balanced (25-75% keep rate) | 104 | 72.7% |
| Keep All (0% culled) | 17 | 11.9% |
| Cull All (0% kept) | 11 | 7.7% |
| Cull Most (<25% kept) | 10 | 7.0% |
| Keep Most (>75% kept) | 1 | 0.7% |

### Keep rate distribution (histogram)

| Keep % range | Count |
|---|---|
| 0% (cull all) | 11 |
| 1-25% | 10 |
| 26-50% | 88 |
| 51-75% | 17 |
| 100% (keep all) | 17 |

**The dominant pattern is keeping 26-50% of photos in a group.** 88 out of 143 decisions (61.5%) fell in this range.

### Breakdown by group size

| Group size | Decisions | Keep-all | Avg cull ratio | Notes |
|---|---|---|---|---|
| 2 (pairs) | 74 | 10 (13.5%) | 50.7% | The bulk of decisions. |
| 3 (triples) | 27 | 2 (7.4%) | 48.1% | |
| 4 | 12 | 2 (16.7%) | 47.9% | |
| 5 | 6 | 2 (33.3%) | 40.0% | |
| 6-8 | 11 | 0 | 55.8% | Larger groups = more culling |
| 9-12 | 7 | 0 | 61.4% | Significantly more aggressive culling |
| 13-17 | 5 | 1 | 51.9% | The one keep-all was a 15-photo group |

### Pair decisions (group_size=2): detailed

Pairs are 51.7% of all decisions (74/143), so they dominate.

| Decision | Count | % |
|---|---|---|
| Keep 1, cull 1 | 53 | 71.6% |
| Keep both | 10 | 13.5% |
| Cull both | 11 | 14.9% |

For pairs, the user **most often picks one and culls one** (71.6%). But 13.5% of the time, both photos are worth keeping (different enough), and 14.9% of the time, both are cull-worthy.

### Triple decisions (group_size=3): detailed

| Decision | Count | % |
|---|---|---|
| Keep 1, cull 2 | 14 | 51.9% |
| Keep 2, cull 1 | 11 | 40.7% |
| Keep all 3 | 2 | 7.4% |
| Cull all 3 | 0 | 0% |

For triples, the user keeps 1-2 photos and culls the rest. Never culls all three.

### Timing analysis

All 143 decisions were made in a single session on 2026-04-06, from 20:54 to 21:53 (59 minutes). The user started with larger groups (8-17 photos) and moved to smaller groups (mostly pairs by the end), consistent with the groups being sorted by size descending.

Decision speed accelerated dramatically toward the end: the last 40+ pair decisions came at 2-4 second intervals, suggesting the user was making rapid, confident choices on obvious pairs.

### Key insights for LLM calibration

1. **The user is a moderate culler, not aggressive.** Overall keep rate is 48.1%. The LLM should NOT be aggressive about culling.

2. **"Keep a few extra" is confirmed behavior.** In larger groups (5+), the user often keeps 2-3 images even when one would suffice technically. The LLM should recommend keeping 2+ when photos capture different moments/angles.

3. **Cull-all is rare (7.7%) and only happens in pairs.** All 11 cull-all decisions were on pairs. The user never culled all photos in groups of 3+. The LLM should almost never recommend culling an entire group of 3+.

4. **Keep-all is real (11.9%).** Not rare, especially for pairs (13.5%) and 5-photo groups (33.3%). The LLM must be comfortable recommending "keep all" when photos are genuinely distinct.

5. **Larger groups get culled more aggressively.** Groups of 6+ have 55-65% cull rates, vs ~50% for pairs/triples. This makes sense: more redundancy in larger bursts. The LLM's recommended keep count should scale sub-linearly with group size.

6. **The user is fast and decisive.** 143 decisions in 59 minutes (2.4 per minute average, much faster for pairs). This means the auto-approve workflow is critical: the user will not tolerate reviewing thousands of groups manually.

7. **For pairs, the right default is "keep 1."** 71.6% of pair decisions kept exactly one. This is a strong prior for LLM recommendations.

8. **Recommended auto-approve threshold mapping:**
   - Pair where one is clearly sharper/better: auto-approve keep-1 (71.6% base rate)
   - Pair where both are distinct: auto-approve keep-both (13.5%)
   - Pair where both are bad: flag for review (14.9% — too risky to auto-cull-all)
   - Triples: auto-approve keep-1 or keep-2 (92.6% base rate), flag cull-all
   - Groups 4+: auto-approve conservative keep count, flag for review if confidence is low

---

## 6. How Similarity Groups Fit In

### Similarity groups are demoted from "LLM batching unit" to "UI assist"

The CLIP-based similarity clustering is NOT wasted. It shifts roles:

| Role | v1 (current) | v2 (proposed) |
|---|---|---|
| LLM batching unit | Similarity group (2-20 photos) | Day/trip session (10-150 photos) |
| LLM ranking scope | Within similarity group | Within LLM-identified subgroups |
| UI grouping for review | Similarity group | Day-batch, with similarity subgroups shown together |
| Cull recommendation scope | Similarity group = cull scope | LLM-identified subgroup = cull scope |
| Singleton coverage | None | Full (every photo assessed) |
| CLIP's role | Define what the LLM sees | Validate LLM's subgroup detection, assist UI layout |

### Concrete uses for CLIP similarity in v2

1. **UI layout within a day-batch review.** When the user reviews a 50-photo day-batch, show similar photos adjacent. This uses CLIP embeddings to sort/cluster the grid, making it easy to compare similar shots. The LLM doesn't need to see them grouped — the user does.

2. **Validation of LLM subgroup detection.** After the LLM identifies similarity subgroups, cross-check against CLIP clusters. If the LLM says photos A, B, C are similar but CLIP says A is distant from B/C, flag for human review. If CLIP finds a cluster the LLM missed, surface it.

3. **Pre-computed UI hints.** CLIP clustering is fast and local. Compute it once, store it, and use it for instant UI grouping without waiting for LLM results. The LLM results then enrich the CLIP-based layout with ratings and cull recommendations.

4. **Fallback for LLM failures.** If a day-batch's LLM call fails, the existing CLIP-based similarity groups still provide a usable review experience — just without star ratings and categories.

5. **Cost optimization (future).** If day-batch LLM calls prove expensive for very large libraries, CLIP similarity could be used to identify "obvious duplicate" pairs that can be auto-culled without LLM review, reducing the number of photos the LLM needs to assess.

### What changes in the codebase

The existing clustering engine (`src/clustering/engine.ts`) is kept intact. It continues to produce similarity groups for the UI. The new addition is a **session batcher** that:

1. Sorts all photos by timestamp
2. Splits at 4-hour gaps (or folder boundaries for DSLR)
3. Sub-splits sessions exceeding 150 photos
4. Sends each session to the LLM as a day-batch
5. Maps LLM-identified subgroups back to the UI's CLIP-based similarity view

The session batcher is simpler than the similarity clusterer — it's just a sorted scan with gap detection.

---

## Implementation Recommendation

### Minimal viable change

1. Add a `SessionBatcher` that groups photos by time gaps / DSLR folders.
2. Write a new prompt template for day-batch review (the one in Section 3).
3. Send day-batches to Gemini, parse the response into `ImageAssessment` + `SimilaritySubgroup`.
4. Store results in SQLite (extend existing schema with batch-level tables).
5. In the UI, overlay LLM assessments onto the existing CLIP-grouped review grid.
6. Every photo now has a star rating and category, regardless of whether it's in a similarity group.

### What NOT to change

- The clustering engine. It still produces useful UI groupings.
- The review UI's grid layout. Just populate it with LLM data from day-batches instead of (or in addition to) per-group LLM calls.
- The decision persistence (state.db). Keep/cull decisions remain per-similarity-group in the UI.
- The existing 143 calibration decisions. These remain valid as training data for the LLM's within-subgroup ranking quality.

### Migration path

The day-batch approach is a superset of the similarity-group approach:
- Day-batches produce per-image assessments (new capability)
- Day-batches also produce similarity subgroup rankings (existing capability, now LLM-identified)
- The UI can show both: day-level context + within-group comparisons

This means v2 does not invalidate v1 — it extends it to cover 100% of photos.
