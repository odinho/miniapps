#!/usr/bin/env python3
"""Analyze v3 prompt experiments against v1 (Stage A) and v2 (promptv2.json).

Computes, per variant:
  - F1 / precision / recall vs user keeps (aggregate + per-group)
  - Exact-match count (picks == user keeps)
  - Keep-count distribution (how rigidly the model sticks to a count)
  - Avg elapsed time

Compares v3 variants across the three prompt shapes (min / adaptive / priorities)
and against v1 + v2 baselines.

Usage:
  python3 scripts/analyze_promptv3.py
  python3 scripts/analyze_promptv3.py --only qwen   # filter
"""
import argparse
import json
from pathlib import Path
from collections import Counter, defaultdict

DATA_DIR = Path(__file__).parent.parent / "data" / "experiments"
V1 = DATA_DIR / "2026-04-19-stageA.json"
V2 = DATA_DIR / "2026-04-20-promptv2.json"
V3_MIN = DATA_DIR / "2026-04-20-promptv3-min.json"
V3_ADAPTIVE = DATA_DIR / "2026-04-20-promptv3-adaptive.json"
V3_PRIORITIES = DATA_DIR / "2026-04-20-promptv3-priorities.json"


def load(path: Path):
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def metrics(
    picks: list[int], user_keep_idx: set[int], user_cull_idx: set[int]
) -> tuple[float, float, float, int, int, int]:
    """Return (precision, recall, f1, tp, fp, fn).

    Picks on photos the user never decided are EXCLUDED (not counted as FP) so
    partial-coverage groups don't get penalised.
    """
    pick_set = set(picks)
    tp = len(pick_set & user_keep_idx)
    fp = len(pick_set & user_cull_idx)
    fn = len(user_keep_idx - pick_set)
    p = tp / (tp + fp) if (tp + fp) else 0.0
    r = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * p * r / (p + r) if (p + r) else 0.0
    return p, r, f1, tp, fp, fn


def variant_rows(experiment: dict) -> list[tuple[str, dict, dict]]:
    """Yield (variant_name, group, variant_result) for each parseable row."""
    rows = []
    for g in experiment["results"]:
        for v in g["variants"]:
            if v["reason"].startswith(("ERROR", "PARSE")):
                continue
            rows.append((v["variant"], g, v))
    return rows


def analyze(experiment: dict, label: str, filter_substr: str | None) -> dict:
    """Compute per-variant aggregate metrics."""
    per_variant: dict[str, dict] = defaultdict(
        lambda: {
            "n": 0,
            "f1s": [],
            "precisions": [],
            "recalls": [],
            "keep_counts": [],
            "exact_matches": 0,
            "subsets": 0,  # picks ⊂ user
            "supersets": 0,  # picks ⊃ user
            "disjoint": 0,  # no overlap
            "partial": 0,
            "times": [],
            "tp_total": 0,
            "fp_total": 0,
            "fn_total": 0,
        }
    )
    for variant, g, vr in variant_rows(experiment):
        if filter_substr and filter_substr not in variant:
            continue
        group = g["group"]
        user_keep_ids = group.get("userKeepIds", [])
        user_cull_ids = group.get("userCullIds", [])
        if not user_keep_ids:
            continue
        asset_ids = group["assetIds"]
        user_keep_idx = {asset_ids.index(uid) for uid in user_keep_ids if uid in asset_ids}
        user_cull_idx = {asset_ids.index(uid) for uid in user_cull_ids if uid in asset_ids}
        picks = vr["bestPicks"]
        pick_set = set(picks)

        p, r, f1, tp, fp, fn = metrics(picks, user_keep_idx, user_cull_idx)
        d = per_variant[variant]
        d["n"] += 1
        d["f1s"].append(f1)
        d["precisions"].append(p)
        d["recalls"].append(r)
        d["keep_counts"].append(len(picks))
        d["times"].append(vr.get("elapsed", 0))
        d["tp_total"] += tp
        d["fp_total"] += fp
        d["fn_total"] += fn

        if pick_set == user_keep_idx:
            d["exact_matches"] += 1
        elif pick_set < user_keep_idx:
            d["subsets"] += 1
        elif pick_set > user_keep_idx:
            d["supersets"] += 1
        elif pick_set & user_keep_idx:
            d["partial"] += 1
        else:
            d["disjoint"] += 1

    return {"label": label, "per_variant": dict(per_variant)}


def fmt_row(variant: str, d: dict) -> str:
    n = d["n"]
    if not n:
        return f"  {variant}: no data"
    mean_f1 = sum(d["f1s"]) / n
    mean_p = sum(d["precisions"]) / n
    mean_r = sum(d["recalls"]) / n
    mean_k = sum(d["keep_counts"]) / n
    mean_t = sum(d["times"]) / n if d["times"] else 0
    micro_p = d["tp_total"] / (d["tp_total"] + d["fp_total"]) if (d["tp_total"] + d["fp_total"]) else 0
    micro_r = d["tp_total"] / (d["tp_total"] + d["fn_total"]) if (d["tp_total"] + d["fn_total"]) else 0
    micro_f1 = 2 * micro_p * micro_r / (micro_p + micro_r) if (micro_p + micro_r) else 0
    kc = Counter(d["keep_counts"])
    kc_str = " ".join(f"{k}:{v}" for k, v in sorted(kc.items()))
    return (
        f"  {variant:<40} n={n:>3}  "
        f"F1={mean_f1:.2f}(micro={micro_f1:.2f}) P={mean_p:.2f} R={mean_r:.2f}  "
        f"keep={mean_k:.2f} [{kc_str}]  "
        f"exact={d['exact_matches']}/{n}  "
        f"sub={d['subsets']} sup={d['supersets']} part={d['partial']} dis={d['disjoint']}  "
        f"t={mean_t:.1f}s"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="filter variants by substring", default=None)
    args = ap.parse_args()

    experiments = [
        ("v1 (Stage A)", V1),
        ("v2 (keep-2-default)", V2),
        ("v3 min", V3_MIN),
        ("v3 adaptive", V3_ADAPTIVE),
        ("v3 priorities", V3_PRIORITIES),
    ]

    print("=" * 96)
    print("Prompt experiments — per-variant aggregate metrics (vs user keep set)")
    print("=" * 96)
    print("F1/P/R are macro-averaged per group; micro is pooled tp/fp/fn.")
    print("exact=picks match user exactly; sub=picks⊂user; sup=picks⊃user; part=overlap; dis=disjoint.")
    print("keep=[k:n] shows keep-count distribution (e.g. 2:25 means count-2 picks in 25 groups).")
    print()

    all_results = []
    for label, path in experiments:
        exp = load(path)
        if exp is None:
            print(f"[skip] {label}: {path.name} not found")
            continue
        complete = exp.get("completedGroups", len(exp["results"]))
        target = exp.get("targetGroups", len(exp["results"]))
        prompt = exp.get("promptKind", exp.get("promptVersion", "?"))
        print(f"## {label}  [{complete}/{target} groups, prompt={prompt}]")
        analysis = analyze(exp, label, args.only)
        for variant, d in sorted(analysis["per_variant"].items()):
            print(fmt_row(variant, d))
        print()
        all_results.append(analysis)

    # Best-F1 summary
    print("=" * 96)
    print("Top F1 (macro) across all experiments:")
    print("=" * 96)
    flat = []
    for a in all_results:
        for variant, d in a["per_variant"].items():
            if d["n"] >= 5:
                mean_f1 = sum(d["f1s"]) / d["n"]
                flat.append((mean_f1, a["label"], variant, d))
    flat.sort(reverse=True)
    for f1, label, variant, d in flat[:20]:
        mean_k = sum(d["keep_counts"]) / d["n"]
        print(f"  {f1:.3f}  {label:<24}  {variant:<40}  keep={mean_k:.2f}  exact={d['exact_matches']}/{d['n']}")


if __name__ == "__main__":
    main()
