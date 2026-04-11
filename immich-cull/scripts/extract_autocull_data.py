#!/usr/bin/env python3
"""
Extract and cache enriched LLM decision data for auto-cull analysis.

Fetches batch assets from the running server, parses all LLM results,
enriches with subgroup context, and saves to a JSON cache. This is the
slow step — run it once, then iterate on thresholds instantly.

Requires the server running:
    npx tsx src/server.ts --local --vertex --port 3737

Usage:
    python3 scripts/extract_autocull_data.py
    python3 scripts/extract_autocull_data.py --model gemini-3.1-flash-lite-preview
    python3 scripts/extract_autocull_data.py --all-models

Output: data/autocull_analysis_cache.json
"""

import json
import sqlite3
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path
from argparse import ArgumentParser

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "state.db"
CACHE_PATH = Path(__file__).resolve().parent.parent / "data" / "autocull_analysis_cache.json"
API_BASE = "http://localhost:3737"

CATEGORY_MAP = {
    "por": "portrait", "grp": "group_portrait", "sel": "selfie",
    "lan": "landscape", "tra": "travel", "evt": "event", "pet": "pet",
    "act": "action", "doc": "document", "rec": "receipt", "wb": "whiteboard",
    "ss": "screenshot", "snap": "snapchat_save", "tech": "technical_construction",
    "veh": "vehicle", "food": "food", "meme": "meme", "oth": "other",
}

SG_TYPE_MAP = {
    "burst": "burst", "dup": "near_duplicate", "near_duplicate": "near_duplicate",
    "scene": "same_scene", "same_scene": "same_scene",
    "subj": "same_subject", "same_subject": "same_subject",
}


def expand_category(code):
    if not code:
        return "other"
    return CATEGORY_MAP.get(code.lower(), code.lower())


def expand_sg_type(t):
    if not t:
        return "unknown"
    return SG_TYPE_MAP.get(t.lower(), t.lower())


def fetch_batch_assets(batch_id):
    url = f"{API_BASE}/api/batches/{batch_id}"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("assets", [])
    except Exception as e:
        print(f"  WARNING: Could not fetch batch {batch_id}: {e}", file=sys.stderr)
        return None


def to_int(v):
    if isinstance(v, int):
        return v
    if isinstance(v, dict) and "i" in v:
        return v["i"]
    return None


def extract_rich_llm_data(response_json_str, assets):
    """Parse LLM response into rich per-photo records + subgroup info."""
    if not response_json_str:
        return [], {}

    text = response_json_str.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines[1:] if not l.strip().startswith("```")]
        text = "\n".join(lines)

    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return [], {}

    if isinstance(raw, list):
        return [], {}

    imgs_raw = raw.get("img", [])
    sgs_raw = raw.get("sg", raw.get("similaritySubgroups", []))
    if isinstance(sgs_raw, dict):
        sgs_raw = [sgs_raw]

    subgroups = {}
    sg_keep_indices = set()
    sg_all_indices = set()
    idx_to_sg = {}

    for sg in sgs_raw:
        if not isinstance(sg, dict):
            continue
        sg_id = sg.get("id", sg.get("subgroupId", ""))
        sg_type = expand_sg_type(sg.get("type", sg.get("subgroupType", "")))
        confidence = sg.get("confidence", 0.8)

        all_raw = sg.get("all", sg.get("imageIds", []))
        keep_raw = sg.get("keep", sg.get("recommendedKeepIds", []))

        all_indices = [i for i in (to_int(v) for v in (all_raw or [])) if i is not None]
        keep_indices = [i for i in (to_int(v) for v in (keep_raw or [])) if i is not None]

        if len(all_indices) <= 1:
            continue

        subgroups[sg_id] = {
            "type": sg_type,
            "all_indices": all_indices,
            "keep_indices": keep_indices,
            "confidence": confidence,
            "size": len(all_indices),
        }

        for idx in all_indices:
            sg_all_indices.add(idx)
            idx_to_sg[idx] = sg_id
        for idx in keep_indices:
            sg_keep_indices.add(idx)

    photos = []
    for img in imgs_raw:
        if isinstance(img, list):
            idx = img[0]
            if not isinstance(idx, int) or idx < 0 or idx >= len(assets):
                continue
            stars = img[1] if len(img) > 1 and isinstance(img[1], (int, float)) else 0
            cat = img[2] if len(img) > 2 else None
            note = img[3] if len(img) > 3 else ""
            sg_id_raw = img[4] if len(img) > 4 else None

            if len(img) >= 6 and img[5] in ("k", "c"):
                decision = "keep" if img[5] == "k" else "cull"
            else:
                if idx in sg_keep_indices:
                    decision = "keep"
                elif idx in sg_all_indices:
                    decision = "cull"
                else:
                    decision = "keep"

            sg_id = None
            if sg_id_raw and isinstance(sg_id_raw, str) and sg_id_raw in subgroups:
                sg_id = sg_id_raw
            elif idx in idx_to_sg:
                sg_id = idx_to_sg[idx]

            photos.append({
                "asset_id": assets[idx]["id"], "idx": idx,
                "stars": int(stars), "category": expand_category(cat),
                "note": str(note) if note else "",
                "llm_decision": decision, "sg_id": sg_id,
            })

        elif isinstance(img, dict):
            idx = img.get("i", img.get("index"))
            if idx is None or not isinstance(idx, int) or idx < 0 or idx >= len(assets):
                continue
            stars = img.get("s", img.get("suggestedStars", 0))
            cat = img.get("c", img.get("cat", img.get("category")))
            sg_id_raw = img.get("g", img.get("similaritySubgroupId"))
            kc = img.get("kc", img.get("k"))
            note = img.get("n", img.get("briefNote", ""))

            if kc == "k":
                decision = "keep"
            elif kc == "c":
                decision = "cull"
            else:
                if idx in sg_keep_indices:
                    decision = "keep"
                elif idx in sg_all_indices:
                    decision = "cull"
                else:
                    decision = "keep"

            sg_id = None
            if sg_id_raw and isinstance(sg_id_raw, str) and sg_id_raw in subgroups:
                sg_id = sg_id_raw
            elif idx in idx_to_sg:
                sg_id = idx_to_sg[idx]

            photos.append({
                "asset_id": assets[idx]["id"], "idx": idx,
                "stars": int(stars) if isinstance(stars, (int, float)) else 0,
                "category": expand_category(cat),
                "note": str(note) if note else "",
                "llm_decision": decision, "sg_id": sg_id,
            })

    return photos, subgroups


def enrich_record(photo, subgroups, all_photos_in_batch):
    """Add full subgroup context to a photo record."""
    sg_id = photo["sg_id"]
    base = {k: v for k, v in photo.items()}

    if sg_id and sg_id in subgroups:
        sg = subgroups[sg_id]
        all_in_sg = sg["all_indices"]
        keep_in_sg = sg["keep_indices"]

        try:
            rank = all_in_sg.index(photo["idx"])
        except ValueError:
            rank = len(all_in_sg)

        keeper_stars = []
        for kidx in keep_in_sg:
            for p in all_photos_in_batch:
                if p["idx"] == kidx:
                    keeper_stars.append(p["stars"])
                    break
        max_keeper_stars = max(keeper_stars) if keeper_stars else 0

        base.update({
            "in_subgroup": True,
            "sg_type": sg["type"],
            "sg_confidence": sg["confidence"],
            "sg_size": sg["size"],
            "sg_has_keeper": len(keep_in_sg) > 0,
            "sg_keeper_count": len(keep_in_sg),
            "sg_rank": rank,
            "sg_rank_frac": round(rank / max(len(all_in_sg) - 1, 1), 3),
            "max_keeper_stars": max_keeper_stars,
            "star_deficit": max_keeper_stars - photo["stars"],
        })
    else:
        base.update({
            "in_subgroup": False,
            "sg_type": None, "sg_confidence": None, "sg_size": 0,
            "sg_has_keeper": False, "sg_keeper_count": 0,
            "sg_rank": -1, "sg_rank_frac": -1.0,
            "max_keeper_stars": 0, "star_deficit": 0,
        })

    return base


def main():
    parser = ArgumentParser(description="Extract and cache auto-cull analysis data")
    parser.add_argument("--model", default=None, help="Specific model to extract")
    parser.add_argument("--all-models", action="store_true", help="Extract all models")
    args = parser.parse_args()

    if not DB_PATH.exists():
        print(f"ERROR: Database not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    # Load user decisions
    user_decisions = {}
    for row in conn.execute("SELECT asset_id, state FROM photo_decisions WHERE state IS NOT NULL"):
        user_decisions[row["asset_id"]] = row["state"]

    total_keeps = sum(1 for v in user_decisions.values() if v == "keep")
    total_culls = sum(1 for v in user_decisions.values() if v == "cull")
    print(f"User decisions: {len(user_decisions)} ({total_keeps} keep, {total_culls} cull)")

    # Determine model filter
    if args.all_models:
        model_filter = ""
        model_params = ()
    elif args.model:
        model_filter = "AND model = ?"
        model_params = (args.model,)
    else:
        models = conn.execute("""
            SELECT model, COUNT(*) as cnt FROM llm_batch_runs
            WHERE status = 'completed' AND response_json IS NOT NULL
            GROUP BY model ORDER BY cnt DESC
        """).fetchall()
        if not models:
            print("No completed LLM runs found", file=sys.stderr)
            sys.exit(1)
        best = None
        for m in models:
            if "3.1-flash-lite" in m["model"]:
                best = m["model"]
                break
        best = best or models[0]["model"]
        model_filter = "AND model = ?"
        model_params = (best,)
        print(f"Auto-selected model: {best}")

    runs = conn.execute(f"""
        SELECT id, batch_id, model, response_json, created_at
        FROM llm_batch_runs
        WHERE status = 'completed' AND response_json IS NOT NULL {model_filter}
        ORDER BY batch_id, id DESC
    """, model_params).fetchall()

    # Deduplicate: latest run per (batch_id, model)
    seen = set()
    unique_runs = []
    for run in runs:
        key = (run["batch_id"], run["model"])
        if key not in seen:
            seen.add(key)
            unique_runs.append(run)

    print(f"Runs: {len(runs)} total, {len(unique_runs)} unique")
    print()

    # Process and enrich
    batch_assets_cache = {}
    all_records = []
    total_photos = 0
    skipped_runs = 0
    models_seen = set()

    for i, run in enumerate(unique_runs):
        batch_id = run["batch_id"]
        model = run["model"]
        models_seen.add(model)

        if batch_id not in batch_assets_cache:
            assets = fetch_batch_assets(batch_id)
            batch_assets_cache[batch_id] = assets
            if (i + 1) % 50 == 0:
                print(f"  Fetched {i + 1}/{len(unique_runs)} batches...")

        assets = batch_assets_cache[batch_id]
        if assets is None:
            skipped_runs += 1
            continue

        photos, subgroups = extract_rich_llm_data(run["response_json"], assets)
        if not photos:
            skipped_runs += 1
            continue

        total_photos += len(photos)

        for photo in photos:
            user_decision = user_decisions.get(photo["asset_id"])
            if user_decision is None:
                continue

            enriched = enrich_record(photo, subgroups, photos)
            enriched["user_decision"] = user_decision
            enriched["model"] = model
            enriched["batch_id"] = batch_id
            enriched["llm_run_id"] = run["id"]
            all_records.append(enriched)

    conn.close()

    # Save cache
    cache = {
        "extracted_at": __import__("datetime").datetime.now().isoformat(),
        "models": sorted(models_seen),
        "total_photos": total_photos,
        "comparable_photos": len(all_records),
        "skipped_runs": skipped_runs,
        "user_decisions": {"keep": total_keeps, "cull": total_culls, "total": len(user_decisions)},
        "records": all_records,
    }

    CACHE_PATH.write_text(json.dumps(cache, indent=2))
    print()
    print(f"Cached {len(all_records)} enriched records to {CACHE_PATH}")
    print(f"  Models: {', '.join(sorted(models_seen))}")
    print(f"  Total photos: {total_photos}, comparable: {len(all_records)}")
    print(f"  LLM culls: {sum(1 for r in all_records if r['llm_decision'] == 'cull')}")
    print(f"  LLM keeps: {sum(1 for r in all_records if r['llm_decision'] == 'keep')}")
    print()
    print(f"Now run: python3 scripts/analyze_autocull_thresholds.py")


if __name__ == "__main__":
    main()
