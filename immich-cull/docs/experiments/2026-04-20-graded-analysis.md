# Graded-experiment analysis — 2026-04-20

**Tl;dr.** Binary user-match was misleading. When the user actually grades the picks on a 5-level severity scale, **gemma4:31b, qwen3.6-MoE, and gemini-3.1-flash-lite are statistically indistinguishable** (avg severity 0.50–0.55, i.e. between "perfect" and "fine"). The weak variant is `gemma4:e4b` (0.97). And every single keep-bias grade was "too few" or "right" — **zero** "too many". The user consistently wants more keepers than any model produces. Prompt v2 (a "keep 2 by default" rewrite) is being tested overnight; early signs show it changes keep counts as intended.

## What changed in how we score

Before overnight: variants ranked purely by binary user-match (did the model pick at least one photo the user also kept?).

After grading: 5-level severity from the user per pick-bundle:

| severity | meaning |
|---|---|
| 0 | perfect — I'd have picked this myself |
| 1 | fine — acceptable alternative |
| 2 | meh — minor regression |
| 3 | sad — real regression |
| 4 | 😢 — painful miss |

And an independent keep-count bias: too few / right / too many.

63 graded pick-bundles in Stage A + 15 in Stage B4 = 78 total. Plus 20 free-text notes with qualitative signal.

## Headline results

### Pooled ranking by avg severity (lower = better)

| variant | n grades | avg severity | sample comment |
|---|---|---|---|
| **gemma4_31b** | 28 | **0.50** | "spot-on reasoning" |
| qwen36_a3b_nothink | 29 | 0.52 | — |
| 31flashlite (prod) | 28 | 0.54 | — |
| qwen36_a3b_terse | 29 | 0.55 | — |
| qwen36_a3b_think | 6 | 0.83 | (small sample; unreliable) |
| gemma4_e4b | 29 | 0.97 | clearly weaker |

**Four variants are within 0.05 of each other** — noise floor, given the 78-grade sample size. The only clear quality winner vs loser is `gemma4:e4b`, which is about 2× worse on severity than the rest.

That *flips the headline* from the binary analysis: gemma4:31b actually leads the pack once you score picks on severity rather than exact-match.

### Binary user-match vs grade (same data)

| variant | binary user ✓% | avg severity | interpretation |
|---|---|---|---|
| 31flashlite (prod) | 86% | 0.54 | both metrics agree — reliable |
| gemma4_31b | 89% | 0.50 | leads on both (unbiased data now) |
| qwen_nothink | 79% | 0.52 | severity ~same as prod despite 7pp binary gap |
| qwen_terse | 79% | 0.55 | same |
| gemma4_e4b | 45% | 0.97 | both metrics agree — worst |

The 7pp binary gap between qwen and prod *doesn't reflect a quality gap*. A lot of qwen's "✗ user" picks are still 0-severity ("perfect — I'd have picked this too") — the user just happened to also pick a different valid frame.

### "✓ user" vs "✗ user" — what did the user think of the "wrong" picks?

| variant | ✓ user avg sev | ✗ user avg sev | ✗ distribution |
|---|---|---|---|
| 31flashlite | 0.50 (24) | 0.75 (4) | 0:2 1:1 2:1 3:0 4:0 |
| gemma4_31b | 0.54 (13) | — (0) | — |
| qwen_nothink | 0.48 (23) | 0.67 (6) | 0:3 1:2 2:1 3:0 4:0 |
| qwen_terse | 0.52 (23) | 0.67 (6) | 0:3 1:2 2:1 3:0 4:0 |
| gemma4_e4b | 0.62 (13) | 1.25 (16) | 0:4 1:4 2:8 3:0 4:0 |

Key insight: **for gemma4_e4b, a "✗ user" is signal of a real mistake** (avg 1.25, mostly "meh"). For the other four, **binary mismatch is mostly noise** — the user finds the model's alternative pick acceptable.

## Keep-count bias: the unanimous signal

Of 49 keep-bias grades across both experiments:

| direction | count |
|---|---|
| too few (-1) | 26 (53%) |
| right (0) | 23 (47%) |
| **too many (+1)** | **0** |

Per-variant avg bias:
- 31flashlite: -0.40
- gemma4_31b: -0.33
- qwen_nothink: -0.71
- qwen_terse: -0.62
- gemma4_e4b: -0.60
- qwen_think: -0.67

**Not a single pick was rated "too many".** This is the strongest directional signal in the entire dataset.

Free-text notes corroborate:
- "either 2 or 5 would be good to have in addition"
- "I'd keep no 4 too, the wide angle shot showing more of the room"
- "I would have picked more than two images"
- "missing the grandparents!"

→ Motivates **prompt v2** (running now): "keep 2 by default, 1 only if near-identical". Early sample (3 groups in): qwen-terse now picks 2 photos consistently; gemini does too.

## Variant agreement clusters

How often pairs of variants pick the same set of photos on the same group:

| pair | agreement |
|---|---|
| qwen_nothink ↔ qwen_terse | **26/29 (90%)** — effectively redundant |
| gemma4_31b ↔ qwen_terse | 12/13 (92%) — different arch, same output |
| gemma4_31b ↔ qwen_nothink | 11/13 (85%) |
| gemma4_31b ↔ 31flashlite | 11/13 (85%) |
| 31flashlite ↔ qwen_terse | 18/28 (64%) |
| 31flashlite ↔ qwen_nothink | 17/28 (61%) |
| gemma4_e4b ↔ anything | 21–46% — the outlier |

Practical consequence: running **both qwen variants is largely redundant** — they agree 90%. For future experiments, pick one (qwen_terse is faster).

## The "bad burst" problem

User excluded **1/30 groups** — a subgroup of 4 unrelated dev-app screenshots grouped purely by timestamp. Key observations:
- Prod gemini-3.1-flash-lite actually handled it most sensibly: picks=[0,1,2,3] — "these are screenshots documenting a software bug; all four are necessary to show the sequence". It broke the "pick the best" frame to preserve information.
- Local models blindly picked one "best" screenshot, which is meaningless.
- The "burst" classifier grouped these by proximity alone, without checking semantic similarity.

**This is a dataset-level issue, not a model-level one.** The 4-photo penalty landed on gemma4:e4b and qwen variants, but the right fix is upstream — filter these out before they reach any LLM. Idea captured in `IDEAS.md` ("Real-burst vs pseudo-burst classifier").

## What the notes tell us (qualitative)

20 free-text notes grouped by pattern:

**Keep more** (8 notes): user consistently wants 2–3 keepers where the LLM gave 1.
> *"I'd have picked more than two images, but sure, I wouldn't be sad if this was the result."*

**Face coverage** (5 notes): keeping a 2nd photo is often justified by "this one shows X's face where the first doesn't".
> *"I would have picked one more, since Halldis face is actually in no 4, it seems like a good extra."*

**Specific quality defects** (3 notes): eye-blinks, weird mouth shapes, cropping duplicates.
> *"image 0 is just a crop of image 4. So there's that."*

**Peak-action missing** (1 note):
> *"that photo is fine, but why not take the jump photo??"*

**Reasoning vs pick orthogonality** (2 notes): model's reasoning can be wrong while the pick is right.
> *"Description of img 8 is wrong. But the pick is okay."*

**All-bad groups** (1 note): when nothing is great, one pick is fine.
> *"All of them are bad. Gemma's reasoning is spot on. I would not have missed the others."*

Each pattern is a candidate lever — the face-coverage signal in particular is promising because Immich already has face detection. See `IDEAS.md` → "Face-coverage as explicit LLM signal".

## Practical recommendations

### Recommended deployment

| scenario | choice | rationale |
|---|---|---|
| Default production | **31flashlite (prod)** | 86% user-match, 0.54 severity, 4s/group; cheap and reliable |
| Offline/free fallback | **qwen36_a3b_terse** (local) | 79% match, 0.55 severity, 61s/group; quality indistinguishable from prod in graded analysis |
| Batch re-processing where latency doesn't matter | **gemma4_31b** | 0.50 severity leads; but 495s/group is 8× slower than qwen-terse |
| Don't use | **gemma4_e4b** | 45% match, 0.97 severity — 2× worse than the field |

### The single highest-impact change

**Ship prompt v2** (or whatever version lands overnight). The keep-bias finding is unambiguous — every model is under-keeping. A prompt rewrite is the cheapest fix and will lift severity across every variant we use without changing any model.

### The next experiment worth running

Face-coverage as explicit LLM signal. Immich has face detection on every asset. Passing "Image 0: faces=[A, B], Image 1: faces=[A, B, C]" to the LLM directly addresses the dominant user-note pattern ("missing the grandparents!", "Halldis face is actually in no 4"). Details in `IDEAS.md`.

## Bonus: burst-quality classifier ran tonight

Motivated by the "bad burst" finding above, I wrote a cheap heuristic classifier (`scripts/burst_quality_classifier.ts`) and ran it on all 16,142 subgroups with LLM results in the state DB.

**Result: 425 pseudo-burst subgroups flagged (2.6% of queue, 1,030 photos total).** All of them 100% screenshots by filename.

App breakdown:

| app | subgroups |
|---|---|
| Snapchat | 306 |
| Firefox | 33 |
| Telegram | 3 |
| Napper | 3 |
| Tapo | 2 |
| Slack | 2 |
| Settings / Spond / Claude / Vipps / Discord / etc | 1 each |

Group size is mostly small (300 pairs, 90 triples) but time spreads vary from seconds to hours — these are being grouped by the clock alone. The server already has a `Snapchat/Snapchat-*` auto-filter, but it doesn't catch screenshots IN other apps (Screenshot_20260408_064853_Firefox.jpg is the pattern).

All scores saved to `data/experiments/2026-04-20-burst-quality-scores.json`.

### Recommended integration

Short version: add this as a pre-LLM filter in the auto-cull pipeline. Three options (see `IDEAS.md → Real-burst vs "pseudo-burst" classifier`):

1. **Auto-cull all flagged** — assumes all screenshots are ephemeral. User comment suggests some are worth keeping ("like a recipe or something cool happening").
2. **Route to manual review with no LLM pick** — safer; user eyeballs and mass-deletes by pattern.
3. **Add a new auto-keep-pattern rule** per app: "keep everything from /Snapchat/, cull everything named Screenshot_*_Firefox.jpg" — probably the most maintainable, user toggles per app.

Option 3 is cheapest to implement and gives the user control.

## Raw data and scripts

- Source experiments: `data/experiments/2026-04-19-stageA.json`, `.../-stageB4.json`
- Grades (pick-keyed): `data/experiments/*-grades.json`
- Prompt v2 experiment (running overnight): `data/experiments/2026-04-20-promptv2.json`
- Analysis script: `scripts/analyze_graded_experiment.py`
- Prompt v2 script: `scripts/prompt_v2_experiment.ts`
- Backup of state.db at time of analysis: `data/backups/state-20260419-235751.db`
- This report is one of three in `docs/experiments/`: overnight, graded-analysis (this), IDEAS.md.

## Prompt v2 results (completed)

Ran the "keep 2 by default" prompt (see `scripts/prompt_v2_experiment.ts`) on the same 30 groups against `qwen_terse` and `31flashlite`. Results are unambiguous — this is by far the largest single improvement we've observed.

### Keep-count shift (target was ~2.0 to match user average)

| variant | v1 avg keep | v2 avg keep | distribution v2 |
|---|---|---|---|
| qwen_terse | 1.00 | **2.00** | 30/30 groups picked exactly 2 |
| 31flashlite | 1.21 | **2.03** | 27/29 picked 2, 1 picked 1, 1 picked 4 |

V2 hits the user average (2.07) almost exactly.

### User-match rate jumped +10pp for both variants

| variant | v1 user ✓ | v2 user ✓ | delta |
|---|---|---|---|
| qwen_terse | 23/30 (77%) | **28/30 (93%)** | +10pp |
| 31flashlite | 24/29 (83%) | **27/29 (93%)** | +10pp |

**qwen_terse v2 matches 31flashlite v2 exactly** (93% each). The keep-bias was the entire cloud-vs-local quality gap. Fix the prompt and the local model is competitive.

### What happened on each group

Behaviour: v2 keeps v1's pick and adds a second. Rarely swaps.

| action | qwen | gemini |
|---|---|---|
| identical picks | 0/30 | 4/29 |
| v2 adds one (superset) | 27 | 23 |
| → added pick was in user's keep set | **11** | **9** |
| → added pick user didn't keep | 16 | 14 |
| v2 swapped different | 3 | 2 |

So roughly **40% of the new 2nd picks match a user keep the LLM would otherwise have missed**, and the other 60% are "extras" the user can trim. This perfectly matches the user's stated preference ("I'd rather trim than lose").

### Concrete example

> `2025-10-25-88408d7b0da0::g1` (8 photos, `near_duplicate`)
> User kept: [1, 3, 5, 7]
> v1 qwen: [6] — ✗ user
> v2 qwen: [5, 7] — ✓ user (two of the four user-keeps)

And in groups where v2 keeps 2 but the user only kept 1, binary user-match is still ✓ — the LLM doesn't lose anything, just picks up a second.

### Takeaway and recommendation

**Change the production prompt.** The line to rewrite is `src/ranking/prompt.ts:89`:

> Current: *"'keep' array: STRICT SUBSET of 'all' — must be SHORTER than 'all'. Default to keeping only the single best per subgroup. Mark the rest 'c' in img."*
>
> Proposed: *"'keep' array: STRICT SUBSET of 'all' — must be SHORTER than 'all'. Default to keeping 2 per subgroup (1 if near-identical shutter-burst, 3+ for action sequences or when different faces are shown). Mark the rest 'c' in img."*

The current line contradicts the prompt's earlier guidance ("keep 1-2", "when in doubt keep"). Being in the OUTPUT section, it gets weighted more heavily. Aligning it adds the +10pp lift we just measured.

This is the single cheapest, highest-expected-impact change in the entire experiment. See `IDEAS.md → Fix the contradiction in the production prompt` for next steps.
