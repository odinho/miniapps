#!/usr/bin/env python3
"""
Backfill LLM-derived star ratings into photo_decisions.

For each photo with a keep/cull decision but no user_stars, find the
LLM star rating from the latest batch run and save the mapped star
(LLM 0-2→0, 3→1, 4→2, 5→3). Marks star_source='llm'.

Run after upgrading to schema v7 (star_source column).

Usage:
    python3 scripts/backfill_llm_stars.py
    python3 scripts/backfill_llm_stars.py --dry-run
"""

import json
import sqlite3
import sys
import urllib.request
from pathlib import Path
from argparse import ArgumentParser

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "state.db"
API_BASE = "http://localhost:3737"


def map_llm_stars(llm_stars):
    """Shift-1: LLM 0-1→0, 2→1, 3→2, 4-5→3"""
    if llm_stars <= 1:
        return 0
    if llm_stars >= 4:
        return 3
    return llm_stars - 1  # 2→1, 3→2


def fetch_batch_assets(batch_id):
    url = f"{API_BASE}/api/batches/{batch_id}"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("assets", [])
    except Exception as e:
        return None


def extract_llm_stars(response_json_str, assets):
    """Parse LLM response and return {asset_id: llm_stars}."""
    if not response_json_str:
        return {}

    text = response_json_str.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines[1:] if not l.strip().startswith("```")]
        text = "\n".join(lines)

    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return {}

    if isinstance(raw, list):
        return {}

    stars = {}
    imgs = raw.get("img", [])
    for img in imgs:
        if isinstance(img, list) and len(img) >= 2:
            idx = img[0]
            s = img[1]
            if isinstance(idx, int) and 0 <= idx < len(assets) and isinstance(s, (int, float)):
                stars[assets[idx]["id"]] = int(s)
        elif isinstance(img, dict):
            idx = img.get("i", img.get("index"))
            s = img.get("s", img.get("suggestedStars", 0))
            if isinstance(idx, int) and 0 <= idx < len(assets):
                stars[assets[idx]["id"]] = int(s)

    return stars


def main():
    parser = ArgumentParser(description="Backfill LLM stars into photo_decisions")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be updated without saving")
    parser.add_argument("--model", default=None, help="Prefer this model's stars")
    args = parser.parse_args()

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    # Get decisions without stars
    no_stars = conn.execute("""
        SELECT asset_id FROM photo_decisions
        WHERE state IS NOT NULL AND (user_stars IS NULL OR user_stars = 0)
    """).fetchall()
    no_star_ids = set(r["asset_id"] for r in no_stars)
    print(f"Decisions without stars: {len(no_star_ids)}")

    # Get completed LLM runs (prefer model if specified)
    runs = conn.execute("""
        SELECT id, batch_id, model, response_json
        FROM llm_batch_runs
        WHERE status = 'completed' AND response_json IS NOT NULL
        ORDER BY id DESC
    """).fetchall()

    # Deduplicate: latest run per batch (prefer specified model)
    seen = set()
    unique_runs = []
    for run in runs:
        key = run["batch_id"]
        if key in seen:
            continue
        if args.model and run["model"] != args.model:
            continue
        seen.add(key)
        unique_runs.append(run)

    print(f"LLM runs to scan: {len(unique_runs)}")

    batch_assets_cache = {}
    updates = []  # (asset_id, mapped_star, llm_star)

    for i, run in enumerate(unique_runs):
        batch_id = run["batch_id"]
        if batch_id not in batch_assets_cache:
            batch_assets_cache[batch_id] = fetch_batch_assets(batch_id)
            if (i + 1) % 100 == 0:
                print(f"  Scanned {i + 1}/{len(unique_runs)}...")

        assets = batch_assets_cache[batch_id]
        if not assets:
            continue

        llm_stars = extract_llm_stars(run["response_json"], assets)

        for asset_id, llm_star in llm_stars.items():
            if asset_id not in no_star_ids:
                continue
            mapped = map_llm_stars(llm_star)
            updates.append((asset_id, mapped, llm_star))
            no_star_ids.discard(asset_id)  # don't double-update

    # Summary
    with_star = sum(1 for _, m, _ in updates if m > 0)
    without_star = sum(1 for _, m, _ in updates if m == 0)
    print(f"\nUpdates: {len(updates)} total ({with_star} get Immich stars, {without_star} get 0)")
    print(f"Still missing: {len(no_star_ids)}")

    # Star distribution
    from collections import Counter
    dist = Counter(m for _, m, _ in updates)
    print(f"Mapped star distribution: {dict(sorted(dist.items()))}")

    llm_dist = Counter(l for _, _, l in updates)
    print(f"LLM star distribution: {dict(sorted(llm_dist.items()))}")

    if args.dry_run:
        print("\n[DRY RUN] No changes saved.")
        conn.close()
        return

    # Save
    print("\nSaving...")
    cursor = conn.cursor()
    cursor.execute("BEGIN")
    for asset_id, mapped, llm_star in updates:
        cursor.execute("""
            UPDATE photo_decisions
            SET user_stars = ?, star_source = 'llm', updated_at = datetime('now')
            WHERE asset_id = ?
        """, (mapped, asset_id))
    cursor.execute("COMMIT")
    print(f"Saved {len(updates)} star ratings (star_source='llm').")

    conn.close()


if __name__ == "__main__":
    main()
