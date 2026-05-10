#!/usr/bin/env python3
"""Qualitative analysis of user's batch-level grading notes.

Cross-references grade files against experiment results to surface:
  - Which variants produced which picks (especially gemma4:e4b "keep all" patterns)
  - Severity × keepBias × note distributions
  - Common phrases in the user's notes
  - Correlation between user's severity rating and auto-computed F1
"""
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data" / "experiments"
GRADE_FILES = [
    "2026-04-20-batch-batch_prod-grades.json",
    "2026-04-20-batch-batch_adaptive-grades.json",
]
EXP_FILES = [
    "2026-04-20-batch-batch_prod.json",
    "2026-04-20-batch-batch_adaptive.json",
    "2026-04-20-batch-batch_priorities.json",
    "2026-04-20-batch-batch_min.json",
]


def load(name: str):
    p = DATA_DIR / name
    return json.loads(p.read_text()) if p.exists() else None


def find_variants_with_pick(group_key: str, pick_key: str) -> list[tuple[str, str]]:
    """Return [(experiment_file, variant_name)] for every variant that produced this pick.

    Grade keys are `batchId::subgroupId::picks=i,j,k`. We walk every experiment file and
    match against (group, picks)."""
    batch_id, sg_id, picks_part = group_key.split("::")
    pick_indices = tuple(int(x) for x in picks_part.replace("picks=", "").split(",") if x)
    matches: list[tuple[str, str]] = []
    for fn in EXP_FILES:
        exp = load(fn)
        if not exp:
            continue
        for r in exp["results"]:
            if r["group"]["batchId"] != batch_id or r["group"]["subgroupId"] != sg_id:
                continue
            for v in r["variants"]:
                if v["reason"].startswith(("ERROR", "PARSE")):
                    continue
                if tuple(sorted(v["bestPicks"])) == pick_indices:
                    matches.append((fn, v["variant"]))
    return matches


def f1_for_pick(group_key: str, pick_key: str) -> tuple[float, int, int, int]:
    """Return (f1, tp, fp, fn) — honours user-undecided photos (doesn't count them as FP)."""
    batch_id, sg_id, picks_part = group_key.split("::")
    pick_indices = {int(x) for x in picks_part.replace("picks=", "").split(",") if x}
    for fn in EXP_FILES:
        exp = load(fn)
        if not exp:
            continue
        for r in exp["results"]:
            if r["group"]["batchId"] != batch_id or r["group"]["subgroupId"] != sg_id:
                continue
            assets = r["group"]["assetIds"]
            uki = {assets.index(u) for u in r["group"].get("userKeepIds", []) if u in assets}
            uci = {assets.index(u) for u in r["group"].get("userCullIds", []) if u in assets}
            if not uki:
                return 0.0, 0, 0, 0
            tp = len(pick_indices & uki)
            fp = len(pick_indices & uci)
            fn = len(uki - pick_indices)
            p = tp / (tp + fp) if (tp + fp) else 0.0
            rc = tp / (tp + fn) if (tp + fn) else 0.0
            f1 = 2 * p * rc / (p + rc) if (p + rc) else 0.0
            return f1, tp, fp, fn
    return 0.0, 0, 0, 0


def main():
    print("=" * 96)
    print("Qualitative analysis of user's batch-level grading notes")
    print("=" * 96)
    print()

    all_grades: dict[str, dict] = {}
    for gf in GRADE_FILES:
        grades = load(gf)
        if not grades:
            continue
        for k, v in grades.items():
            # Most recent wins if duplicated across files
            if k not in all_grades or (v.get("updatedAt", "") > all_grades[k].get("updatedAt", "")):
                all_grades[k] = v

    graded = {k: v for k, v in all_grades.items() if v.get("severity") is not None}
    print(f"Total unique pick-bundles graded: {len(graded)}\n")

    # --- Severity × keepBias distribution ---
    print("Severity × keepBias distribution:")
    matrix: dict[tuple[int | None, int | None], int] = Counter()
    for v in graded.values():
        matrix[(v["severity"], v.get("keepBias"))] += 1
    print(f"  {'sev':>4}  {'kb':>4}  {'count':>6}")
    for (sev, kb), cnt in sorted(matrix.items(), key=lambda x: (x[0][0], -99 if x[0][1] is None else x[0][1])):
        print(f"  {sev:>4}  {str(kb):>4}  {cnt:>6}")
    print()

    # --- Gemma4:e4b "keep everything" confirmation ---
    print("gemma4:e4b 'keep all' check:")
    e4b_all_kept = 0
    e4b_total = 0
    e4b_examples: list[tuple[str, int, str]] = []
    for k, grade in graded.items():
        batch_id, sg_id, picks_part = k.split("::")
        pick_indices = tuple(int(x) for x in picks_part.replace("picks=", "").split(",") if x)
        variants = find_variants_with_pick(k, picks_part)
        for _fn, var in variants:
            if "gemma4_e4b" not in var:
                continue
            e4b_total += 1
            # Look up batch size
            batch_size = 0
            for fn in EXP_FILES:
                exp = load(fn)
                if not exp:
                    continue
                for r in exp["results"]:
                    if r["group"]["batchId"] == batch_id and r["group"]["subgroupId"] == sg_id:
                        batch_size = len(r["group"]["assetIds"])
                        break
                if batch_size:
                    break
            if batch_size and len(pick_indices) == batch_size:
                e4b_all_kept += 1
            e4b_examples.append((batch_id, len(pick_indices), f"{grade['severity']}/{grade.get('keepBias')}"))
    print(f"  gemma4_e4b pick-bundles graded: {e4b_total}")
    print(f"  where variant kept EVERY photo: {e4b_all_kept}/{e4b_total}")
    print(f"  severities graded on these: {Counter(g for _, _, g in e4b_examples)}")
    print()

    # --- Severity vs F1 ---
    print("Correlation between user severity and auto-computed F1 (against user keeps):")
    print(f"  {'severity':>10}  {'n':>4}  {'mean F1':>8}  {'min F1':>8}  {'max F1':>8}")
    sev_buckets: dict[int, list[float]] = defaultdict(list)
    for k, grade in graded.items():
        _, _, picks_part = k.split("::")
        f1, _, _, _ = f1_for_pick(k, picks_part)
        sev_buckets[grade["severity"]].append(f1)
    for sev in sorted(sev_buckets):
        fs = sev_buckets[sev]
        print(f"  {sev:>10}  {len(fs):>4}  {sum(fs) / len(fs):>8.3f}  {min(fs):>8.3f}  {max(fs):>8.3f}")
    print()

    # --- Keyword frequency in notes ---
    print("Common terms in user notes (lowercased, >=3 occurrences):")
    all_notes = [g.get("note", "") for g in graded.values() if g.get("note")]
    words: Counter[str] = Counter()
    for n in all_notes:
        for w in re.findall(r"[a-z']{3,}", n.lower()):
            words[w] += 1
    stopwords = {
        "the", "and", "for", "but", "not", "are", "have", "would", "could", "this", "that",
        "with", "too", "fine", "also", "just", "those", "any", "all", "some", "been", "there",
        "then", "like", "good", "better", "more", "less", "only", "since", "into", "over", "from",
        "out", "one", "two", "three", "its", "him", "his", "her", "she", "you", "your", "they",
        "their", "them", "had", "has", "was", "were", "been", "being", "was", "who", "what",
        "how", "when", "where", "why", "whom", "whose", "will", "shall", "may", "might",
        "can", "need", "needs", "done", "did", "make", "made", "thing", "things", "even",
        "yes", "well", "tbh", "ofc", "lol",
    }
    filtered = [(w, c) for w, c in words.most_common(50) if w not in stopwords and c >= 3]
    for w, c in filtered[:25]:
        print(f"  {w:<20}  {c}")
    print()

    # --- Highest-severity (sad) picks with context ---
    print("All severity>=2 picks (the real regrets):")
    for k, grade in graded.items():
        if grade["severity"] < 2:
            continue
        _, _, picks_part = k.split("::")
        variants = find_variants_with_pick(k, picks_part)
        var_list = "|".join(f"{fn.split('-batch_')[-1].replace('.json', '')}/{v}" for fn, v in variants[:3])
        f1, tp, fp, fn = f1_for_pick(k, picks_part)
        print(f"\n  [{k}]")
        print(f"    severity={grade['severity']}  bias={grade.get('keepBias')}  f1={f1:.2f}  tp={tp} fp={fp} fn={fn}")
        print(f"    variants: {var_list}")
        note = grade.get("note", "").replace("\n", " ")
        print(f"    note: \"{note}\"")
    print()

    # --- keepBias bias across variants ---
    print("Per-variant keepBias tally (−1 too few, 0 right, 1 too many):")
    per_var: dict[str, Counter] = defaultdict(Counter)
    for k, grade in graded.items():
        kb = grade.get("keepBias")
        _, _, picks_part = k.split("::")
        variants = find_variants_with_pick(k, picks_part)
        for _fn, var in variants:
            per_var[var][kb] += 1
    print(f"  {'variant':<45}  {'too few':>7}  {'right':>5}  {'too many':>8}  {'null':>4}")
    for var, c in sorted(per_var.items()):
        print(
            f"  {var:<45}  {c[-1]:>7}  {c[0]:>5}  {c[1]:>8}  {c[None]:>4}"
        )


if __name__ == "__main__":
    main()
