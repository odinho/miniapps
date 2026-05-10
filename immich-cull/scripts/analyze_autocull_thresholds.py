#!/usr/bin/env python3
"""
Exhaustive auto-cull threshold analysis — reads from cached data.

Run extract_autocull_data.py first (needs server), then this script
can iterate instantly on 100+ strategies without the server.

Tests single-model strategies, multi-model ensembles, category-specific
rules, and compound strategies. Reports wrong-cull rate, coverage, and
wrong-cull severity (borderline vs truly bad).

Usage:
    python3 scripts/extract_autocull_data.py          # once, needs server
    python3 scripts/extract_autocull_data.py --all-models  # for ensemble strategies

    python3 scripts/analyze_autocull_thresholds.py           # default analysis
    python3 scripts/analyze_autocull_thresholds.py --top 50  # more results
    python3 scripts/analyze_autocull_thresholds.py --verbose # show wrong culls
    python3 scripts/analyze_autocull_thresholds.py --model gemini-3.1-flash-lite-preview
"""

import json
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
from argparse import ArgumentParser

CACHE_PATH = Path(__file__).resolve().parent.parent / "data" / "autocull_analysis_cache.json"
DB_PATH = Path(__file__).resolve().parent.parent / "data" / "state.db"


def load_cache():
    if not CACHE_PATH.exists():
        print(f"Cache not found at {CACHE_PATH}", file=sys.stderr)
        print("Run first: python3 scripts/extract_autocull_data.py", file=sys.stderr)
        sys.exit(1)
    return json.loads(CACHE_PATH.read_text())


def load_user_stars():
    """Load user_stars from DB for wrong-cull severity analysis."""
    if not DB_PATH.exists():
        return {}
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    stars = {}
    for row in conn.execute("SELECT asset_id, user_stars FROM photo_decisions WHERE user_stars IS NOT NULL"):
        stars[row["asset_id"]] = row["user_stars"]
    conn.close()
    return stars


def build_single_model_strategies():
    """Build single-model strategy grid."""
    strategies = []

    # ===== S1-S10: Core single-model strategies =====
    strategies.append(("S1: All LLM culls", lambda r: True))
    strategies.append(("S2: stars=0", lambda r: r["stars"] == 0))
    strategies.append(("S3: stars=0 + in_sg", lambda r: r["stars"] == 0 and r["in_subgroup"]))
    strategies.append(("S4: stars=0 + sg_keeper", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"]))
    strategies.append(("S5: S4 + burst/dup only", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_type"] in ("burst", "near_duplicate")))
    strategies.append(("S6: S4 + conf>=0.8", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and (r["sg_confidence"] or 0) >= 0.8))
    strategies.append(("S7: S4 + conf>=0.9", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and (r["sg_confidence"] or 0) >= 0.9))
    strategies.append(("S8: stars<=1 + sg_keeper", lambda r: r["stars"] <= 1 and r["in_subgroup"] and r["sg_has_keeper"]))
    strategies.append(("S9: S4 + no people cats", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["category"] not in ("portrait", "group_portrait", "selfie", "event")))
    strategies.append(("S10: S4 + not best in sg", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_rank"] > 0))

    # ===== Size variations =====
    strategies.append(("S4+sz>=3", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_size"] >= 3))
    strategies.append(("S4+sz>=4", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_size"] >= 4))
    strategies.append(("S4+sz>=5", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_size"] >= 5))

    # ===== Rank position variations =====
    strategies.append(("S4+bottom_half", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_rank_frac"] >= 0.5))
    strategies.append(("S4+bottom_third", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_rank_frac"] >= 0.67))

    # ===== Star deficit variations =====
    strategies.append(("S4+deficit>=1", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["star_deficit"] >= 1))
    strategies.append(("S4+deficit>=2", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["star_deficit"] >= 2))
    strategies.append(("S4+keeper>=1star", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["max_keeper_stars"] >= 1))
    strategies.append(("S4+keeper>=2star", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["max_keeper_stars"] >= 2))

    # ===== Subgroup type variations =====
    strategies.append(("S4+not_subject", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_type"] != "same_subject"))
    strategies.append(("S4+burst_only", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_type"] == "burst"))

    # ===== Multi-dimension tightening =====
    strategies.append(("S5+conf>=0.8", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_type"] in ("burst", "near_duplicate") and (r["sg_confidence"] or 0) >= 0.8))
    strategies.append(("S5+conf>=0.9", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_type"] in ("burst", "near_duplicate") and (r["sg_confidence"] or 0) >= 0.9))
    strategies.append(("S5+not_best", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_type"] in ("burst", "near_duplicate") and r["sg_rank"] > 0))
    strategies.append(("S10+conf>=0.8", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_rank"] > 0 and (r["sg_confidence"] or 0) >= 0.8))
    strategies.append(("S10+sz>=3", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_rank"] > 0 and r["sg_size"] >= 3))
    strategies.append(("S10+deficit>=1", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_rank"] > 0 and r["star_deficit"] >= 1))
    strategies.append(("S6+not_best", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and (r["sg_confidence"] or 0) >= 0.8 and r["sg_rank"] > 0))
    strategies.append(("S6+sz>=3+not_best", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and (r["sg_confidence"] or 0) >= 0.8 and r["sg_rank"] > 0 and r["sg_size"] >= 3))
    strategies.append(("S5+sz>=3+not_best", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_type"] in ("burst", "near_duplicate") and r["sg_rank"] > 0 and r["sg_size"] >= 3))
    strategies.append(("S5+conf>=0.8+not_best", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_type"] in ("burst", "near_duplicate") and (r["sg_confidence"] or 0) >= 0.8 and r["sg_rank"] > 0))

    # ===== Max safety triple-tightened =====
    strategies.append(("S5+conf>=0.9+not_best", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_type"] in ("burst", "near_duplicate") and (r["sg_confidence"] or 0) >= 0.9 and r["sg_rank"] > 0))
    strategies.append(("S5+sz>=3+conf>=0.8+not_best", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_type"] in ("burst", "near_duplicate") and r["sg_size"] >= 3 and (r["sg_confidence"] or 0) >= 0.8 and r["sg_rank"] > 0))
    strategies.append(("S4+sz>=3+conf>=0.8+not_best", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["sg_size"] >= 3 and (r["sg_confidence"] or 0) >= 0.8 and r["sg_rank"] > 0))

    # ===== Category-specific =====
    for cat in ["action", "portrait", "group_portrait", "landscape", "travel",
                "event", "screenshot", "snapchat_save", "pet", "food", "vehicle"]:
        strategies.append((
            f"cat={cat}: S4",
            lambda r, _c=cat: r["category"] == _c and r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"],
        ))

    # ===== Category exclusion combos =====
    strategies.append(("S4+no_snap_ss", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["category"] not in ("snapchat_save", "screenshot")))
    strategies.append(("S4+no_portrait", lambda r: r["stars"] == 0 and r["in_subgroup"] and r["sg_has_keeper"] and r["category"] not in ("portrait", "group_portrait", "selfie")))

    return strategies


def build_multi_model_strategies(records_by_model):
    """Build ensemble strategies comparing across models."""
    strategies = []

    models = sorted(records_by_model.keys())
    if len(models) < 2:
        return strategies

    # Build per-(batch_id, asset_id) lookup across models
    photo_models = defaultdict(dict)  # (batch_id, asset_id) -> {model: record}
    for model, records in records_by_model.items():
        for r in records:
            key = (r["batch_id"], r["asset_id"])
            photo_models[key][model] = r

    # Only consider photos with data from multiple models
    multi = {k: v for k, v in photo_models.items() if len(v) >= 2}

    if not multi:
        return strategies

    # M1: All models agree on cull
    def m1_pred(r):
        key = (r["batch_id"], r["asset_id"])
        if key not in multi:
            return False
        return all(m_r["llm_decision"] == "cull" for m_r in multi[key].values())

    strategies.append(("M1: All models agree cull", m1_pred))

    # M2: Majority agree on cull
    def m2_pred(r):
        key = (r["batch_id"], r["asset_id"])
        if key not in multi:
            return False
        votes = multi[key]
        cull_count = sum(1 for m_r in votes.values() if m_r["llm_decision"] == "cull")
        return cull_count >= len(votes) * 2 / 3

    strategies.append(("M2: Majority (>=2/3) agree cull", m2_pred))

    # M5: Any model says keep → veto auto-cull
    def m5_pred(r):
        key = (r["batch_id"], r["asset_id"])
        if key not in multi:
            return False
        return all(m_r["llm_decision"] == "cull" for m_r in multi[key].values())

    strategies.append(("M5: No model veto (all say cull)", m5_pred))

    # M1 + S4 criteria
    def m1_s4_pred(r):
        key = (r["batch_id"], r["asset_id"])
        if key not in multi:
            return False
        # All models agree on cull AND stars=0 + sg_keeper on at least one model's view
        all_cull = all(m_r["llm_decision"] == "cull" for m_r in multi[key].values())
        any_s4 = any(
            m_r["stars"] == 0 and m_r["in_subgroup"] and m_r["sg_has_keeper"]
            for m_r in multi[key].values()
        )
        return all_cull and any_s4

    strategies.append(("M1+S4: All agree cull + any S4", m1_s4_pred))

    # M4: Best model cull + any other confirms + both stars=0
    best_model = None
    for m in models:
        if "3.1-flash-lite" in m:
            best_model = m
            break
    if not best_model:
        best_model = models[0]

    def m4_pred(r):
        key = (r["batch_id"], r["asset_id"])
        if key not in multi or best_model not in multi[key]:
            return False
        best_r = multi[key][best_model]
        if best_r["llm_decision"] != "cull" or best_r["stars"] != 0:
            return False
        # Any other model also says cull + stars=0
        for m, m_r in multi[key].items():
            if m == best_model:
                continue
            if m_r["llm_decision"] == "cull" and m_r["stars"] == 0:
                return True
        return False

    strategies.append((f"M4: Best+other cull, both stars=0", m4_pred))

    # M6: Best model + gemma4 agree (cheap second opinion)
    gemma_model = None
    for m in models:
        if "gemma" in m.lower():
            gemma_model = m
            break

    if gemma_model and gemma_model != best_model:
        def m6_pred(r):
            key = (r["batch_id"], r["asset_id"])
            if key not in multi:
                return False
            if best_model not in multi[key] or gemma_model not in multi[key]:
                return False
            return (multi[key][best_model]["llm_decision"] == "cull" and
                    multi[key][gemma_model]["llm_decision"] == "cull")

        strategies.append((f"M6: Best + Gemma4 agree cull", m6_pred))

        def m6_s4_pred(r):
            key = (r["batch_id"], r["asset_id"])
            if key not in multi:
                return False
            if best_model not in multi[key] or gemma_model not in multi[key]:
                return False
            best_r = multi[key][best_model]
            return (best_r["llm_decision"] == "cull" and best_r["stars"] == 0 and
                    best_r["in_subgroup"] and best_r["sg_has_keeper"] and
                    multi[key][gemma_model]["llm_decision"] == "cull")

        strategies.append((f"M6+S4: Best+Gemma cull, S4 criteria", m6_s4_pred))

    return strategies


def evaluate_strategy(label, pred, cull_records, max_correct, user_stars):
    """Evaluate a strategy against cull records."""
    matching = [r for r in cull_records if pred(r)]
    if not matching:
        return None

    wrong = [r for r in matching if r["user_decision"] == "keep"]
    correct = [r for r in matching if r["user_decision"] == "cull"]
    total = len(matching)
    wrong_count = len(wrong)
    wrong_rate = wrong_count / total * 100 if total else 0
    coverage = len(correct) / max_correct * 100 if max_correct else 0

    # Wrong-cull severity: check user_stars for wrong culls
    severe_wrong = 0  # user starred this photo (they really care)
    borderline_wrong = 0  # user kept it but no stars (might be OK to cull)
    for r in wrong:
        us = user_stars.get(r["asset_id"])
        if us and us > 0:
            severe_wrong += 1
        else:
            borderline_wrong += 1

    # Composite score: coverage * (1 - wrong_rate/100), penalize severe wrong culls
    severity_penalty = severe_wrong * 0.02  # each severe wrong reduces score by 2%
    score = (coverage / 100) * (1 - wrong_rate / 100) - severity_penalty

    return {
        "label": label, "total": total, "correct": len(correct),
        "wrong": wrong_count, "wrong_rate": wrong_rate, "coverage": coverage,
        "severe_wrong": severe_wrong, "borderline_wrong": borderline_wrong,
        "score": score,
        "wrong_records": wrong, "correct_records": correct,
    }


def main():
    parser = ArgumentParser(description="Exhaustive auto-cull threshold analysis (reads from cache)")
    parser.add_argument("--top", type=int, default=30, help="Show top N strategies")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show individual wrong culls")
    parser.add_argument("--min-coverage", type=float, default=10, help="Min coverage %% for ranking")
    parser.add_argument("--model", default=None, help="Filter to specific model")
    args = parser.parse_args()

    cache = load_cache()
    user_stars = load_user_stars()
    all_records = cache["records"]

    print(f"Loaded {len(all_records)} records from cache ({cache['extracted_at']})")
    print(f"Models: {', '.join(cache['models'])}")
    print(f"User decisions: {cache['user_decisions']['total']} "
          f"({cache['user_decisions']['keep']} keep, {cache['user_decisions']['cull']} cull)")
    print(f"User star ratings available: {len(user_stars)}")
    print()

    # Filter by model if requested
    if args.model:
        all_records = [r for r in all_records if r["model"] == args.model]
        print(f"Filtered to model: {args.model} ({len(all_records)} records)")
        print()

    # Split
    cull_records = [r for r in all_records if r["llm_decision"] == "cull"]
    keep_records = [r for r in all_records if r["llm_decision"] == "keep"]
    max_correct = sum(1 for r in cull_records if r["user_decision"] == "cull")

    print(f"LLM culls: {len(cull_records)}, LLM keeps: {len(keep_records)}")
    print(f"Max correct auto-culls: {max_correct}")

    baseline_wrong = sum(1 for r in cull_records if r["user_decision"] == "keep")
    print(f"Baseline wrong-cull rate: {baseline_wrong}/{len(cull_records)} "
          f"({baseline_wrong/len(cull_records)*100:.1f}%)")
    print()

    # =========================================================================
    # Build and run all strategies
    # =========================================================================

    single_strategies = build_single_model_strategies()

    # Multi-model strategies (need records grouped by model)
    records_by_model = defaultdict(list)
    for r in all_records:
        records_by_model[r["model"]].append(r)
    multi_strategies = build_multi_model_strategies(records_by_model)

    all_strategies = single_strategies + multi_strategies
    print(f"Testing {len(all_strategies)} strategies ({len(single_strategies)} single-model, {len(multi_strategies)} multi-model)...")
    print()

    results = []
    for label, pred in all_strategies:
        result = evaluate_strategy(label, pred, cull_records, max_correct, user_stars)
        if result:
            results.append(result)

    # =========================================================================
    # Main ranking: by wrong-cull rate (ascending), then coverage (descending)
    # =========================================================================

    sep = "=" * 110
    ranked = [r for r in results if r["coverage"] >= args.min_coverage]
    ranked.sort(key=lambda r: (r["wrong_rate"], -r["coverage"]))

    print(sep)
    print("  STRATEGY RANKING (by wrong-cull rate, min coverage >= {:.0f}%)".format(args.min_coverage))
    print(sep)
    print()
    print(f"  {'#':>3s}  {'Strategy':<48s} {'Total':>5s} {'Wrong':>5s} {'Severe':>6s} {'Rate':>7s} {'Cover':>7s} {'Score':>6s}")
    print(f"  {'':>3s}  {'-'*48} {'-'*5} {'-'*5} {'-'*6} {'-'*7} {'-'*7} {'-'*6}")

    for i, r in enumerate(ranked[:args.top], 1):
        print(f"  {i:>3d}  {r['label']:<48s} {r['total']:>5d} {r['wrong']:>5d} "
              f"{r['severe_wrong']:>6d} {r['wrong_rate']:>6.1f}% {r['coverage']:>6.1f}% {r['score']:>5.2f}")

    print()
    if len(ranked) > args.top:
        print(f"  ... and {len(ranked) - args.top} more (use --top N)")
        print()

    # =========================================================================
    # Pareto frontier
    # =========================================================================

    print(sep)
    print("  PARETO FRONTIER (undominated rate-coverage tradeoffs)")
    print(sep)
    print()

    pareto = []
    for r in ranked:
        dominated = any(
            other["wrong_rate"] <= r["wrong_rate"] and other["coverage"] >= r["coverage"]
            and (other["wrong_rate"] < r["wrong_rate"] or other["coverage"] > r["coverage"])
            for other in ranked if other is not r
        )
        if not dominated:
            pareto.append(r)

    pareto.sort(key=lambda r: r["coverage"])
    print(f"  {'Strategy':<48s} {'Total':>5s} {'Wrong':>5s} {'Severe':>6s} {'Rate':>7s} {'Cover':>7s}")
    print(f"  {'-'*48} {'-'*5} {'-'*5} {'-'*6} {'-'*7} {'-'*7}")
    for r in pareto:
        print(f"  {r['label']:<48s} {r['total']:>5d} {r['wrong']:>5d} "
              f"{r['severe_wrong']:>6d} {r['wrong_rate']:>6.1f}% {r['coverage']:>6.1f}%")
    print()

    # =========================================================================
    # Detailed breakdown for top strategy
    # =========================================================================

    if ranked:
        best = ranked[0]
        print(sep)
        print(f"  BEST STRATEGY DETAIL: {best['label']}")
        print(f"  Wrong: {best['wrong_rate']:.1f}% ({best['wrong']} of {best['total']}), "
              f"Severe: {best['severe_wrong']}, Borderline: {best['borderline_wrong']}, "
              f"Coverage: {best['coverage']:.1f}%")
        print(sep)
        print()

        matching = best["wrong_records"] + best["correct_records"]

        # By category
        cat_stats = defaultdict(lambda: {"total": 0, "wrong": 0, "severe": 0})
        for r in matching:
            cat = r["category"]
            cat_stats[cat]["total"] += 1
            if r["user_decision"] == "keep":
                cat_stats[cat]["wrong"] += 1
                us = user_stars.get(r["asset_id"])
                if us and us > 0:
                    cat_stats[cat]["severe"] += 1

        print(f"  By category:")
        print(f"  {'Category':<22s} {'Total':>5s} {'Wrong':>5s} {'Severe':>6s} {'Rate':>7s}")
        print(f"  {'-'*22} {'-'*5} {'-'*5} {'-'*6} {'-'*7}")
        for cat in sorted(cat_stats, key=lambda c: cat_stats[c]["total"], reverse=True):
            cs = cat_stats[cat]
            rate = cs["wrong"] / cs["total"] * 100 if cs["total"] else 0
            flag = " !!!" if rate > 20 else (" !!" if rate > 10 else (" !" if rate > 5 else ""))
            print(f"  {cat:<22s} {cs['total']:>5d} {cs['wrong']:>5d} {cs['severe']:>6d} {rate:>6.1f}%{flag}")
        print()

        # By subgroup type
        sg_stats = defaultdict(lambda: {"total": 0, "wrong": 0})
        for r in matching:
            sg_stats[r["sg_type"] or "singleton"]["total"] += 1
            if r["user_decision"] == "keep":
                sg_stats[r["sg_type"] or "singleton"]["wrong"] += 1

        print(f"  By subgroup type:")
        print(f"  {'Type':<18s} {'Total':>5s} {'Wrong':>5s} {'Rate':>7s}")
        print(f"  {'-'*18} {'-'*5} {'-'*5} {'-'*7}")
        for sgt in sorted(sg_stats, key=lambda t: sg_stats[t]["total"], reverse=True):
            s = sg_stats[sgt]
            rate = s["wrong"] / s["total"] * 100 if s["total"] else 0
            print(f"  {sgt:<18s} {s['total']:>5d} {s['wrong']:>5d} {rate:>6.1f}%")
        print()

        # By subgroup size
        size_stats = defaultdict(lambda: {"total": 0, "wrong": 0})
        for r in matching:
            size_stats[r["sg_size"]]["total"] += 1
            if r["user_decision"] == "keep":
                size_stats[r["sg_size"]]["wrong"] += 1

        print(f"  By subgroup size:")
        print(f"  {'Size':>5s} {'Total':>5s} {'Wrong':>5s} {'Rate':>7s}")
        print(f"  {'-'*5} {'-'*5} {'-'*5} {'-'*7}")
        for sz in sorted(size_stats):
            s = size_stats[sz]
            rate = s["wrong"] / s["total"] * 100 if s["total"] else 0
            print(f"  {sz:>5d} {s['total']:>5d} {s['wrong']:>5d} {rate:>6.1f}%")
        print()

        # Wrong culls detail
        wrong = best["wrong_records"]
        if wrong and (args.verbose or len(wrong) <= 25):
            print(f"  Wrong culls ({len(wrong)}):")
            print(f"  {'Batch':<28s} {'Idx':>3s} {'Stars':>5s} {'UStar':>5s} {'Category':<18s} {'SG Type':<14s} {'Sz':>3s} {'Rk':>3s} {'Note'}")
            print(f"  {'-'*28} {'-'*3} {'-'*5} {'-'*5} {'-'*18} {'-'*14} {'-'*3} {'-'*3} {'-'*30}")
            for r in sorted(wrong, key=lambda r: (r["batch_id"], r["idx"])):
                us = user_stars.get(r["asset_id"])
                us_str = str(us) if us else "-"
                sev = " !!!" if us and us > 0 else ""
                print(f"  {r['batch_id'][:28]:<28s} {r['idx']:>3d} {r['stars']:>5d} {us_str:>5s} "
                      f"{r['category']:<18s} {(r['sg_type'] or '-'):<14s} {r['sg_size']:>3d} {r['sg_rank']:>3d} "
                      f"{r.get('note', '')[:30]}{sev}")
            print()

    # =========================================================================
    # Projection for 100k library
    # =========================================================================

    if pareto:
        user_cull_rate = cache["user_decisions"]["cull"] / cache["user_decisions"]["total"]
        print(sep)
        print("  PROJECTION: 100k photo library")
        print(sep)
        print()
        print(f"  User cull rate: {user_cull_rate*100:.1f}%")
        print()
        for r in pareto[:6]:
            est_culls = int(100_000 * user_cull_rate)
            est_auto = int(est_culls * r["coverage"] / 100)
            est_wrong = int(est_auto * r["wrong_rate"] / 100)
            est_severe = int(est_wrong * (r["severe_wrong"] / max(r["wrong"], 1)))
            print(f"  {r['label'][:50]:<50s}")
            print(f"    Auto: ~{est_auto:,d} of ~{est_culls:,d} culls | "
                  f"Wrong: ~{est_wrong:,d} (~{est_severe:,d} severe) | "
                  f"Rate: {r['wrong_rate']:.1f}%")
            print()


if __name__ == "__main__":
    main()
