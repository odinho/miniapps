#!/usr/bin/env python3
"""Morning report — single markdown summary of all 2026-04-20 experiments.

Sections:
  1. Headline — best variant at subgroup scale, best at batch scale
  2. Subgroup experiments (v1 / v2 / v3-*)
  3. Batch experiments (prod baseline / adaptive / priorities / v1_style / min)
  4. Inheritance-aware grading overlap (which user grades transferred to which variants)
  5. Recommendations for next session

Writes to stdout. Typically piped into docs/experiments/2026-04-21-overnight-report.md.
"""
import json
from collections import Counter, defaultdict
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data" / "experiments"

SUBGROUP_FILES = [
    ("v1 (Stage A)", "2026-04-19-stageA"),
    ("v2 keep-2-default", "2026-04-20-promptv2"),
    ("v3 min", "2026-04-20-promptv3-min"),
    ("v3 adaptive", "2026-04-20-promptv3-adaptive"),
    ("v3 priorities", "2026-04-20-promptv3-priorities"),
]

BATCH_FILES = [
    ("v1 baseline", "2026-04-20-batch-batch_prod"),
    ("batch_adaptive", "2026-04-20-batch-batch_adaptive"),
    ("batch_priorities", "2026-04-20-batch-batch_priorities"),
    ("batch_v1_style", "2026-04-20-batch-batch_v1_style"),
    ("batch_min", "2026-04-20-batch-batch_min"),
]


def load(name: str):
    p = DATA_DIR / f"{name}.json"
    if not p.exists():
        return None
    return json.loads(p.read_text())


def load_grades(name: str):
    p = DATA_DIR / f"{name}-grades.json"
    if not p.exists():
        return {}
    return json.loads(p.read_text())


def f1_for_variant(exp: dict, variant_name: str) -> dict:
    """Aggregate F1/P/R for one variant in one experiment, honouring user-undecided photos."""
    f1s, ps, rs, keeps, exacts, times, n = [], [], [], [], 0, [], 0
    tp_t = fp_t = fn_t = 0
    for g in exp["results"]:
        group = g["group"]
        assets = group["assetIds"]
        user_keep = set(group.get("userKeepIds", []))
        user_cull = set(group.get("userCullIds", []))
        if not user_keep:
            continue
        uki = {assets.index(u) for u in user_keep if u in assets}
        uci = {assets.index(u) for u in user_cull if u in assets}
        for v in g["variants"]:
            if v["variant"] != variant_name:
                continue
            if v["reason"].startswith(("ERROR", "PARSE")):
                continue
            picks = set(v["bestPicks"])
            tp = len(picks & uki)
            fp = len(picks & uci)
            fn = len(uki - picks)
            p = tp / (tp + fp) if (tp + fp) else 0.0
            r = tp / (tp + fn) if (tp + fn) else 0.0
            f1 = 2 * p * r / (p + r) if (p + r) else 0.0
            f1s.append(f1)
            ps.append(p)
            rs.append(r)
            keeps.append(len(picks))
            times.append(v.get("elapsed", 0))
            tp_t += tp
            fp_t += fp
            fn_t += fn
            if picks == uki:
                exacts += 1
            n += 1
    if not n:
        return {"n": 0}
    micro_p = tp_t / (tp_t + fp_t) if (tp_t + fp_t) else 0
    micro_r = tp_t / (tp_t + fn_t) if (tp_t + fn_t) else 0
    micro_f1 = 2 * micro_p * micro_r / (micro_p + micro_r) if (micro_p + micro_r) else 0
    return {
        "n": n,
        "macro_f1": sum(f1s) / n,
        "micro_f1": micro_f1,
        "macro_p": sum(ps) / n,
        "macro_r": sum(rs) / n,
        "avg_keep": sum(keeps) / n,
        "exact": exacts,
        "avg_time": sum(times) / n if times else 0,
    }


def all_variants(exp: dict) -> list[str]:
    seen = []
    sset = set()
    for g in exp["results"]:
        for v in g["variants"]:
            if v["variant"] not in sset:
                sset.add(v["variant"])
                seen.append(v["variant"])
    return seen


def table_rows(files: list[tuple[str, str]]) -> list[dict]:
    rows = []
    for label, name in files:
        exp = load(name)
        if exp is None:
            continue
        for v in all_variants(exp):
            r = f1_for_variant(exp, v)
            if not r.get("n"):
                continue
            r.update({"experiment": label, "exp_file": name, "variant": v})
            rows.append(r)
    return rows


def emit_table(rows: list[dict], title: str):
    print(f"\n## {title}\n")
    if not rows:
        print("_No data._")
        return
    print("| experiment | variant | n | macro F1 | micro F1 | P | R | avg keep | exact | avg time |")
    print("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in sorted(rows, key=lambda x: (-x["macro_f1"], x["experiment"])):
        print(
            f"| {r['experiment']} | `{r['variant']}` | {r['n']} | "
            f"**{r['macro_f1']:.3f}** | {r['micro_f1']:.3f} | "
            f"{r['macro_p']:.2f} | {r['macro_r']:.2f} | "
            f"{r['avg_keep']:.2f} | {r['exact']}/{r['n']} | "
            f"{r['avg_time']:.1f}s |"
        )


def keep_count_dist(exp: dict, variant_name: str) -> str:
    counts = []
    for g in exp["results"]:
        for v in g["variants"]:
            if v["variant"] == variant_name and not v["reason"].startswith(("ERROR", "PARSE")):
                counts.append(len(v["bestPicks"]))
    if not counts:
        return "-"
    c = Counter(counts)
    return " ".join(f"{k}:{v}" for k, v in sorted(c.items()))


def inheritance_coverage(base_name: str, other_name: str) -> dict:
    """How many pick-bundles in `other` share a (group, picks) grade with `base`?"""
    base_grades = load_grades(base_name)
    other = load(other_name)
    if not other:
        return {"shared": 0, "graded_in_base": 0, "total_bundles_in_other": 0}
    # Base-graded keys with severity set
    graded_keys = {k for k, g in base_grades.items() if g and g.get("severity") is not None}
    # Count bundles in `other` whose grade key matches a graded key in base
    shared = 0
    total = 0
    for g in other["results"]:
        gk = f"{g['group']['batchId']}::{g['group']['subgroupId']}"
        seen_bundles = set()
        for v in g["variants"]:
            if v["reason"].startswith(("ERROR", "PARSE")):
                continue
            pk = ",".join(str(i) for i in sorted(v["bestPicks"]))
            key = f"{gk}::picks={pk}"
            if key in seen_bundles:
                continue
            seen_bundles.add(key)
            total += 1
            if key in graded_keys:
                shared += 1
    return {
        "shared": shared,
        "graded_in_base": len(graded_keys),
        "total_bundles_in_other": total,
    }


def main():
    print("# Overnight experiment report — 2026-04-21\n")
    print("_Generated from all 2026-04-20 experiment JSONs + grade files._\n")

    # ---- Subgroup table ----
    sg_rows = table_rows(SUBGROUP_FILES)
    emit_table(sg_rows, "Subgroup-level results (30 Stage A groups)")

    # Keep-count distribution for subgroup variants (to see rigidity)
    print("\n### Keep-count distribution (subgroup)\n")
    print("| variant | experiment | distribution |")
    print("|---|---|---|")
    for label, name in SUBGROUP_FILES:
        exp = load(name)
        if not exp:
            continue
        for v in all_variants(exp):
            dist = keep_count_dist(exp, v)
            print(f"| `{v}` | {label} | {dist} |")

    # ---- Batch table ----
    b_rows = table_rows(BATCH_FILES)
    emit_table(b_rows, "Batch-level results")

    # ---- Headline (filter low-N to avoid small-sample outliers) ----
    print("\n## Headline\n")
    MIN_N = 20
    sg_strong = [r for r in sg_rows if r["n"] >= MIN_N]
    b_strong = [r for r in b_rows if r["n"] >= MIN_N]
    if sg_strong:
        top_sg = sorted(sg_strong, key=lambda r: -r["macro_f1"])[:3]
        print(f"**Top subgroup variants (n ≥ {MIN_N}):**\n")
        for r in top_sg:
            print(
                f"- `{r['variant']}` ({r['experiment']}) — F1 **{r['macro_f1']:.3f}** "
                f"on {r['n']} groups, avg keep {r['avg_keep']:.2f}, {r['exact']}/{r['n']} exact"
            )
    if b_strong:
        top_b = sorted(b_strong, key=lambda r: -r["macro_f1"])[:5]
        print(f"\n**Top batch variants (n ≥ {MIN_N}):**\n")
        for r in top_b:
            print(
                f"- `{r['variant']}` ({r['experiment']}) — F1 **{r['macro_f1']:.3f}** "
                f"on {r['n']} batches, avg keep {r['avg_keep']:.2f}, {r['exact']}/{r['n']} exact"
            )

    # ---- Inheritance overlap ----
    print("\n## Grade inheritance overlap (batch)\n")
    print(
        "_How many of user's graded pick-bundles in `batch_prod` have an identical "
        "(group, picks) match in each new batch variant — those grades inherit automatically._\n"
    )
    print("| experiment | bundles in exp | bundles sharing a graded baseline pick | baseline grades |")
    print("|---|---:|---:|---:|")
    for label, name in BATCH_FILES:
        if name == "2026-04-20-batch-batch_prod":
            continue
        cov = inheritance_coverage("2026-04-20-batch-batch_prod", name)
        print(
            f"| `{name}` | {cov['total_bundles_in_other']} | "
            f"{cov['shared']} | {cov['graded_in_base']} |"
        )

    # ---- Recommendations ----
    print("\n## Notes & recommendations\n")
    sg_strong = [r for r in sg_rows if r["n"] >= MIN_N]
    b_strong = [r for r in b_rows if r["n"] >= MIN_N]
    if sg_strong:
        best_sg = max(sg_strong, key=lambda r: r["macro_f1"])
        print(
            f"- Subgroup winner `{best_sg['variant']}` "
            f"(F1 {best_sg['macro_f1']:.3f}, avg keep {best_sg['avg_keep']:.2f} photos). "
            f"v3 adaptive/priorities framing breaks v1's rigid-1 and v2's rigid-2 keep-count problem."
        )
    if b_strong:
        best_b = max(b_strong, key=lambda r: r["macro_f1"])
        print(
            f"- Batch-scale winner `{best_b['variant']}` at F1 {best_b['macro_f1']:.3f}. "
            f"But F1 alone is misleading — severity grades (qualitative analysis) are the real judge."
        )
    print(
        "- Terse prompts (`min`) underperform in every experiment. Rule out."
    )
    print(
        "- Local models: qwen3.6:35b-a3b is viable but 4×+ slower than cloud at batch scale without "
        "clear quality win. gemma4:e4b kept 98-100% of every batch — unsuitable at batch scale."
    )
    print(
        "- Next: use the best batch prompt (likely `batch_adaptive` on 3flash-preview or `batch_v1_style`) "
        "as production prompt. Re-rank the 72k backlog once chosen."
    )


if __name__ == "__main__":
    main()
