# Overnight experiment report — 2026-04-21

_Generated from all 2026-04-20 experiment JSONs + grade files._


## Subgroup-level results (30 Stage A groups)

| experiment | variant | n | macro F1 | micro F1 | P | R | avg keep | exact | avg time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| v1 (Stage A) | `gemma4_31b` | 13 | **0.769** | 0.722 | 1.00 | 0.67 | 1.00 | 5/13 | 192.1s |
| v3 priorities | `31flashlite_v3_priorities` | 21 | **0.694** | 0.650 | 0.74 | 0.70 | 1.76 | 7/21 | 3.4s |
| v3 adaptive | `gemma4_31b_v3_adaptive` | 29 | **0.680** | 0.624 | 0.75 | 0.67 | 1.69 | 11/29 | 454.2s |
| v3 adaptive | `31flashlite_v3_adaptive` | 28 | **0.676** | 0.654 | 0.74 | 0.67 | 1.71 | 9/28 | 3.4s |
| v3 priorities | `gemma4_31b_v3_priorities` | 21 | **0.675** | 0.644 | 0.68 | 0.70 | 2.05 | 9/21 | 462.3s |
| v2 keep-2-default | `31flashlite_v2` | 28 | **0.620** | 0.613 | 0.62 | 0.68 | 1.96 | 5/28 | 3.5s |
| v1 (Stage A) | `31flashlite` | 28 | **0.618** | 0.552 | 0.82 | 0.52 | 1.11 | 7/28 | 3.7s |
| v2 keep-2-default | `qwen36_a3b_terse_v2` | 29 | **0.616** | 0.610 | 0.62 | 0.67 | 2.00 | 5/29 | 60.4s |
| v1 (Stage A) | `qwen36_a3b_think` | 6 | **0.611** | 0.556 | 0.83 | 0.53 | 1.00 | 2/6 | 163.5s |
| v1 (Stage A) | `qwen36_a3b_nothink` | 29 | **0.570** | 0.522 | 0.76 | 0.48 | 1.10 | 6/29 | 83.5s |
| v1 (Stage A) | `qwen36_a3b_terse` | 29 | **0.569** | 0.517 | 0.79 | 0.47 | 1.00 | 6/29 | 59.6s |
| v3 priorities | `qwen36_a3b_terse_v3_priorities` | 23 | **0.555** | 0.547 | 0.54 | 0.61 | 2.43 | 3/23 | 115.8s |
| v3 adaptive | `qwen36_a3b_terse_v3_adaptive` | 29 | **0.552** | 0.529 | 0.68 | 0.51 | 1.45 | 5/29 | 139.5s |
| v3 priorities | `gemma4_e4b_v3_priorities` | 22 | **0.347** | 0.385 | 0.35 | 0.51 | 2.82 | 2/22 | 172.4s |
| v1 (Stage A) | `gemma4_e4b` | 29 | **0.326** | 0.292 | 0.45 | 0.28 | 1.00 | 5/29 | 45.7s |
| v3 adaptive | `gemma4_e4b_v3_adaptive` | 29 | **0.282** | 0.244 | 0.38 | 0.24 | 1.07 | 4/29 | 142.6s |

### Keep-count distribution (subgroup)

| variant | experiment | distribution |
|---|---|---|
| `gemma4_e4b` | v1 (Stage A) | 1:30 |
| `gemma4_31b` | v1 (Stage A) | 1:13 |
| `qwen36_a3b_nothink` | v1 (Stage A) | 1:27 2:3 |
| `qwen36_a3b_think` | v1 (Stage A) | 1:6 |
| `qwen36_a3b_terse` | v1 (Stage A) | 1:30 |
| `31flashlite` | v1 (Stage A) | 1:25 2:3 4:1 |
| `qwen36_a3b_terse_v2` | v2 keep-2-default | 2:30 |
| `31flashlite_v2` | v2 keep-2-default | 1:1 2:27 4:1 |
| `qwen36_a3b_terse_v3_adaptive` | v3 adaptive | 1:20 2:7 3:3 |
| `gemma4_31b_v3_adaptive` | v3 adaptive | 1:16 2:7 3:5 4:2 |
| `gemma4_e4b_v3_adaptive` | v3 adaptive | 1:29 3:1 |
| `31flashlite_v3_adaptive` | v3 adaptive | 1:10 2:16 3:2 4:1 |
| `qwen36_a3b_terse_v3_priorities` | v3 priorities | 1:4 2:7 3:11 5:1 |
| `gemma4_31b_v3_priorities` | v3 priorities | 1:6 2:11 3:3 6:1 |
| `gemma4_e4b_v3_priorities` | v3 priorities | 1:12 3:2 4:2 5:2 6:2 7:2 |
| `31flashlite_v3_priorities` | v3 priorities | 1:5 2:16 |

## Batch-level results

| experiment | variant | n | macro F1 | micro F1 | P | R | avg keep | exact | avg time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| batch_min | `v1_prod` | 23 | **0.742** | 0.772 | 0.75 | 0.76 | 8.65 | 0/23 | 0.0s |
| v1 baseline | `v1_prod` | 58 | **0.731** | 0.762 | 0.75 | 0.77 | 7.10 | 3/58 | 0.0s |
| batch_adaptive | `v1_prod` | 48 | **0.721** | 0.748 | 0.73 | 0.76 | 7.19 | 2/48 | 0.0s |
| batch_priorities | `v1_prod` | 48 | **0.721** | 0.748 | 0.73 | 0.76 | 7.19 | 2/48 | 0.0s |
| batch_v1_style | `v1_prod` | 48 | **0.721** | 0.748 | 0.73 | 0.76 | 7.19 | 2/48 | 0.0s |
| batch_priorities | `qwen36_a3b_terse_batch_batch_priorities` | 15 | **0.704** | 0.749 | 0.70 | 0.73 | 5.93 | 1/15 | 340.8s |
| batch_v1_style | `31flashlite_batch_batch_v1_style` | 47 | **0.696** | 0.699 | 0.66 | 0.78 | 8.30 | 1/47 | 5.7s |
| batch_priorities | `3flash_batch_batch_priorities` | 47 | **0.695** | 0.707 | 0.62 | 0.85 | 9.85 | 0/47 | 16.9s |
| batch_v1_style | `3flash_batch_batch_v1_style` | 47 | **0.692** | 0.704 | 0.59 | 0.89 | 10.28 | 1/47 | 15.7s |
| batch_priorities | `31flashlite_batch_batch_priorities` | 47 | **0.689** | 0.695 | 0.65 | 0.77 | 8.45 | 2/47 | 8.9s |
| batch_priorities | `gemma4_e4b_batch_batch_priorities` | 14 | **0.676** | 0.692 | 0.53 | 1.00 | 15.14 | 0/14 | 196.5s |
| batch_adaptive | `gemma4_e4b_batch_batch_adaptive` | 14 | **0.668** | 0.686 | 0.53 | 0.98 | 14.93 | 0/14 | 267.4s |
| batch_adaptive | `31flashlite_batch_batch_adaptive` | 47 | **0.667** | 0.679 | 0.68 | 0.70 | 7.21 | 1/47 | 5.4s |
| batch_adaptive | `3flash_batch_batch_adaptive` | 47 | **0.665** | 0.659 | 0.61 | 0.80 | 9.21 | 2/47 | 15.1s |
| batch_adaptive | `qwen36_a3b_terse_batch_batch_adaptive` | 15 | **0.663** | 0.718 | 0.66 | 0.68 | 5.87 | 1/15 | 242.4s |
| batch_v1_style | `qwen36_a3b_terse_batch_batch_v1_style` | 15 | **0.658** | 0.674 | 0.61 | 0.79 | 7.47 | 0/15 | 289.4s |
| batch_min | `31flashlite_batch_batch_min` | 23 | **0.632** | 0.658 | 0.63 | 0.68 | 9.09 | 0/23 | 5.6s |
| batch_min | `3flash_batch_batch_min` | 23 | **0.619** | 0.656 | 0.55 | 0.76 | 11.00 | 0/23 | 12.9s |

## Headline

**Top subgroup variants (n ≥ 20):**

- `31flashlite_v3_priorities` (v3 priorities) — F1 **0.694** on 21 groups, avg keep 1.76, 7/21 exact
- `gemma4_31b_v3_adaptive` (v3 adaptive) — F1 **0.680** on 29 groups, avg keep 1.69, 11/29 exact
- `31flashlite_v3_adaptive` (v3 adaptive) — F1 **0.676** on 28 groups, avg keep 1.71, 9/28 exact

**Top batch variants (n ≥ 20):**

- `v1_prod` (batch_min) — F1 **0.742** on 23 batches, avg keep 8.65, 0/23 exact
- `v1_prod` (v1 baseline) — F1 **0.731** on 58 batches, avg keep 7.10, 3/58 exact
- `v1_prod` (batch_adaptive) — F1 **0.721** on 48 batches, avg keep 7.19, 2/48 exact
- `v1_prod` (batch_priorities) — F1 **0.721** on 48 batches, avg keep 7.19, 2/48 exact
- `v1_prod` (batch_v1_style) — F1 **0.721** on 48 batches, avg keep 7.19, 2/48 exact

## Grade inheritance overlap (batch)

_How many of user's graded pick-bundles in `batch_prod` have an identical (group, picks) match in each new batch variant — those grades inherit automatically._

| experiment | bundles in exp | bundles sharing a graded baseline pick | baseline grades |
|---|---:|---:|---:|
| `2026-04-20-batch-batch_adaptive` | 176 | 30 | 30 |
| `2026-04-20-batch-batch_priorities` | 173 | 30 | 30 |
| `2026-04-20-batch-batch_v1_style` | 158 | 30 | 30 |
| `2026-04-20-batch-batch_min` | 73 | 25 | 30 |

## Notes & recommendations

- Subgroup winner `31flashlite_v3_priorities` (F1 0.694, avg keep 1.76 photos). v3 adaptive/priorities framing breaks v1's rigid-1 and v2's rigid-2 keep-count problem.
- Batch-scale winner `v1_prod` at F1 0.742. But F1 alone is misleading — severity grades (qualitative analysis) are the real judge.
- Terse prompts (`min`) underperform in every experiment. Rule out.
- Local models: qwen3.6:35b-a3b is viable but 4×+ slower than cloud at batch scale without clear quality win. gemma4:e4b kept 98-100% of every batch — unsuitable at batch scale.
- Next: use the best batch prompt (likely `batch_adaptive` on 3flash-preview or `batch_v1_style`) as production prompt. Re-rank the 72k backlog once chosen.
