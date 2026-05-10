#!/usr/bin/env python3
"""Deep analysis of graded experiment data.

Reads experiment JSONs and their corresponding grades files, computes:
  - per-variant severity distribution (using pick-based grade inheritance)
  - per-variant keep-bias distribution
  - correlation between binary user-match and severity
  - agreement clusters (which variants tend to pick the same thing)
  - notes extraction for qualitative patterns
  - excluded-group audit

Usage:
  python3 scripts/analyze_graded_experiment.py > docs/experiments/grade-analysis.md
"""
import json
import sys
from collections import defaultdict, Counter
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data" / "experiments"
EXPERIMENTS = ["2026-04-19-stageA", "2026-04-19-stageB4"]

SEVERITY_LABELS = ["perfect", "fine", "meh", "sad", "😢"]

def pick_key_of(best_picks):
    return ",".join(str(i) for i in sorted(best_picks))

def grade_key(group_key, pick_key):
    return f"{group_key}::picks={pick_key}"

def group_key_of(group):
    return f"{group['batchId']}::{group['subgroupId']}"

def is_gradable(v):
    if v["reason"].startswith("ERROR") or v["reason"].startswith("PARSE"):
        return False
    if not v["bestPicks"]:
        return False
    return True

def mean(xs):
    return sum(xs) / len(xs) if xs else None

def fmt_dist(xs, n_levels=5):
    """Return a small bar chart like `■□□□□ 0=1 1=3 2=0`."""
    counts = Counter(xs)
    total = len(xs)
    parts = []
    for i in range(n_levels):
        parts.append(f"{i}={counts.get(i, 0)}")
    return f"{total} grades: " + " ".join(parts)

def load(exp_id):
    with open(DATA_DIR / f"{exp_id}.json") as f:
        exp = json.load(f)
    grades_path = DATA_DIR / f"{exp_id}-grades.json"
    grades = {}
    if grades_path.exists():
        with open(grades_path) as f:
            grades = json.load(f)
    return exp, grades

def analyze_experiment(exp_id):
    exp, grades = load(exp_id)
    results = exp["results"]

    print(f"## Experiment: `{exp_id}`")
    print()
    print(f"Groups: **{len(results)}**")

    # Excluded groups
    excluded = []
    for g in results:
        gk = group_key_of(g["group"])
        if grades.get(f"{gk}::picks=__excluded__"):
            excluded.append(gk)
    print(f"Excluded: **{len(excluded)}**")
    if excluded:
        for e in excluded:
            print(f"- `{e}`")
    print()

    scored = [g for g in results if group_key_of(g["group"]) not in set(excluded)]
    print(f"Scored (counted in stats): **{len(scored)}**")
    print()

    # Per-variant rollup
    variants = sorted({v["variant"] for g in results for v in g["variants"]})

    print("### Per-variant scorecard")
    print()
    print(f"| variant | gradable | user ✓ | user ✓% | graded | avg sev | bias dist | sev dist |")
    print(f"|---|---|---|---|---|---|---|---|")
    per_variant = {}
    for vname in variants:
        gradable = 0
        user_match = 0
        sevs = []
        biases = []
        for g in scored:
            gk = group_key_of(g["group"])
            for v in g["variants"]:
                if v["variant"] != vname:
                    continue
                if not is_gradable(v):
                    continue
                gradable += 1
                if v["matchesUser"]:
                    user_match += 1
                pk = pick_key_of(v["bestPicks"])
                gr = grades.get(grade_key(gk, pk))
                if gr and gr.get("severity") is not None:
                    sevs.append(gr["severity"])
                if gr and gr.get("keepBias") is not None:
                    biases.append(gr["keepBias"])
        per_variant[vname] = {
            "gradable": gradable,
            "user_match": user_match,
            "sevs": sevs,
            "biases": biases,
        }
        um_pct = (100 * user_match / gradable) if gradable else 0
        bias_dist = Counter(biases)
        bias_str = f"-:{bias_dist.get(-1,0)} 0:{bias_dist.get(0,0)} +:{bias_dist.get(1,0)}"
        sev_dist = Counter(sevs)
        sev_str = " ".join(f"{i}:{sev_dist.get(i,0)}" for i in range(5))
        avg_sev = mean(sevs)
        avg_sev_str = f"{avg_sev:.2f}" if avg_sev is not None else "-"
        print(f"| {vname} | {gradable} | {user_match} | {um_pct:.0f}% | {len(sevs)} | {avg_sev_str} | {bias_str} | {sev_str} |")
    print()

    # Severity vs user-match cross-tab
    print("### Severity vs binary user-match")
    print()
    print("User ✗ (binary) doesn't mean the pick was bad — grading reveals nuance.")
    print()
    print(f"| variant | ✓ avg sev | ✗ avg sev | ✓ sev dist | ✗ sev dist |")
    print(f"|---|---|---|---|---|")
    for vname in variants:
        match_sevs = []
        nomatch_sevs = []
        for g in scored:
            gk = group_key_of(g["group"])
            for v in g["variants"]:
                if v["variant"] != vname or not is_gradable(v):
                    continue
                pk = pick_key_of(v["bestPicks"])
                gr = grades.get(grade_key(gk, pk))
                if not gr or gr.get("severity") is None:
                    continue
                (match_sevs if v["matchesUser"] else nomatch_sevs).append(gr["severity"])
        mm = mean(match_sevs)
        mn = mean(nomatch_sevs)
        def d(xs):
            c = Counter(xs)
            return " ".join(f"{i}:{c.get(i,0)}" for i in range(5))
        print(f"| {vname} | {f'{mm:.2f}' if mm is not None else '-'} ({len(match_sevs)}) | {f'{mn:.2f}' if mn is not None else '-'} ({len(nomatch_sevs)}) | {d(match_sevs)} | {d(nomatch_sevs)} |")
    print()

    # Agreement clusters: which variant pairs pick identically most often?
    print("### Variant agreement")
    print()
    print("How often each pair of variants chose the same set of photos (same pickKey):")
    print()
    pairs = defaultdict(lambda: {"agree": 0, "both_gradable": 0})
    for g in scored:
        by_pick = defaultdict(list)
        for v in g["variants"]:
            if is_gradable(v):
                by_pick[pick_key_of(v["bestPicks"])].append(v["variant"])
        for i, a in enumerate(variants):
            for b in variants[i + 1:]:
                a_gradable = any(v["variant"] == a and is_gradable(v) for v in g["variants"])
                b_gradable = any(v["variant"] == b and is_gradable(v) for v in g["variants"])
                if not (a_gradable and b_gradable):
                    continue
                pairs[(a, b)]["both_gradable"] += 1
                same = any(a in vs and b in vs for vs in by_pick.values())
                if same:
                    pairs[(a, b)]["agree"] += 1
    for (a, b), s in sorted(pairs.items(), key=lambda kv: -kv[1]["agree"]):
        if s["both_gradable"] == 0:
            continue
        print(f"- **{a}** ↔ **{b}**: {s['agree']}/{s['both_gradable']} ({100 * s['agree'] / s['both_gradable']:.0f}%)")
    print()

    # Notes extraction
    print("### Notes (verbatim)")
    print()
    by_note = []
    for k, v in grades.items():
        if v.get("note") and v["note"].strip() and v["note"] != "excluded":
            by_note.append((k, v["note"]))
    if not by_note:
        print("_(none)_")
    else:
        for k, note in by_note:
            print(f"- `{k}`: {note}")
    print()

    return per_variant, scored

def main():
    print(f"# Graded experiment analysis — 2026-04-19 overnight")
    print()
    print("Generated by `scripts/analyze_graded_experiment.py`.")
    print()
    print("Severity scale: 0=perfect, 1=fine, 2=meh, 3=sad, 4=😢")
    print()
    print("Keep-bias: -1=too few, 0=right, 1=too many")
    print()

    all_per_variant = {}
    for eid in EXPERIMENTS:
        pv, _ = analyze_experiment(eid)
        for k, v in pv.items():
            if k not in all_per_variant:
                all_per_variant[k] = {"gradable": 0, "user_match": 0, "sevs": [], "biases": []}
            for f in ("gradable", "user_match"):
                all_per_variant[k][f] += v[f]
            all_per_variant[k]["sevs"].extend(v["sevs"])
            all_per_variant[k]["biases"].extend(v["biases"])

    # Cross-experiment summary
    print("## Pooled across both experiments")
    print()
    print(f"| variant | gradable | user ✓% | avg sev | avg bias |")
    print(f"|---|---|---|---|---|")
    for vname in sorted(all_per_variant.keys()):
        v = all_per_variant[vname]
        um_pct = (100 * v["user_match"] / v["gradable"]) if v["gradable"] else 0
        sevs = v["sevs"]
        biases = v["biases"]
        avg_sev = mean(sevs)
        avg_bias = mean(biases)
        sev_str = f"{avg_sev:.2f}" if avg_sev is not None else "-"
        bias_str = f"{avg_bias:+.2f}" if avg_bias is not None else "-"
        print(f"| {vname} | {v['gradable']} | {um_pct:.0f}% | {sev_str} (n={len(sevs)}) | {bias_str} (n={len(biases)}) |")
    print()

    # Grade-weighted recommendation
    print("## Grade-weighted interpretation")
    print()
    print("Lower avg severity = closer to what you'd have picked yourself.")
    print("Ranking by avg severity (lower = better):")
    print()
    ranked = sorted(
        ((k, mean(v["sevs"]), len(v["sevs"])) for k, v in all_per_variant.items() if v["sevs"]),
        key=lambda x: x[1]
    )
    for k, s, n in ranked:
        stars = "■" * round(5 - s) + "□" * round(s)
        print(f"- **{k}** · {s:.2f} ({n} grades) · {stars}")
    print()

if __name__ == "__main__":
    main()
