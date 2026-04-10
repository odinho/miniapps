#!/usr/bin/env python3
"""
Compare how well different LLM models predicted the user's actual photo decisions.

Reads completed LLM batch runs from state.db, fetches batch asset ordering
from the local server API, and compares LLM keep/cull predictions against
the user's photo_decisions table.

Usage:
    python3 scripts/compare_models.py
"""

import json
import sqlite3
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "state.db"
API_BASE = "http://localhost:3737"

# Category code -> human-readable name
CATEGORY_MAP = {
    "por": "portrait", "grp": "group_portrait", "sel": "selfie",
    "lan": "landscape", "tra": "travel", "evt": "event", "pet": "pet",
    "act": "action", "doc": "document", "rec": "receipt", "wb": "whiteboard",
    "ss": "screenshot", "snap": "snapchat_save", "tech": "technical_construction",
    "veh": "vehicle", "food": "food", "meme": "meme", "oth": "other",
}


def expand_category(code):
    if not code:
        return "other"
    return CATEGORY_MAP.get(code.lower(), code.lower())


def fetch_batch_assets(batch_id):
    """Fetch batch assets from the API, returning list of asset dicts ordered by date."""
    url = f"{API_BASE}/api/batches/{batch_id}"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("assets", [])
    except Exception as e:
        print(f"  WARNING: Could not fetch batch {batch_id}: {e}", file=sys.stderr)
        return None


def extract_llm_decisions(response_json_str, assets):
    """
    Parse LLM response JSON and return list of (asset_id, llm_decision, category).

    Handles:
    - v3 format: img arrays have 6 elements, last is "k"/"c"
    - v2 format: img arrays have 5 elements, derive k/c from subgroup keep lists
    - Object format: img entries are dicts with kc field
    - gemma4 format: raw JSON array (not our format) -- skip
    """
    if not response_json_str:
        return []

    # Strip markdown code fences if present
    text = response_json_str.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        # Remove first line (```json) and last line (```)
        lines = [l for l in lines[1:] if not l.strip().startswith("```")]
        text = "\n".join(lines)

    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return []

    # If it's a list (gemma4 format or other non-standard), skip
    if isinstance(raw, list):
        return []

    imgs = raw.get("img", [])
    sgs = raw.get("sg", raw.get("similaritySubgroups", []))

    # Normalize sgs to a list
    if isinstance(sgs, dict):
        sgs = [sgs]

    # Build subgroup keep sets for v2 fallback
    sg_keep_indices = set()
    sg_all_indices = set()
    for sg in sgs:
        if isinstance(sg, dict):
            for idx in (sg.get("keep", []) or []):
                sg_keep_indices.add(idx)
            for idx in (sg.get("all", []) or []):
                sg_all_indices.add(idx)

    results = []
    for img in imgs:
        if isinstance(img, list):
            idx = img[0]
            if not isinstance(idx, int) or idx < 0 or idx >= len(assets):
                continue
            asset_id = assets[idx]["id"]
            cat = img[2] if len(img) > 2 else None

            if len(img) >= 6 and img[5] in ("k", "c"):
                # v3 format: explicit k/c
                decision = "keep" if img[5] == "k" else "cull"
            else:
                # v2 format: derive from subgroup keep lists
                if idx in sg_keep_indices:
                    decision = "keep"
                elif idx in sg_all_indices:
                    decision = "cull"
                else:
                    # Not in any subgroup -- treat as keep (singleton)
                    decision = "keep"

            results.append((asset_id, decision, expand_category(cat)))

        elif isinstance(img, dict):
            # Object format
            idx = img.get("i", img.get("index"))
            if idx is None or not isinstance(idx, int) or idx < 0 or idx >= len(assets):
                continue
            asset_id = assets[idx]["id"]
            cat = img.get("c", img.get("cat", img.get("category")))
            kc = img.get("kc", img.get("k"))
            if kc == "k":
                decision = "keep"
            elif kc == "c":
                decision = "cull"
            else:
                # Fallback to subgroups
                if idx in sg_keep_indices:
                    decision = "keep"
                elif idx in sg_all_indices:
                    decision = "cull"
                else:
                    decision = "keep"
            results.append((asset_id, decision, expand_category(cat)))

    return results


def main():
    if not DB_PATH.exists():
        print(f"ERROR: Database not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    # Load all user decisions
    user_decisions = {}
    for row in conn.execute("SELECT asset_id, state FROM photo_decisions WHERE state IS NOT NULL"):
        user_decisions[row["asset_id"]] = row["state"]

    print(f"User decisions loaded: {len(user_decisions)} "
          f"(keep={sum(1 for v in user_decisions.values() if v == 'keep')}, "
          f"cull={sum(1 for v in user_decisions.values() if v == 'cull')})")
    print()

    # Load completed LLM runs
    runs = conn.execute("""
        SELECT id, batch_id, model, prompt_version, response_json, created_at
        FROM llm_batch_runs
        WHERE status = 'completed' AND response_json IS NOT NULL
        ORDER BY batch_id, model
    """).fetchall()

    print(f"Completed LLM runs: {len(runs)}")
    print()

    # Cache batch assets (avoid re-fetching for multi-model batches)
    batch_assets_cache = {}

    # Per-model stats
    model_stats = defaultdict(lambda: {
        "total": 0,
        "agree": 0,
        "tp_keep": 0, "fp_keep": 0, "fn_keep": 0, "tn_keep": 0,
        "tp_cull": 0, "fp_cull": 0, "fn_cull": 0, "tn_cull": 0,
        "over_keep": 0,  # LLM keeps, user culls
        "over_cull": 0,  # LLM culls, user keeps
        "category_disagreements": defaultdict(lambda: {"over_keep": 0, "over_cull": 0, "total": 0}),
        "batches": 0,
        "skipped_no_decisions": 0,
    })

    # Per-batch, per-model results for A/B comparison
    batch_model_results = defaultdict(dict)  # batch_id -> {model -> {agree, total, details}}

    # All category stats across all models
    all_category_stats = defaultdict(lambda: {"agree": 0, "disagree": 0, "total": 0})

    # Track runs whose response could not be parsed
    skipped_unparseable = []

    for run in runs:
        batch_id = run["batch_id"]
        model = run["model"]
        response_json = run["response_json"]

        # Fetch assets for this batch
        if batch_id not in batch_assets_cache:
            assets = fetch_batch_assets(batch_id)
            batch_assets_cache[batch_id] = assets

        assets = batch_assets_cache[batch_id]
        if assets is None:
            print(f"  Skipping run {run['id']} (batch {batch_id}): could not fetch assets",
                  file=sys.stderr)
            continue

        # Extract LLM decisions
        llm_decisions = extract_llm_decisions(response_json, assets)
        if not llm_decisions:
            skipped_unparseable.append((run["id"], batch_id, model, run["prompt_version"]))
            continue

        stats = model_stats[model]
        stats["batches"] += 1

        batch_agree = 0
        batch_total = 0

        for asset_id, llm_decision, category in llm_decisions:
            user_decision = user_decisions.get(asset_id)
            if user_decision is None:
                stats["skipped_no_decisions"] += 1
                continue

            stats["total"] += 1
            batch_total += 1
            cat_stats = stats["category_disagreements"][category]
            cat_stats["total"] += 1
            all_category_stats[category]["total"] += 1

            if llm_decision == user_decision:
                stats["agree"] += 1
                batch_agree += 1
                all_category_stats[category]["agree"] += 1
            else:
                all_category_stats[category]["disagree"] += 1

            # Keep precision/recall (treating "keep" as positive)
            if llm_decision == "keep" and user_decision == "keep":
                stats["tp_keep"] += 1
            elif llm_decision == "keep" and user_decision == "cull":
                stats["fp_keep"] += 1
                stats["over_keep"] += 1
                cat_stats["over_keep"] += 1
            elif llm_decision == "cull" and user_decision == "keep":
                stats["fn_keep"] += 1
                stats["over_cull"] += 1
                cat_stats["over_cull"] += 1
            elif llm_decision == "cull" and user_decision == "cull":
                stats["tn_keep"] += 1

            # Cull precision/recall (treating "cull" as positive)
            if llm_decision == "cull" and user_decision == "cull":
                stats["tp_cull"] += 1
            elif llm_decision == "cull" and user_decision == "keep":
                stats["fp_cull"] += 1
            elif llm_decision == "keep" and user_decision == "cull":
                stats["fn_cull"] += 1
            elif llm_decision == "keep" and user_decision == "keep":
                stats["tn_cull"] += 1

        if batch_total > 0:
            batch_model_results[batch_id][model] = {
                "agree": batch_agree,
                "total": batch_total,
                "rate": batch_agree / batch_total if batch_total else 0,
            }

    conn.close()

    # =========================================================================
    # Report
    # =========================================================================

    sep = "=" * 78

    if skipped_unparseable:
        print(f"NOTE: {len(skipped_unparseable)} run(s) skipped (unparseable response format):")
        for run_id, bid, mdl, pv in skipped_unparseable:
            print(f"  run {run_id}: batch={bid} model={mdl} prompt={pv}")
        print()

    print(sep)
    print("  MODEL COMPARISON REPORT")
    print(sep)
    print()

    # Sort models by total photos compared (descending)
    sorted_models = sorted(model_stats.keys(), key=lambda m: model_stats[m]["total"], reverse=True)

    for model in sorted_models:
        s = model_stats[model]
        print(f"--- {model} ---")
        print(f"  Batches evaluated:       {s['batches']}")
        print(f"  Photos compared:         {s['total']}")
        print(f"  Skipped (no user decision): {s['skipped_no_decisions']}")
        if s["total"] == 0:
            print(f"  (no comparable data)")
            print()
            continue

        agreement = s["agree"] / s["total"] * 100
        print(f"  Agreement rate:          {agreement:.1f}% ({s['agree']}/{s['total']})")
        print()

        # Keep metrics
        keep_prec = (s["tp_keep"] / (s["tp_keep"] + s["fp_keep"]) * 100
                     if (s["tp_keep"] + s["fp_keep"]) > 0 else 0)
        keep_rec = (s["tp_keep"] / (s["tp_keep"] + s["fn_keep"]) * 100
                    if (s["tp_keep"] + s["fn_keep"]) > 0 else 0)
        keep_f1 = (2 * keep_prec * keep_rec / (keep_prec + keep_rec)
                   if (keep_prec + keep_rec) > 0 else 0)
        print(f"  KEEP  precision:         {keep_prec:.1f}%  "
              f"(of {s['tp_keep'] + s['fp_keep']} LLM-keeps, {s['tp_keep']} were correct)")
        print(f"  KEEP  recall:            {keep_rec:.1f}%  "
              f"(of {s['tp_keep'] + s['fn_keep']} user-keeps, LLM found {s['tp_keep']})")
        print(f"  KEEP  F1:                {keep_f1:.1f}%")
        print()

        # Cull metrics
        cull_prec = (s["tp_cull"] / (s["tp_cull"] + s["fp_cull"]) * 100
                     if (s["tp_cull"] + s["fp_cull"]) > 0 else 0)
        cull_rec = (s["tp_cull"] / (s["tp_cull"] + s["fn_cull"]) * 100
                    if (s["tp_cull"] + s["fn_cull"]) > 0 else 0)
        cull_f1 = (2 * cull_prec * cull_rec / (cull_prec + cull_rec)
                   if (cull_prec + cull_rec) > 0 else 0)
        print(f"  CULL  precision:         {cull_prec:.1f}%  "
              f"(of {s['tp_cull'] + s['fp_cull']} LLM-culls, {s['tp_cull']} were correct)")
        print(f"  CULL  recall:            {cull_rec:.1f}%  "
              f"(of {s['tp_cull'] + s['fn_cull']} user-culls, LLM found {s['tp_cull']})")
        print(f"  CULL  F1:                {cull_f1:.1f}%")
        print()

        over_keep_rate = s["over_keep"] / s["total"] * 100
        over_cull_rate = s["over_cull"] / s["total"] * 100
        print(f"  Over-keep rate:          {over_keep_rate:.1f}%  "
              f"({s['over_keep']} photos LLM kept but user culled)")
        print(f"  Over-cull rate:          {over_cull_rate:.1f}%  "
              f"({s['over_cull']} photos LLM culled but user kept)")
        print()

        # Category breakdown of disagreements
        cat_disagree = s["category_disagreements"]
        cats_with_disagree = [(c, d) for c, d in cat_disagree.items()
                              if d["over_keep"] + d["over_cull"] > 0]
        if cats_with_disagree:
            cats_with_disagree.sort(
                key=lambda x: x[1]["over_keep"] + x[1]["over_cull"], reverse=True)
            print(f"  Category disagreements (top 10):")
            print(f"  {'Category':<25s} {'Total':>6s} {'Over-keep':>10s} {'Over-cull':>10s} {'Err%':>6s}")
            for cat, d in cats_with_disagree[:10]:
                errs = d["over_keep"] + d["over_cull"]
                err_rate = errs / d["total"] * 100 if d["total"] else 0
                print(f"  {cat:<25s} {d['total']:>6d} {d['over_keep']:>10d} {d['over_cull']:>10d} {err_rate:>5.1f}%")
        print()

    # =========================================================================
    # Cross-category patterns
    # =========================================================================

    print(sep)
    print("  CATEGORY PATTERNS (ALL MODELS COMBINED)")
    print(sep)
    print()

    sorted_cats = sorted(all_category_stats.items(), key=lambda x: x[1]["total"], reverse=True)
    print(f"  {'Category':<25s} {'Total':>6s} {'Agree':>6s} {'Disagree':>8s} {'Agree%':>7s}")
    for cat, cs in sorted_cats:
        if cs["total"] == 0:
            continue
        agree_pct = cs["agree"] / cs["total"] * 100
        print(f"  {cat:<25s} {cs['total']:>6d} {cs['agree']:>6d} {cs['disagree']:>8d} {agree_pct:>6.1f}%")
    print()

    # Identify systematic patterns: categories with very high or very low agreement
    high_agree = [(c, cs) for c, cs in sorted_cats if cs["total"] >= 5 and cs["agree"] / cs["total"] >= 0.85]
    low_agree = [(c, cs) for c, cs in sorted_cats if cs["total"] >= 5 and cs["agree"] / cs["total"] < 0.60]

    if high_agree:
        print("  High-agreement categories (>=85%, n>=5):")
        for cat, cs in high_agree:
            print(f"    {cat}: {cs['agree']/cs['total']*100:.0f}% ({cs['total']} photos)")
        print()

    if low_agree:
        print("  Low-agreement categories (<60%, n>=5):")
        for cat, cs in low_agree:
            print(f"    {cat}: {cs['agree']/cs['total']*100:.0f}% ({cs['total']} photos)")
        print()

    # =========================================================================
    # Multi-model batch comparison (A/B)
    # =========================================================================

    print(sep)
    print("  MULTI-MODEL BATCH COMPARISON (A/B)")
    print(sep)
    print()

    multi_model_batches = {bid: models for bid, models in batch_model_results.items()
                           if len(models) > 1}

    if not multi_model_batches:
        print("  No batches with multiple models found.")
        print()
    else:
        print(f"  {len(multi_model_batches)} batches have results from multiple models.")
        print()

        # Per-batch breakdown
        for batch_id in sorted(multi_model_batches.keys()):
            models = multi_model_batches[batch_id]
            print(f"  Batch: {batch_id}")
            best_model = None
            best_rate = -1
            for model_name in sorted(models.keys()):
                r = models[model_name]
                pct = r["rate"] * 100
                print(f"    {model_name:<35s}  {r['agree']:>3d}/{r['total']:<3d}  ({pct:.1f}%)")
                if r["rate"] > best_rate:
                    best_rate = r["rate"]
                    best_model = model_name
            print(f"    --> Best: {best_model} ({best_rate*100:.1f}%)")
            print()

        # Aggregate: which model wins most often?
        model_wins = defaultdict(int)
        model_appearances = defaultdict(int)
        for batch_id, models in multi_model_batches.items():
            best_rate = max(r["rate"] for r in models.values())
            for model_name, r in models.items():
                model_appearances[model_name] += 1
                if r["rate"] == best_rate:
                    model_wins[model_name] += 1

        print("  Head-to-head summary (multi-model batches only):")
        print(f"  {'Model':<35s} {'Wins':>5s} {'Appeared':>9s} {'Win%':>6s}")
        for model_name in sorted(model_appearances.keys()):
            wins = model_wins[model_name]
            apps = model_appearances[model_name]
            win_pct = wins / apps * 100 if apps else 0
            print(f"  {model_name:<35s} {wins:>5d} {apps:>9d} {win_pct:>5.1f}%")
        print()

        # Aggregate agreement rate on shared batches only
        print("  Aggregate agreement on shared batches:")
        model_shared = defaultdict(lambda: {"agree": 0, "total": 0})
        for batch_id, models in multi_model_batches.items():
            for model_name, r in models.items():
                model_shared[model_name]["agree"] += r["agree"]
                model_shared[model_name]["total"] += r["total"]
        for model_name in sorted(model_shared.keys()):
            ms = model_shared[model_name]
            pct = ms["agree"] / ms["total"] * 100 if ms["total"] else 0
            print(f"  {model_name:<35s}  {ms['agree']:>4d}/{ms['total']:<4d}  ({pct:.1f}%)")
        print()

    # =========================================================================
    # Summary table
    # =========================================================================

    print(sep)
    print("  SUMMARY TABLE")
    print(sep)
    print()
    header = (f"  {'Model':<35s} {'Photos':>7s} {'Agree%':>7s} "
              f"{'KeepF1':>7s} {'CullF1':>7s} {'OvKeep':>7s} {'OvCull':>7s}")
    print(header)
    print("  " + "-" * (len(header) - 2))

    for model in sorted_models:
        s = model_stats[model]
        if s["total"] == 0:
            continue
        agreement = s["agree"] / s["total"] * 100

        keep_prec = (s["tp_keep"] / (s["tp_keep"] + s["fp_keep"]) * 100
                     if (s["tp_keep"] + s["fp_keep"]) > 0 else 0)
        keep_rec = (s["tp_keep"] / (s["tp_keep"] + s["fn_keep"]) * 100
                    if (s["tp_keep"] + s["fn_keep"]) > 0 else 0)
        keep_f1 = (2 * keep_prec * keep_rec / (keep_prec + keep_rec)
                   if (keep_prec + keep_rec) > 0 else 0)

        cull_prec = (s["tp_cull"] / (s["tp_cull"] + s["fp_cull"]) * 100
                     if (s["tp_cull"] + s["fp_cull"]) > 0 else 0)
        cull_rec = (s["tp_cull"] / (s["tp_cull"] + s["fn_cull"]) * 100
                    if (s["tp_cull"] + s["fn_cull"]) > 0 else 0)
        cull_f1 = (2 * cull_prec * cull_rec / (cull_prec + cull_rec)
                   if (cull_prec + cull_rec) > 0 else 0)

        over_keep_pct = s["over_keep"] / s["total"] * 100
        over_cull_pct = s["over_cull"] / s["total"] * 100

        print(f"  {model:<35s} {s['total']:>7d} {agreement:>6.1f}% "
              f"{keep_f1:>6.1f}% {cull_f1:>6.1f}% {over_keep_pct:>6.1f}% {over_cull_pct:>6.1f}%")

    print()


if __name__ == "__main__":
    main()
