#!/usr/bin/env python3
"""Analyze batch-level prompt experiments.

Computes per-variant F1/precision/recall against user's batch-level keep set,
plus keep-rate distributions, and a batch-by-batch breakdown.

Usage:
  python3 scripts/analyze_batch_experiment.py
  python3 scripts/analyze_batch_experiment.py --file data/experiments/2026-04-20-batch-batch_adaptive.json
"""
import argparse
import glob
import json
from pathlib import Path
from collections import Counter, defaultdict

DATA_DIR = Path(__file__).parent.parent / "data" / "experiments"


def analyze_file(path: Path, print_per_batch: bool = False) -> None:
    with open(path) as f:
        exp = json.load(f)

    prompt = exp.get("promptKind", "?")
    n_complete = exp.get("completedBatches", len(exp["results"]))
    n_target = exp.get("targetBatches", len(exp["results"]))
    print(f"\n{'=' * 96}")
    print(f"{path.name}  [{n_complete}/{n_target} batches, prompt={prompt}]")
    print("=" * 96)

    per_variant: dict[str, dict] = defaultdict(
        lambda: {
            "n": 0,
            "f1s": [],
            "precisions": [],
            "recalls": [],
            "keep_rates": [],  # kept / total
            "keep_counts": [],
            "exact_matches": 0,
            "times": [],
            "tp_total": 0,
            "fp_total": 0,
            "fn_total": 0,
            "user_keep_rates": [],  # parallel array per batch
        }
    )

    per_batch_rows = []
    for r in exp["results"]:
        group = r["group"]
        assets = group["assetIds"]
        user_keep_ids = set(group.get("userKeepIds", []))
        user_cull_ids = set(group.get("userCullIds", []))
        if not user_keep_ids:
            continue
        user_keep_idx = {assets.index(uid) for uid in user_keep_ids if uid in assets}
        user_cull_idx = {assets.index(uid) for uid in user_cull_ids if uid in assets}
        user_keep_rate = len(user_keep_idx) / len(assets)

        row = {"batch": group["batchId"], "n": len(assets), "user_keep": len(user_keep_idx)}
        for v in r["variants"]:
            if v["reason"].startswith(("ERROR", "PARSE")):
                continue
            picks = set(v["bestPicks"])
            tp = len(picks & user_keep_idx)
            fp = len(picks & user_cull_idx)  # excludes picks on undecided photos
            fn = len(user_keep_idx - picks)
            p = tp / (tp + fp) if (tp + fp) else 0.0
            rc = tp / (tp + fn) if (tp + fn) else 0.0
            f1 = 2 * p * rc / (p + rc) if (p + rc) else 0.0

            d = per_variant[v["variant"]]
            d["n"] += 1
            d["f1s"].append(f1)
            d["precisions"].append(p)
            d["recalls"].append(rc)
            d["keep_rates"].append(len(picks) / len(assets))
            d["keep_counts"].append(len(picks))
            d["times"].append(v.get("elapsed", 0))
            d["tp_total"] += tp
            d["fp_total"] += fp
            d["fn_total"] += fn
            d["user_keep_rates"].append(user_keep_rate)
            if picks == user_keep_idx:
                d["exact_matches"] += 1
            row[v["variant"]] = f"{len(picks):>2} F1={f1:.2f}"
        per_batch_rows.append(row)

    # Summary table
    print(f"\n{'variant':<42}  {'n':>3}  {'F1':>5}  {'micro':>5}  {'P':>5}  {'R':>5}  {'keep%':>6}  {'user%':>6}  {'exact':>6}  {'time':>6}")
    for variant, d in sorted(per_variant.items()):
        n = d["n"]
        if not n:
            continue
        mean_f1 = sum(d["f1s"]) / n
        mean_p = sum(d["precisions"]) / n
        mean_r = sum(d["recalls"]) / n
        mean_kr = sum(d["keep_rates"]) / n
        mean_ukr = sum(d["user_keep_rates"]) / n
        mean_t = sum(d["times"]) / n if d["times"] else 0
        micro_p = d["tp_total"] / (d["tp_total"] + d["fp_total"]) if (d["tp_total"] + d["fp_total"]) else 0
        micro_r = d["tp_total"] / (d["tp_total"] + d["fn_total"]) if (d["tp_total"] + d["fn_total"]) else 0
        micro_f1 = 2 * micro_p * micro_r / (micro_p + micro_r) if (micro_p + micro_r) else 0
        print(
            f"{variant:<42}  {n:>3}  "
            f"{mean_f1:.3f}  {micro_f1:.3f}  {mean_p:.3f}  {mean_r:.3f}  "
            f"{mean_kr * 100:5.1f}%  {mean_ukr * 100:5.1f}%  "
            f"{d['exact_matches']:>3}/{n:<3}  {mean_t:5.1f}s"
        )

    if print_per_batch and per_batch_rows:
        print("\nPer-batch:")
        variants = sorted({k for row in per_batch_rows for k in row if k not in ("batch", "n", "user_keep")})
        hdr = f"{'batch':<34} {'n':>3} {'uk':>3}  " + "  ".join(f"{v:<16}" for v in variants)
        print(hdr)
        for row in per_batch_rows:
            cells = "  ".join(f"{row.get(v, '-'):<16}" for v in variants)
            print(f"{row['batch']:<34} {row['n']:>3} {row['user_keep']:>3}  {cells}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", help="single file", default=None)
    ap.add_argument("--per-batch", action="store_true")
    args = ap.parse_args()

    if args.file:
        analyze_file(Path(args.file), args.per_batch)
    else:
        files = sorted(
            p for p in DATA_DIR.glob("2026-04-20-batch-*.json")
            if not p.name.endswith("-grades.json")
        )
        if not files:
            print("No batch experiment files found.")
            return
        for p in files:
            analyze_file(p, args.per_batch)


if __name__ == "__main__":
    main()
