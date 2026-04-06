# immich-cull LLM Integration Plan

## 1. Recommended Approach

### Summary

Use **one LLM call per group with all images in the group**, not an 8-image cap and not tournament reduction by default.

The current grouping system already limits groups to **2-20 similar photos**. That is small enough to fit comfortably inside Gemini Flash Lite context, and ranking quality is materially better when the model sees the **entire local decision set at once**.

### Why full-group calls are the right default

1. **Ranking is relative, not absolute**
   - A photo that looks strong in a chunk of 6 may only be the 5th-best image in the full 17-image group.
   - Tournament reduction introduces bracket artifacts: a good image can be eliminated early because it happened to land in a strong chunk.

2. **The group size ceiling is already low**
   - With a max group size of 20, the problem is not a context-window problem.
   - 20 images is trivial for Gemini’s 1M-token context window.

3. **Image tokens dominate cost, not text**
   - Since image tokens are the expensive part, prompt verbosity and richer structured output barely move cost.
   - Once paying to send images, it is usually worth extracting more useful structure in the same call.

4. **The plus/minus UX depends on global ordering**
   - The UI wants “keep top 1”, “keep top 2”, “keep top 3”.
   - That requires a stable ranking across the entire group, not winners from multiple partial comparisons.

5. **Mixed-content groups need comparative context**
   - Some groups will contain portrait variants, technical documentation variants, or screenshot variants.
   - The model needs the whole set to decide whether images are duplicates, complementary, or independently worth keeping.

### Default policy

- For groups of **2-20** images: send **all images** in one call.
- Do not chunk by default.
- Do not do tournament reduction unless a future grouping algorithm allows groups much larger than 20.

### Cost analysis

Using the provided grounding assumptions:

- **Gemini 2.5 Flash Lite**
  - Cost: `$0.10 / 1M input tokens`
  - Image cost: `256 tokens/image`
  - 20-image group: `20 * 256 = 5120 tokens`
  - Cost per 20-image group: `5120 / 1,000,000 * $0.10 = $0.000512`
  - 5000 groups: about **$2.56**

- **Gemini 3.1 Flash Lite**
  - Cost: `$0.25 / 1M input tokens`
  - Image cost: `1120 tokens/image`
  - 20-image group: `20 * 1120 = 22400 tokens`
  - Cost per 20-image group: `22400 / 1,000,000 * $0.25 = $0.0056`
  - 5000 groups: about **$28.00**

### Cost comparison: full-group vs 8-image limit

The old plan’s 8-image cap appears cheaper per call, but it does not solve the actual ranking problem for groups larger than 8. Once you add tournament or multi-round logic, the savings shrink while quality drops.

Example for a 20-image group:

- **Full-group, Gemini 2.5**: 1 call, `5120` image tokens, `$0.000512`
- **Chunked 8-image tournament**:
  - Round 1: `8 + 8 + 4 = 20` images sent
  - Round 2 final: typically another `4-8` images sent
  - Total image tokens: roughly `24-28` image-equivalents
  - Cost becomes similar to or worse than a single full-group call
  - Quality is worse because earlier chunking decisions discard context

So the right optimization target is **call reuse and caching**, not artificial image limits.

### Model recommendation

Use **Gemini 2.5 Flash Lite** as the default production model for ranking.

Why:

- Much lower image-token cost
- Sufficient context for 20-image groups
- Structured JSON mode is supported
- The task is comparative ranking, not long-form reasoning

Use **Gemini 3.1 Flash Lite** only as an explicit fallback or evaluation model when:

- a prompt revision needs validation,
- a group type is consistently misranked,
- or the user wants to compare model behavior on a sample set.

### Call strategy

- Generate preview JPEGs at a fixed review size before upload.
- Send all images in deterministic order with stable IDs.
- Ask for:
  - full ranking,
  - keep tiers for different retention levels,
  - category tags,
  - confidence signals,
  - pairwise/group-level rationale,
  - and “do not cull” flags for special cases.

### Failure policy

- If the LLM call fails or returns invalid schema:
  - mark the group as `llm_status = failed`,
  - keep the review flow usable,
  - fall back to default sort order without auto-suggestions.

- If a group is visually heterogeneous or the model expresses low confidence:
  - still store the ranking,
  - but weaken auto-application and present it as a soft suggestion.

## 2. Prompt Design

### Design goals

The prompt should:

- rank the whole group, not score each image independently,
- distinguish “best overall” from “additional keepers,”
- support the plus/minus slider directly,
- respect existing star ratings and protected assets,
- identify special categories such as screenshots, documents, technical photos, and partner-origin Snapchat saves,
- and return machine-usable JSON with no prose outside schema.

### Input contract to the model

Each request should include:

- Group metadata
  - `groupId`
  - `groupSize`
  - `captureTimeRange`
  - optional album/folder/path hints
- Per-image metadata
  - `imageId`
  - `index`
  - `existingStars`
  - `isScreenshotHint`
  - `isSnapchatHint`
  - `filename`
  - `timestamp`
  - optional camera/path hints
- Image payloads
  - preview JPEGs in the same order as metadata

### Prompt template

```text
System:
You are ranking a small group of visually similar photos for a photo culling workflow.

Your job is not to judge each image in isolation. Your job is to compare all images in the group and produce:
1. a strict best-to-worst ranking across the whole group,
2. recommended keep sets for keeping the top 1, top 2, top 3, and top 4 images when applicable,
3. concise reasons focused on comparative differences,
4. category tags and protection flags for special content types.

Important rules:
- Treat this as a relative ranking within this group only.
- Prefer sharp, well-timed, expressive, cleanly composed photos.
- Penalize blur, missed focus, closed eyes, awkward expressions, redundant near-duplicates, accidental shots, and poor framing.
- If multiple images are worth keeping because they capture genuinely different moments, angles, expressions, or informational value, say so.
- Technical/documentation images, receipts, screenshots, and similar utility photos should be judged by informational usefulness and legibility, not artistic standards.
- Snapchat or screenshot images from a partner or family member may still be worth keeping even if image quality is low, if the content is personally meaningful.
- Existing star ratings are protected metadata:
  - never imply that an image with existingStars >= 3 should be culled,
  - never recommend a lower final star rating than existingStars,
  - if a protected image is not visually strong, explain that it should be kept because of existing rating protection.
- Return valid JSON only, matching the provided schema exactly.
- Do not omit any input image.
- Every image must have a unique final rank from 1 to N.

User:
Group metadata:
{
  "groupId": "{{groupId}}",
  "groupSize": {{groupSize}},
  "captureTimeRange": "{{captureTimeRange}}",
  "contextHints": {{contextHintsJson}}
}

Images in order:
{{imagesMetadataJson}}

Interpretation guidance:
- "keepTop1" means only the single strongest image should be kept.
- "keepTop2" means the two strongest images to keep if the user wants two.
- "keepTop3" and "keepTop4" follow the same rule.
- Include an image in higher keep counts only if it adds real value versus stronger images.
- Mark "isNearDuplicate" true when an image is redundant if stronger images are kept.
- Mark "protectFromCull" true for images that should not be auto-culled because of existing stars or meaningful utility/personal value.
- Use confidence values from 0 to 1.

Now rank the attached images and return JSON.
```

### Prompt notes

- The prompt should be paired with a strict `response_schema`, not plain JSON text parsing.
- Comparative language is intentional; it reduces generic “nice composition” filler.
- The “protectFromCull” instruction is important because “keep” and “never auto-cull” are not the same concept.
- The prompt should not ask for long chain-of-thought. Keep reasons short and outcome-focused.

## 3. Output Schema

### JSON structure

The LLM should return one group-level object with:

- model metadata,
- group-level interpretation,
- ranked items,
- keep sets for slider positions,
- category summary,
- confidence summary,
- and warnings/edge cases.

### TypeScript types

```ts
export type LlmModelName =
  | "gemini-2.5-flash-lite"
  | "gemini-3.1-flash-lite";

export type LlmCategory =
  | "portrait"
  | "group_portrait"
  | "selfie"
  | "landscape"
  | "travel"
  | "pet"
  | "action"
  | "event"
  | "document"
  | "receipt"
  | "whiteboard"
  | "screenshot"
  | "snapchat_save"
  | "technical_construction"
  | "vehicle"
  | "food"
  | "meme"
  | "other";

export type ProtectionReason =
  | "existing_star_protection"
  | "personal_memory"
  | "utility_reference"
  | "partner_shared_image"
  | "distinct_moment"
  | "no_special_protection";

export interface LlmGroupResponse {
  schemaVersion: "1.0";
  promptVersion: string;
  model: LlmModelName;
  groupId: string;
  groupSize: number;
  overallConfidence: number;
  rankingQuality: "high" | "medium" | "low";
  groupCoherence: "coherent" | "mixed" | "unrelated"; // flags bad clustering
  groupSummary: string;
  primaryCategories: LlmCategory[];
  warnings: string[];
  keepSets: KeepSets;
  images: RankedImage[];
}

export interface KeepSets {
  keepTop1: string[]; // may be empty if no keeper exists (cullAll case)
  keepTop2: string[];
  keepTop3: string[];
  keepTop4: string[];
  cullAll: boolean; // true if no image in the group is worth keeping
  recommendedDefaultKeepCount: number; // 0 = cull all
  recommendedDefaultKeepIds: string[];
  rationale: string;
}

export interface RankedImage {
  imageId: string;
  rank: number;
  confidence: number;
  keepTier: "primary" | "secondary" | "backup" | "cull";
  isNearDuplicate: boolean;
  protectFromCull: boolean;
  protectionReason: ProtectionReason;
  existingStars: number;
  suggestedStars: 0 | 1 | 2 | 3; // 0=unremarkable, 1=good, 2=share-worthy, 3=standout. Never 4/5.
  categories: LlmCategory[];
  comparativeReason: string; // captures sharpness, expression, framing etc. in natural language
}

// NOTE: TechnicalFlags dropped from v1 per adversarial review.
// The LLM gets sharpness/eye detection wrong often enough that comparativeReason
// is more reliable. Can be added back in Phase 6 after validating model accuracy.

// NOTE: shouldKeepIfTopN booleans dropped — redundant with KeepSets arrays.
// Derive in application code if needed.

// NOTE: score field dropped — not calibrated across groups, rank is sufficient.
```

### Output semantics

- `rank` is strict and complete across all images.
- `score` is only for ordering and threshold tuning; it must not be treated as globally calibrated across groups.
- `keepTier` is a coarse recommendation:
  - `primary`: clear keep
  - `secondary`: worth keeping when user wants more than the minimum
  - `backup`: only keep if user prefers higher retention
  - `cull`: redundant or weak within this group
- `protectFromCull` means “never auto-trash this image without user approval.”
- `suggestedStars` is a local suggestion before policy mapping is applied.

### Example JSON

```json
{
  "schemaVersion": "1.0",
  "promptVersion": "rank-v3",
  "model": "gemini-2.5-flash-lite",
  "groupId": "grp_2024_07_14_001",
  "groupSize": 5,
  "overallConfidence": 0.88,
  "rankingQuality": "high",
  "groupSummary": "Five near-duplicate outdoor portraits; image 3 is the strongest, image 1 is a useful alternate, the rest are redundant.",
  "primaryCategories": ["portrait"],
  "warnings": [],
  "keepSets": {
    "keepTop1": ["img_3"],
    "keepTop2": ["img_3", "img_1"],
    "keepTop3": ["img_3", "img_1", "img_5"],
    "keepTop4": ["img_3", "img_1", "img_5", "img_2"],
    "recommendedDefaultKeepCount": 2,
    "recommendedDefaultKeepIds": ["img_3", "img_1"],
    "rationale": "The top two images are meaningfully distinct; additional images are weaker alternates."
  },
  "images": [
    {
      "imageId": "img_3",
      "rank": 1,
      "score": 0.96,
      "confidence": 0.92,
      "keepTier": "primary",
      "shouldKeepIfTop1": true,
      "shouldKeepIfTop2": true,
      "shouldKeepIfTop3": true,
      "shouldKeepIfTop4": true,
      "isNearDuplicate": false,
      "protectFromCull": false,
      "protectionReason": "no_special_protection",
      "existingStars": 0,
      "suggestedStars": 3,
      "categories": ["portrait"],
      "technicalFlags": {
        "sharpness": "high",
        "eyesOpen": "yes",
        "motionBlur": "none",
        "framing": "strong",
        "exposure": "good"
      },
      "comparativeReason": "Best expression and sharpest focus in the group."
    }
  ]
}
```

## 4. Star Rating Strategy

**See also: [STAR_RATING_PHILOSOPHY.md](STAR_RATING_PHILOSOPHY.md) for the full revised scale.**

### Revised scale (2026-04-06)

- `0★` = processed, unremarkable. “Keep” but no distinction.
- `1★` = good photo. Stands out from the group.
- `2★` = share-worthy. Would show someone interested.
- `3★` = best-of-trip/roll. Local standout.
- `4★` = print-worthy. Cross-library standout. (Not assigned by LLM.)
- `5★` = best of the best. (Not assigned by LLM.)

### Key change: 0★ is valid, 1★ means something

The old system used 1★ as “not deleted.” The new system reclaims it.
This means the LLM can meaningfully distinguish between “keep” (0★) and “good” (1★).

### Handling existing 1★ ratings

Existing 1★ is ambiguous — it may mean “not deleted” (old system) or “genuinely good” (new system).

**Heuristic**: check what percentage of photos in the same folder/roll are rated 1★+.
- If ≥80% are rated 1★+: the old 1★ meant “not deleted” → treat as 0★ equivalent, LLM may re-evaluate
- If <80% are rated: the 1★ was selective → treat as soft floor

### Guiding principles

1. **2★+ existing ratings are a hard floor** — never auto-downgrade
2. **1★ existing ratings are a soft floor** — may be reconsidered based on folder context
3. **LLM should not assign 4★ or 5★** — those require cross-library curation
4. **Rank alone is insufficient** — use category, confidence, keep tier, and protection flags
5. **Utility images can be protected without being highly starred** — “keep” ≠ “rate highly”

### Policy mapping

The LLM suggests stars per image. The application applies a policy layer:

```
finalStars = policyApply(llmSuggestedStars, existingStars, folderContext)
```

#### Existing rating rules

| Existing | Rule |
|---|---|
| 2★+ | Hard floor. Never auto-downgrade. |
| 1★ in folder with ≥80% rated | Old “not deleted” signal. LLM may re-evaluate freely. |
| 1★ in folder with <80% rated | Soft floor. LLM suggestion wins if higher, preserves if lower. |
| 0★ / unrated | LLM suggestion applies directly. |

#### Category-specific defaults

| Category | Default star range | Notes |
|---|---|---|
| Portrait, landscape, travel, event | 0-3★ | Full range, aesthetic standards |
| Document, receipt, whiteboard | 0-1★ | Legibility matters, not beauty. 2★ only if exceptionally useful. |
| Screenshot, snapchat_save | 0-2★ | Personal value, not quality. Protect if meaningful. |
| Technical/construction | 0-1★ | Reference value. Keep multiple angles. |

#### When to assign 3★

Require ALL of: rank=1, keepTier=primary, confidence≥0.85, sharpness=high, 
non-utility category, and the group summary says “standout” not “least bad.”

#### 4★ and 5★

Never assigned by the per-group LLM pass. These require cross-library curation:
- 4★: review top 3★ candidates across months/years
- 5★: manual only

## 5. Storage Schema

### Goals

Persist LLM data so the system can:

- reuse results across UI sessions,
- avoid re-paying for unchanged groups,
- compare prompt/model versions,
- audit why a recommendation was made,
- learn from user overrides,
- and backfill improved policies without re-calling the model.

### Storage principles

1. Store the **raw response JSON** for reproducibility.
2. Store enough normalized fields for fast querying.
3. Version by:
   - group fingerprint,
   - prompt version,
   - model,
   - preview generation version,
   - schema version.
4. Treat each call as immutable history.
5. Track which response is currently active for a group.

### Group fingerprinting

Create a deterministic `group_fingerprint` from the exact set of assets and ranking-relevant metadata.

Recommended inputs:

- sorted asset IDs in the group,
- preview generation version,
- grouping version,
- image order sent to the model,
- key metadata used in prompt:
  - existing stars,
  - screenshot hints,
  - Snapchat/path hints.

If any of these change, the old response should no longer be considered cache-valid.

### SQLite schema

```sql
CREATE TABLE llm_group_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  group_fingerprint TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model TEXT NOT NULL,
  preview_version TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  response_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  error_message TEXT,
  input_image_count INTEGER NOT NULL,
  input_token_estimate INTEGER,
  output_token_estimate INTEGER,
  cost_usd_estimate REAL,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_llm_group_runs_lookup
  ON llm_group_runs (group_id, group_fingerprint, prompt_version, model, preview_version, status);

CREATE TABLE llm_group_active (
  group_id TEXT PRIMARY KEY,
  llm_group_run_id INTEGER NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (llm_group_run_id) REFERENCES llm_group_runs(id)
);

CREATE TABLE llm_image_rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  llm_group_run_id INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  confidence REAL NOT NULL,
  keep_tier TEXT NOT NULL,
  should_keep_top1 INTEGER NOT NULL,
  should_keep_top2 INTEGER NOT NULL,
  should_keep_top3 INTEGER NOT NULL,
  should_keep_top4 INTEGER NOT NULL,
  is_near_duplicate INTEGER NOT NULL,
  protect_from_cull INTEGER NOT NULL,
  protection_reason TEXT NOT NULL,
  existing_stars INTEGER NOT NULL,
  suggested_stars INTEGER NOT NULL,
  comparative_reason TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  technical_flags_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (llm_group_run_id) REFERENCES llm_group_runs(id)
);

CREATE INDEX idx_llm_image_rankings_group_rank
  ON llm_image_rankings (group_id, llm_group_run_id, rank);

CREATE INDEX idx_llm_image_rankings_image
  ON llm_image_rankings (image_id, llm_group_run_id);

CREATE TABLE llm_keep_sets (
  llm_group_run_id INTEGER PRIMARY KEY,
  keep_top1_json TEXT NOT NULL,
  keep_top2_json TEXT NOT NULL,
  keep_top3_json TEXT NOT NULL,
  keep_top4_json TEXT NOT NULL,
  recommended_default_keep_count INTEGER NOT NULL,
  recommended_default_keep_ids_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  FOREIGN KEY (llm_group_run_id) REFERENCES llm_group_runs(id)
);

CREATE TABLE llm_user_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  llm_group_run_id INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  feedback_type TEXT NOT NULL CHECK (
    feedback_type IN (
      'accepted_keep',
      'accepted_cull',
      'promoted_keep',
      'demoted_keep',
      'changed_star',
      'protected_override'
    )
  ),
  previous_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (llm_group_run_id) REFERENCES llm_group_runs(id)
);
```

### Cache reuse logic

Reuse an old response only if all of the following match:

- `group_fingerprint`
- `prompt_version`
- `model`
- `preview_version`
- `schema_version`
- `status = completed`

Otherwise queue a fresh call.

### Why both raw and normalized storage matter

- `response_json` preserves the exact model output for debugging and future parser changes.
- normalized ranking rows make it easy to:
  - render the review UI fast,
  - filter groups by confidence,
  - evaluate prompt versions,
  - compute override statistics.

## 6. Plus/Minus Slider

### UX goal

The slider should not manipulate stars directly. It should manipulate **how many top-ranked images in the group are preselected to keep**.

That means:

- `keep 1` = keep only the strongest image(s) from `keepTop1`
- `keep 2` = keep `keepTop2`
- `keep 3` = keep `keepTop3`
- `keep 4` = keep `keepTop4`

### Why the schema supports this cleanly

The LLM returns:

- strict ranking,
- boolean membership for each top-N tier,
- and explicit keep sets.

This avoids recomputing policy in the UI and keeps the control deterministic.

### Recommended slider behavior

- Slider positions:
  - `Auto`
  - `Keep 1`
  - `Keep 2`
  - `Keep 3`
  - `Keep 4`
  - `Keep All`

- Default slider value:
  - `recommendedDefaultKeepCount` from the LLM response
  - capped by group size

- `Auto` means:
  - use `recommendedDefaultKeepIds`
  - if response confidence is low, default to a more conservative retention count

### Example 1: burst portraits

Group of 8 similar portraits:

- `keepTop1 = [A]`
- `keepTop2 = [A, C]`
- `keepTop3 = [A, C, D]`
- `keepTop4 = [A, C, D, F]`

Meaning:

- `Keep 1`: only `A`
- `Keep 2`: `A, C`
- `Keep 3`: `A, C, D`
- `Keep 4`: `A, C, D, F`

The cull state for all others updates immediately.

### Example 2: documentation set

Group of 6 construction photos where 3 angles show different useful details:

- `keepTop1 = [B]`
- `keepTop2 = [B, E]`
- `keepTop3 = [B, E, A]`
- `recommendedDefaultKeepCount = 3`

This is important: the slider is not saying “best art photos.” It is saying “best set for the user’s likely retention preference.” For utility groups, more than one image may be appropriate.

### Example 3: protected images

If one image has existing `3★` but is only rank 4:

- it may not appear in `keepTop1`,
- but it should still be `protectFromCull = true`.

UI implication:

- If slider logic would mark it as cull, the system should instead show a protected state such as:
  - `Protected`
  - or `Keep (rating-protected)`

That preserves the user’s rating rules.

### Implementation rule

The slider controls only **auto-selection**. The user can always manually override per image.

Recommended application order:

1. Start from `keepTopN`
2. Add any `protectFromCull` images
3. Apply user overrides already stored for that session/group

That gives deterministic behavior without violating prior user intent.

## 7. Categories

### Why ask for categories

Ranking policy should differ by content type. Categories are not just metadata; they change:

- how many images are worth keeping,
- how stars should be assigned,
- and which images should be protected from cull.

### Recommended category set

Ask the LLM to assign one or more of these categories per image:

- `portrait`
- `group_portrait`
- `selfie`
- `landscape`
- `travel`
- `event`
- `pet`
- `action`
- `document`
- `receipt`
- `whiteboard`
- `screenshot`
- `snapchat_save`
- `technical_construction`
- `vehicle`
- `food`
- `meme`
- `other`

### Category semantics

- `document`
  - paperwork, letters, forms, printed information
- `receipt`
  - narrow subtype because legibility and duplicate handling matter
- `whiteboard`
  - notes, sketches, meeting boards, handwritten planning
- `screenshot`
  - phone/computer screenshots, app captures, saved social content
- `snapchat_save`
  - screenshot or saved image plausibly originating from Snapchat, especially partner-shared or personal-message content
- `technical_construction`
  - house construction, wiring, plumbing, measurements, installation progress, materials, serial labels

### Category-specific policy hooks

- `portrait`, `group_portrait`, `selfie`, `event`, `travel`
  - optimize for expression, timing, eyes, composition, uniqueness

- `landscape`
  - optimize for composition, light, clarity, strongest frame

- `document`, `receipt`, `whiteboard`
  - optimize for legibility, completeness, glare avoidance
  - more than one image may be useful if different sections are visible

- `screenshot`, `snapchat_save`
  - optimize for personal or informational value, not visual quality
  - default to protect if meaningful

- `technical_construction`
  - optimize for reference usefulness, visible detail, angle coverage
  - often keep multiple complementary images

### Prompting guidance for categories

Do not ask the model for dozens of speculative labels. Ask for a small fixed vocabulary tied to policy decisions. The category system should be stable and useful, not exhaustive.

### Special handling: partner-shared / Helene content

Because the user explicitly wants some Snapchat-derived photos from Helene kept, the category/protection logic should support that directly.

Recommended rule:

- If the image appears to be a Snapchat save or screenshot with personal-memory value:
  - tag `snapchat_save`
  - set `protectFromCull = true` unless clearly accidental/unusable
  - map to at least `1★` if retained

The model cannot reliably know “this is from Helene” from pixels alone, so add prompt hints from filename/path/source metadata when available.

## 8. Iteration

### Core strategy

Treat prompt design as an evaluable system, not a one-off prompt.

The stored response and feedback data should support a loop:

1. rank groups,
2. observe user overrides,
3. measure failure patterns,
4. revise prompt or policy,
5. re-run on sampled groups,
6. compare outcomes.

### What to measure

For each prompt/model version, track:

- agreement with final user keep set
- agreement at top 1 / top 2 / top 3
- false cull rate on protected or meaningful images
- star suggestion acceptance rate
- override rate by category
- confidence calibration
  - high-confidence wrong predictions are more important than low-confidence ones

### Useful evaluation slices

Break metrics down by:

- category
- group size
- existing-star presence
- screenshot vs non-screenshot
- technical/documentation vs aesthetic photo groups
- high-confidence vs low-confidence outputs

This matters because one prompt may help portraits and hurt documents.

### Feedback signals to capture

When the user changes the system output, store structured feedback:

- kept an image the model culled
- culled an image the model kept
- changed default keep count
- promoted/demoted star rating
- protected a screenshot/personal image
- rejected an overprotective suggestion

### Iteration levers

There are four main levers:

1. **Prompt wording**
   - better comparative phrasing
   - stronger guidance for utility content
   - stronger “personal value can outweigh quality” instructions

2. **Policy layer**
   - adjust how LLM output maps to stars
   - adjust when `protectFromCull` overrides cull suggestions
   - adjust default keep counts by category

3. **Metadata hints**
   - better path/source hints for screenshots and Snapchat saves
   - camera/date/folder context

4. **Preview generation**
   - resolution, crop strategy, EXIF correctness
   - bad previews will produce bad rankings

### Recommended iteration workflow

#### Phase A: offline benchmark set

Create a fixed evaluation set of groups covering:

- portraits
- landscapes
- events
- screenshots
- receipts/documents
- technical/construction
- Snapchat/personal-message saves
- groups with existing 3★+ ratings

For each group, store final user-reviewed outcomes as reference.

#### Phase B: prompt A/B comparison

Run candidate prompt versions on the same benchmark set and compare:

- top-1 accuracy
- top-2/top-3 set overlap
- protected-image mistakes
- category tagging usefulness

#### Phase C: production shadow mode

Before auto-applying anything aggressive:

- run LLM suggestions in the background,
- show them in the UI,
- but require user confirmation,
- and record overrides.

#### Phase D: selective automation

Only after collecting enough data:

- auto-apply cull suggestions for high-confidence, low-risk groups,
- keep protected/manual review for low-confidence or high-value groups.

### Reprocessing strategy

Because responses are versioned, you can safely re-run only when needed:

- prompt version changed
- model changed
- preview pipeline changed
- policy changed enough that derived star mapping should be recomputed

Not every policy change requires a fresh LLM call. If the raw response already contains the needed structure, re-derive stars and keep defaults locally.

## Recommended Final Design

### Architecture summary

- Use **one full-group Gemini 2.5 Flash Lite call per 2-20 image group**
- Return **strict JSON** with:
  - ranking,
  - keep sets,
  - categories,
  - confidence,
  - protection flags,
  - local star suggestions
- Store both **raw JSON** and **normalized SQLite rows**
- Make the plus/minus control operate on **keepTopN**, not stars
- Respect existing stars as a **hard floor**
- Avoid automatic 4★/5★ assignment
- Use stored feedback to iterate prompt and policy separately

### Key design change versus the old plan

The main shift is this:

- do **not** shrink the problem to fit a simplistic API call,
- instead send the whole group, ask for richer structure once, and reuse it everywhere:
  - review UI,
  - keep/cull defaults,
  - star suggestions,
  - category-specific handling,
  - and prompt iteration.

That is better on quality, simpler operationally, and still cheap enough at the stated group counts.
