#!/usr/bin/env python3
"""Acceptable-rate analysis — the metric that matters for auto-cull confidence.

F1 measures *exact* match vs user's decisions. That's too strict: the user often
grades a pick `0 perfect` or `1 fine` even when it differs from their exact keep set,
because the alternative is "close enough" for an auto-cull workflow.

This script computes, for each variant:
  - Strict F1 (vs user state.db decisions) — the "old" metric
  - Acceptable rate (% of user-graded picks with severity ≤ 1)
  - Share of picks user hasn't graded yet (upper bound on acceptable rate)

Side-by-side comparison surfaces variants that lose F1 but win acceptability —
the candidates worth trusting for auto-cull.
"""
import json
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data" / "experiments"
BATCH_EXPS = [
    "2026-04-20-batch-batch_prod",
    "2026-04-20-batch-batch_adaptive",
    "2026-04-20-batch-batch_priorities",
    "2026-04-20-batch-batch_v1_style",
    "2026-04-20-batch-batch_min",
]


def load(name: str):
    p = DATA_DIR / f"{name}.json"
    return json.loads(p.read_text()) if p.exists() else None


def load_grades(name: str):
    p = DATA_DIR / f"{name}-grades.json"
    return json.loads(p.read_text()) if p.exists() else {}


def main():
    # Merge all grades across batch experiment files (most-recent updatedAt wins).
    all_grades: dict[str, dict] = {}
    for name in BATCH_EXPS:
        for key, grade in load_grades(name).items():
            if not grade:
                continue
            existing = all_grades.get(key)
            if not existing or (grade.get("updatedAt", "") > existing.get("updatedAt", "")):
                all_grades[key] = grade

    # Per-variant: collect every pick bundle, tag with severity if graded.
    per_variant: dict[str, dict] = defaultdict(
        lambda: {
            "picks": 0,
            "graded": 0,
            "sev_counts": [0, 0, 0, 0, 0],  # sev 0..4
            "keep_bias": {"too_few": 0, "right": 0, "too_many": 0, "null": 0},
            "f1_sum": 0.0,
            "f1_n": 0,
            "tp_total": 0,
            "fp_total": 0,
            "fn_total": 0,
        }
    )

    for name in BATCH_EXPS:
        exp = load(name)
        if not exp:
            continue
        for g in exp["results"]:
            group = g["group"]
            assets = group["assetIds"]
            user_keep = set(group.get("userKeepIds", []))
            user_cull = set(group.get("userCullIds", []))
            uki = {assets.index(u) for u in user_keep if u in assets}
            uci = {assets.index(u) for u in user_cull if u in assets}
            gk = f"{group['batchId']}::{group['subgroupId']}"
            seen_pick_keys_for_this_group: dict[str, set[str]] = {}

            for v in g["variants"]:
                if v["reason"].startswith(("ERROR", "PARSE")):
                    continue
                variant = v["variant"]
                picks = v["bestPicks"]
                pk = ",".join(str(i) for i in sorted(picks))
                grade_key = f"{gk}::picks={pk}"

                # Don't double-count a (variant, group, picks) across experiment files
                if variant not in seen_pick_keys_for_this_group:
                    seen_pick_keys_for_this_group[variant] = set()
                if pk in seen_pick_keys_for_this_group[variant]:
                    continue
                seen_pick_keys_for_this_group[variant].add(pk)

                d = per_variant[variant]
                d["picks"] += 1

                # F1 against user's state.db decisions
                if uki:
                    pickset = set(picks)
                    tp = len(pickset & uki)
                    fp = len(pickset & uci)
                    fn = len(uki - pickset)
                    p = tp / (tp + fp) if (tp + fp) else 0.0
                    r = tp / (tp + fn) if (tp + fn) else 0.0
                    f1 = 2 * p * r / (p + r) if (p + r) else 0.0
                    d["f1_sum"] += f1
                    d["f1_n"] += 1
                    d["tp_total"] += tp
                    d["fp_total"] += fp
                    d["fn_total"] += fn

                # Severity (from user's grading)
                grade = all_grades.get(grade_key)
                if grade and grade.get("severity") is not None:
                    d["graded"] += 1
                    sev = int(grade["severity"])
                    if 0 <= sev <= 4:
                        d["sev_counts"][sev] += 1
                    kb = grade.get("keepBias")
                    if kb == -1:
                        d["keep_bias"]["too_few"] += 1
                    elif kb == 0:
                        d["keep_bias"]["right"] += 1
                    elif kb == 1:
                        d["keep_bias"]["too_many"] += 1
                    else:
                        d["keep_bias"]["null"] += 1

    # Print table
    print("=" * 110)
    print("Acceptable-rate vs strict F1 per variant")
    print("=" * 110)
    print("Acceptable-rate = % of picks user graded with severity 0 ('perfect') or 1 ('fine').")
    print("These are the picks that are safe for auto-cull. Severity >= 2 = real regret.")
    print()
    print(
        f"{'variant':<45} {'total':>5} {'graded':>6} {'accept%':>8} "
        f"{'sev 0':>5} {'sev 1':>5} {'sev 2':>5} {'sev 3':>5}  "
        f"{'F1':>5} {'too few':>7} {'right':>5} {'too many':>8}"
    )
    rows = []
    for variant, d in sorted(per_variant.items()):
        graded = d["graded"]
        s = d["sev_counts"]
        accept = s[0] + s[1]
        accept_pct = 100 * accept / graded if graded else 0.0
        f1 = d["f1_sum"] / d["f1_n"] if d["f1_n"] else 0.0
        kb = d["keep_bias"]
        rows.append((variant, d["picks"], graded, accept_pct, s, f1, kb))
        print(
            f"{variant:<45} {d['picks']:>5} {graded:>6} "
            f"{accept_pct:>7.1f}% "
            f"{s[0]:>5} {s[1]:>5} {s[2]:>5} {s[3]:>5}  "
            f"{f1:>5.3f} "
            f"{kb['too_few']:>7} {kb['right']:>5} {kb['too_many']:>8}"
        )

    print()
    print("Sorted by accept% (min 3 grades):")
    print(f"{'variant':<45} {'graded':>6} {'accept%':>8} {'strict F1':>9}")
    filtered = [(v, picks, graded, acc, s, f1, kb) for v, picks, graded, acc, s, f1, kb in rows if graded >= 3]
    for variant, _picks, graded, acc, _s, f1, _kb in sorted(filtered, key=lambda r: -r[3]):
        print(f"{variant:<45} {graded:>6}  {acc:>6.1f}%  {f1:>8.3f}")

    # Auto-cull candidate analysis
    print()
    print("Auto-cull candidate criteria (graded >= 5, accept% >= 80, f1 >= 0.65):")
    for variant, _picks, graded, acc, _s, f1, _kb in rows:
        if graded >= 5 and acc >= 80 and f1 >= 0.65:
            print(f"  ✓ {variant:<45} graded={graded} acc={acc:.1f}% f1={f1:.3f}")


if __name__ == "__main__":
    main()
