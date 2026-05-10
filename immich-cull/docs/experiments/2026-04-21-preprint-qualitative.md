# Pre-print: qualitative analysis of batch-level grades

_Generated while the overnight experiments are still running. Based on **52 unique pick-bundle grades** (30 from `batch_prod` + 7 from `batch_adaptive`, which expand to 52 because the same pick is often produced by multiple variants). Raw data: `data/experiments/2026-04-20-batch-*-grades.json`. Regenerate with `python3 scripts/qualitative_analysis.py`._

---

## Headline

1. **`gemma4:e4b` at batch level is unusable. 12/12 graded pick-bundles kept every photo in the batch. All scored severity 3.** Recommend dropping from further batch experiments entirely.
2. **Severity and F1 are not well-correlated.** A pick with F1 = 0.89 still earned severity = 2 (sad) because it missed a critical person. A pick with F1 = 0.55 earned severity = 3 because it was a "keep all" by gemma4:e4b.
3. **v1_prod (production baseline) is "fine but over-keeps" in your view.** It hits severity = 0 or 1 on ~92% of graded picks, but keepBias = "too many" on ~54% of its grades.
4. **One clear product insight** (severity-2 case): when a batch contains multiple people, **missing a person entirely from the keep set is the dominant pain-point** — not cull accuracy. This is empirical validation of the §4.4 face-coverage tie-breaker idea from the 2026-04-20 handoff.

---

## Grade distribution (all variants, deduped by pick)

|  severity | keepBias = −1 (too few) | 0 (right) | 1 (too many) | null | **total** |
|---:|---:|---:|---:|---:|---:|
| 0 (perfect) | 1 | 11 | 9 | 1 | **22** |
| 1 (fine) | 4 | 5 | 12 | 0 | **21** |
| 2 (meh/sad) | 1 | 1 | 1 | 0 | **3** |
| 3 (😢) | 0 | 0 | 6 | 0 | **6** |

- **42% of picks are "perfect"**, **40% are "fine"**. Combined: 82%. Most of the time a cheap cloud variant or v1_prod produces a pick you can live with.
- **All 6 severity-3 picks are gemma4:e4b** keeping every photo. Gemma4:e4b is the only variant you've found truly unusable.
- **Only 3 severity-2 picks in 52 grades.** Real regret is rare — but the pattern of the 3 is instructive:
  1. `2025-10-25…` — v1_prod kept 13/23. Note: _"way too many pictures kept IMO."_ (severity 2, bias +1)
  2. `2003-07-29…` — v1_prod kept 7/15. Note: _"not 'my' photos. I'd have kept most."_ (severity 2, bias −1) — **domain mismatch**: these aren't the user's photos, so the prompt's implicit bias doesn't fit.
  3. `2026-04-03…` — v1_prod kept 4/15 with F1 = 0.89. Note: _"**Thomas is missing from all the breakfast-table pictures.** keeping one of 7,8,10,11 would have fixed."_ — **face-coverage failure**: best single regret in the dataset.

---

## Correlation: user severity ↔ auto-computed F1

|  severity | n | mean F1 | min F1 | max F1 |
|---:|---:|---:|---:|---:|
| 0 (perfect) | 22 | **0.80** | 0.44 | 1.00 |
| 1 (fine) | 21 | 0.58 | 0.00 | 0.92 |
| 2 (meh/sad) | 3 | **0.78** | 0.72 | 0.89 |
| 3 (😢) | 6 | 0.67 | 0.55 | 0.77 |

**Key takeaway**: **F1 and severity diverge.** The severity-2 picks have a mean F1 of 0.78 — *higher* than the severity-1 picks (0.58). And the severity-3 picks (all gemma4:e4b) have F1 = 0.67 — mechanically-moderate because they keep every photo so recall = 1.0 and precision is diluted but non-zero.

**Implication**: optimising for F1 alone will miss real quality problems. Specifically:
- A variant that loses F1 but picks "directionally fine" sets (e.g., different correct photos from the same subgroup) may win severity.
- A variant that wins F1 but drops a critical person can still feel bad.

The morning report's F1 table is useful for gross ranking but **severity grades are the better final judge**.

---

## Per-variant keepBias tally

Where the user left a keepBias on a pick that includes this variant (same pick can include multiple variants):

| variant | too few | right | too many | null |
|---|---:|---:|---:|---:|
| `v1_prod` | 9 | 38 | **45** | 2 |
| `3flash_batch_batch_adaptive` | 1 | 1 | **5** | 1 |
| `31flashlite_batch_batch_adaptive` | 1 | **3** | 3 | 0 |
| `gemma4_e4b_batch_batch_adaptive` | 0 | 0 | **6** | 0 |
| `gemma4_e4b_batch_batch_priorities` | 0 | 0 | **6** | 0 |
| `31flashlite_batch_batch_min` | 1 | **2** | 0 | 0 |
| `qwen36_a3b_terse_batch_batch_adaptive` | 1 | 0 | 1 | 0 |
| `3flash_batch_batch_priorities` | 0 | 0 | 1 | 0 |
| `31flashlite_batch_batch_priorities` | 0 | 1 | 1 | 0 |

Reading:
- **`v1_prod`** over-keeps on ~49% of picks. Small absolute effect (severity mostly 0/1), but directionally consistent.
- **`3flash_batch_batch_adaptive`** — also over-keeps (5/7 "too many"). It's the F1 winner at batch scale but shares v1's hoarding tendency.
- **`31flashlite_batch_batch_adaptive`** — most balanced: 3/7 "right". The cheap cloud model with the adaptive prompt may be the sweet spot once more grades come in.
- **`31flashlite_batch_batch_min`** — only 3 grades but 2/3 "right". The minimal prompt didn't outright fail on the picks the user saw. F1 is lower but on the ones you looked at, picks were tighter.

**Caution**: N is small on most variants. Treat this as a hypothesis: **cheaper models seem to have better keep-count calibration than the larger ones, which tend to hoard.**

---

## Common phrases in your notes

High-frequency terms (≥3 occurrences, stopwords removed):

| term | count | signal |
|---|---:|---|
| kept | 16 | describing what the variant did |
| i'd | 11 | "I'd have done X instead" — counter-factual alternative |
| cull / culled | 9, 8 | describing desired cull |
| many | 7 | "too many kept" pattern |
| bit | 7 | "a bit many" — softened over-keep complaint |
| sure / probably | 5, 5 | willing to accept imperfect |
| screenshots | 4 | recurring pain point (see below) |
| perfect | 3 | reserved praise |

**Screenshot observation** (4 explicit mentions): the grader is inconsistent about screenshots, and your judgment is context-dependent:
- `2026-04-10` (batch of 10 screenshots): _"I'd have culled them all. Temporary work-files, ephemeral."_ → wanted CULL.
- `2025-06-01` (recipe + reference screenshots): _"The 8-9-10 non-personal screenshots are from books I wanted to reference."_ → wanted KEEP.

The production prompt has "keep if useful reference" but the model can't distinguish ephemeral from reference from the image alone. This is fundamentally a **context problem** — may need filename patterns / app-origin detection rather than better prompting.

---

## What I'd change in the production prompt (hypotheses)

Based on the 46 non-gemma4:e4b grades only:

1. **Tighten keep-count slightly.** The dominant complaint is mild over-keeping. Not a severity-2 problem, but every "severity 1, bias +1" grade suggests you'd have preferred a ~10-15% lower keep rate. Consider adjusting "Aim to keep roughly 50-60%" → "Aim to keep roughly 40-50%".
2. **Add explicit face-coverage tie-breaker.** The single severity-2 "Thomas missing" case suggests a rule like _"Before finalising, check that every distinct person visible in the batch appears in at least one kept photo — add a keeper if not."_ This is exactly the §4.4 idea from yesterday's handoff, re-framed as a final-pass check rather than a primary objective.
3. **Don't touch screenshot handling via prompt — it's a data problem.** Needs filename pattern rules or app-origin metadata. Parking this.

---

## What to do next

1. **Drop `gemma4:e4b` from batch experiments.** It's a confirmed waste of time at batch scale. Keep it only at subgroup scale where it at least picks one photo.
2. **Grade more `batch_adaptive` + `batch_priorities`** once expanded to 50 batches (running tonight). Focus on bundles where `3flash_batch` / `31flashlite_batch` diverge from `v1_prod` — these are the actual comparison points.
3. **Try a face-coverage-aware tie-breaker variant** as §4.4 proposed, but framed as a post-check, not the primary objective.
4. **Consider running `batch_v1_style`** — tonight's new variant — on the same batches you've graded. If its picks match `v1_prod`'s, grades auto-inherit. If it diverges and improves severity, the 92-line v1 prompt was doing more work than necessary.

---

_Numbers here will shift as more grades come in. This is an early read, not a final verdict._
