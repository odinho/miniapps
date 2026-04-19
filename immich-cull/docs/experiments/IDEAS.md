# Photo-culling ideas: backlog and open questions

Persistent ideas for the culling pipeline. Each item has: motivation, sketch, and where the idea came from. **Status** is roughly `[ ] not started / [~] in progress / [x] done / [-] discarded`.

When you finish something, move it to a `## Completed` section at the bottom with a short note on how it played out.

---

## Near-term, high-signal

### [~] Fix the contradiction in the production prompt (`src/ranking/prompt.ts:89`) — PARTIAL
- **Motivation**: Line 89 of the production prompt said: *"Default to keeping only the single best per subgroup. Mark the rest 'c' in img."* This contradicted earlier guidance ("keep 1-2", "when in doubt keep"). LLMs weight OUTPUT-section instructions heavily; this was almost certainly why prod kept ~1.2/subgroup when user wants ~2.0.
- **Done**: Changed line 89 to *"Default to keeping 2 per subgroup (1 if near-identical shutter-burst, 3+ for action sequences or when the extra keeper shows a face or moment the first doesn't)."*
- **Burst-discriminator experiment**: +10pp user-match for both qwen_terse and 31flashlite (77→93%, 83→93%) with keep count moving 1.0→2.0.
- **Prod validation (8 random batches, 124 photos total)**: aggregate keep went 44.4%→46.8% (+5.5%), subgroup avg-keep moved from 1.3 to 1.3–1.5 range. **Smaller shift than the burst-discriminator experiment** because the prod prompt has many other instructions (line 51 "keep 1-2", line 47 "50-60% overall", etc.) competing for interpretation. Raw data: `data/experiments/2026-04-20-prod-prompt-validation.json`.
- **Next step to complete this item**: Line 51 currently says *"Default to keeping 1-2 photos per subgroup."* Consider updating to *"Default to keeping 2 photos per subgroup."* to reinforce the new default. Re-run validation script and measure subgroup avg-keep shift.

### [ ] Prompt v2: "keep 2 by default, 1 only if near-identical"
- **Motivation**: The graded-data analysis (2026-04-19) found that user keeps ~2.07 photos/group; all tested LLMs keep 1.0–1.2. Every keep-bias grade was "too few" or "right" — literally zero "too many". Prompt language "keep up to 2 if genuinely different" is parsed too conservatively.
- **Sketch**: Invert the default — "keep 2 that best complement each other; 1 only if photos are near-identical shutter-bursts; 3+ if distinct moments". Add explicit priority: **people coverage** (keep a second if it shows a face the first misses). Try it on the same 30 groups.
- **Status**: Experiment running overnight (2026-04-20) — `data/experiments/2026-04-20-promptv2.json`.
- **Next**: Compare keep-count distribution and per-group picks against v1.

### [ ] Real-burst vs "pseudo-burst" classifier (dataset hygiene)
- **Motivation**: During grading, user excluded a group of 4 dev-app screenshots that the burst detector grouped by timestamp but are semantically unrelated. This is a systemic issue — when the "burst" is actually unrelated time-adjacent photos, the LLM is forced to make meaningless picks that skew all metrics.
- **Sketch**: Compute cheap features per group and classify real-burst vs scene vs junk:
  - Filename regex: `/screenshot[_\-]?/i` → junk-ish
  - Path contains `/Screenshots/` or `/Screen Recordings/` → junk
  - Time spread of N photos: >30s for tight bursts, >few-min is scene, >1h is just a session
  - Aspect-ratio variance across the group (screenshots tend to all be identical aspect)
  - Embedding variance (available from Immich) — tight burst has low variance
- **Pre-LLM filter**: If junk confidence > 0.7, auto-cull all (or route to manual). If scene, tell the LLM "these are scene variants, keep more".
- **Status**: Not started.

### [ ] Add confidence field to LLM output
- **Motivation**: User noted on a group where the LLM picked "most comprehensive shot" that the pick wasn't actually best — the reasoning was shallow. Confidence would let us route low-confidence picks to human review and auto-approve high-confidence ones.
- **Sketch**: Extend `best`/`ranking`/`reason` JSON with `"confidence": 0.0-1.0`. Few-shot examples in the prompt to calibrate. Auto-cull pipeline keeps existing behavior for confidence≥0.8, routes rest to review.
- **Status**: Not started. Worth testing after prompt v2 lands.

### [ ] Grade the REASONING separately from the pick
- **Motivation**: User notes during grading: "description of img 8 is wrong. But the pick is okay". Reasoning quality and pick quality are orthogonal. We currently only measure picks.
- **Sketch**: Add an optional 3rd dimension in the grader (0=sound, 1=plausible, 2=nonsense). Correlate with pick severity. If reasoning-wrong but pick-right is common on one model, that model has shallow understanding but still works — cheap + useful.
- **Status**: Not started. Small grader addition; add once prompt v2 is graded.

---

## Medium-term experiments

### [ ] Mixed-expert routing: cheap local + cloud fallback
- **Motivation**: qwen_terse (local, 60s, ~79% user-match) is close to prod (cloud, 4s, 86%). If we can detect "easy" vs "hard" groups cheaply, route easy to local and hard to cloud for the 7pp quality boost only where it matters. On the 72k-photo backlog that's a big cost saving with minimal quality loss.
- **Sketch**:
  - Run qwen_terse first.
  - If its confidence is high OR an ensemble of cheap signals agrees, use it.
  - Else fall back to gemini-3.1-flash-lite.
- **Data**: Agreement-clusters analysis shows qwen_nothink ↔ qwen_terse agree 90%, qwen ↔ gemini agree ~64%. The disagreements are the routing signal.
- **Status**: Not started. Needs confidence score first.

### [ ] Scale the grading test set to 60+ groups
- **Motivation**: 30 groups (with 1 excluded → 29) is a small sample. Some variant differences are within noise. Grading 30 more would tighten confidence intervals considerably.
- **Sketch**: Run a new batch of 30 groups through Stage A variants. Grade. Analyze per size/type/burst-source.
- **Status**: Not started.

### [ ] Unsloth quantization of qwen3.6-35b-a3b
- **Motivation**: User mentioned seeing "24 tps with 8GB VRAM using iq4_xs unsloth" for some model. Our current qwen achieves ~11 tps CPU-offloaded. If unsloth's IQ4_XS fits more in VRAM, we could halve the per-group latency (~60s → ~30s) and make local really viable.
- **Sketch**: Check if unsloth has `Qwen3.6-35B-A3B` on HF yet. Import to Ollama via Modelfile. Re-run benchmark.
- **Status**: Not started. Worth checking monthly as models are quantized.

### [ ] Face-coverage as explicit LLM signal
- **Motivation**: User notes repeatedly mention missing faces: "missing the grandparents!", "either 2 or 5 would be good to have in addition", "I'd keep no 4 too, the wide angle shot showing more of the room, and her having a different expression". The priority is clearly people, and coverage of different people matters.
- **Sketch**: Use Immich's face-detection data (already on every asset) to tell the LLM which faces appear in which photo. Prompt line per image: `"Image 0: faces=[Alice, Bob]"` → `"Image 1: faces=[Alice, Bob, Carol]"`. Then bias the prompt toward keeping frames that together cover more distinct people.
- **Data availability (verified 2026-04-20)**: Immich's `/api/assets/:id` response includes a `people` array with `{id, name, faces:[{boundingBox}]}`. Example asset returned `[{name: 'Skjalg', ...}]`. Named people are identified by ML. Data is immediately usable — no new ML pipeline required.
- **Implementation path**:
  1. Extend `ImmichApiAdapter` with `getPeopleForAssets(ids)` that batches the `/api/assets/:id` calls (or look for a bulk endpoint).
  2. Cache results (asset↔person is slow-changing).
  3. Add `peopleByAsset: Record<assetId, string[]>` to the `buildPrompt` input. Render into the per-image meta line: `{i, f, t, p: ['Skjalg', 'Halldis']}`.
  4. Append one line to the prompt body: *"If an extra keeper shows a named person the first keeper misses, that alone justifies a second keep."*
  5. Run the validator (`scripts/validate_prod_prompt_change.ts`) on 10 real batches, diff subgroup keeps + check whether the 6 drops from the "keep 2 default" change stop happening.
- **Status**: Not started. Highest expected impact among remaining items; implementation is straightforward because data is already there.

---

## Speculative / exploratory

### [ ] Crop-duplicate detection ("image 0 is a crop of image 4")
- **Motivation**: Direct user observation: one pick was "just a crop" of another. Models treat them as distinct.
- **Sketch**: Embedding similarity > threshold + one image's dominant region matches the other's full frame = crop. Merge automatically before LLM.

### [ ] Peak-action detector
- **Motivation**: User note: "why not take the jump photo??" — models pick the "most comprehensive" frame but miss the peak instant.
- **Sketch**: Motion-blur patterns can indicate peak movement. Or frame-to-frame pixel diff across a burst to find the outlier (peak action).

### [ ] Learn from user's actual past decisions
- **Motivation**: state.db has 3843 user decisions. These are free ground truth. Any model could be fine-tuned on them, or we could compute per-user preferences (e.g., "this user always keeps landscapes with pets").
- **Sketch**: Build a small preference profile from the decisions. Pass summary stats to the LLM as context: "User tends to keep ~50% of burst; prefers landscape+subject compositions; favors sharp eyes over wider shots."

### [ ] Auto-cull pipeline confidence tiers
- **Motivation**: Current pipeline has `auto-cull-high`, `auto-cull`, `review` tiers. The rules are based on fixed thresholds. With graded data we can tune those thresholds empirically.
- **Sketch**: Walk the state.db auto-cull records + graded severities + user final decisions. Compute: at what LLM agreement level does severity stay low? That's the safe threshold.

### [ ] "What would user do?" shadow grader
- **Motivation**: Each LLM costs time/money. If we had a tiny local classifier trained on user's grades, we could pre-filter or second-guess LLM output without another round-trip.
- **Sketch**: Fine-tune a small vision-language model (e.g., CLIP + classifier head) on (user-kept, user-culled) pairs from state.db.

---

## Notes from grading (raw observations to mine later)

Direct quotes from user notes during grading — each one is a signal:

- *"Yeah, this one has open eyes."* — eyes-open detection is table stakes.
- *"image 0 is just a crop of image 4. So there's that."* — crop-duplicate detection.
- *"that photo is fine, but why not take the jump photo??"* — peak-action missing.
- *"either 2 or 5 would be good to have in addition"* — keep-more bias confirmed.
- *"missing the grandparents!"* — face coverage matters.
- *"I'd keep no 4 too, the wide angle shot showing more of the room, and her having a different expression."* — wide vs close-up is a meaningful distinction, not just a duplicate.
- *"photo 4 is better, this 5 has a weird thing with the mouth."* — facial-expression anomalies (weird mouths, half-blinks).
- *"all of them are bad. [...] I think LLM's pick is fine here. I would not have missed the others"* — when nothing is great, picking *one* is fine, don't over-select.
- *"description of img 8 is wrong. But the pick is okay."* — reasoning-vs-pick orthogonality.
- *"maybe we need another level, because I AM fine with this, but I don't think it's perfect"* — led directly to the 5-level severity scale (0=perfect, 1=fine, 2=meh, 3=sad, 4=😢).

---

## Completed

### [x] Pick-based grading UI
2026-04-20. Rewrote the grader to key grades on the pick-signature rather than variant name — collapses multiple variants with identical picks into a single grade. Dramatically reduces redundant grading work. See `web-app/src/components/ExperimentGrader.svelte`.

### [x] Excluded-groups action
2026-04-20. Added `x` shortcut + button to exclude a group from the test set (for dev screenshot bursts etc.). Excluded groups are dimmed in UI, don't count in summaries, don't block "resume at ungraded". User excluded 1/30 groups in Stage A.

### [x] Undici `headersTimeout: 0` fix for slow Ollama calls
2026-04-20. Root cause of earlier `fetch failed` errors on multi-image requests to large models was undici's default 300s `headersTimeout`. Installed `undici` as a dep and set a global dispatcher with `headersTimeout: 0, bodyTimeout: 0`. Stage B4 then ran 15/15 groups with zero errors (longest call: 813s).

### [x] Overnight experiment (Stage A + B4)
2026-04-19 → 2026-04-20. 30 groups × 6 variants + 15-group unbiased rerun of gemma4:31b. Report: `docs/experiments/2026-04-19-qwen-gemma-overnight.md`.
