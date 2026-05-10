#!/usr/bin/env python3
"""
Test prompt variants against known-good batches.

For each prompt variant, re-runs the LLM on test batches and compares
the new decisions against the user's manual decisions.

Uses Vertex AI directly (not the server) so we can customize prompts.

Usage:
    python3 scripts/test_prompt_variants.py --batch 2024-02-10-75515d02efc2
    python3 scripts/test_prompt_variants.py --all-test-batches
"""

import json
import sqlite3
import sys
import urllib.request
from pathlib import Path
from argparse import ArgumentParser

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "state.db"
API_BASE = "http://localhost:3737"

# ===== PROMPT VARIANTS =====

VARIANT_BASE = """You review a batch of personal/family photos from a single session.

PRIORITY:
These are family memory photos. Judge people first — faces, expressions, interaction, children.
Background scenery is secondary unless no people are visible.

TASKS:
1. Assess EVERY photo — star rating + category + brief note + keep/cull.
2. Find similarity subgroups and rank within each.

STARS (0-5):
0 = filler. 1 = good. 2 = strong. 3 = excellent. 4 = exceptional. 5 = gallery-worthy.
Be STRICT: most photos 0-1. Rate each photo on its own merit.

{keep_philosophy}

{subgroup_rules}

Singletons: Keep if distinct moment/memory. Cull if blurry/accidental.

CRITICAL — group thoroughly, very few singletons.

Category codes: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth

OUTPUT — compact JSON:
{{"sum":"summary","img":[[i,stars,"cat","note","sgId"|null,"k"|"c"],...],"sg":[{{"id":"g1","type":"burst|dup|scene|subj","all":[best,...worst],"keep":[kept],"why":"reason"}}]}}
"""

VARIANTS = {
    "v0_current": {
        "keep_philosophy": """KEEP vs CULL:
Aim to keep roughly 40-50% on average. A batch of near-identical bursts might keep 1 (10%), diverse moments might keep 80%.""",
        "subgroup_rules": """Subgroups — be strict:
- Default to keeping ONLY the single best frame per subgroup.
- A second keep is justified only if genuinely different framing or expression.
- Action bursts: keep the peak moment only. Second only if different action/angle.""",
    },

    "v1_generous_subgroups": {
        "keep_philosophy": """KEEP vs CULL:
Aim to keep roughly 50-60% on average. When in doubt, keep — the user prefers having too many photos over losing a good one.""",
        "subgroup_rules": """Subgroups — balanced:
- Keep 1-2 photos per subgroup by default. For subgroups of 5+, 2-3 keeps are normal.
- Keep a second photo if it shows: different expression, different stage of action, different framing, or captures a distinct moment.
- Action sequences: keep 2-3 frames showing different stages (start, peak, aftermath).
- Same-scene landscapes: if the user took multiple shots, they likely valued the slight differences. Keep 2-3 variants unless they're truly identical.""",
    },

    "v2_moment_focused": {
        "keep_philosophy": """KEEP vs CULL:
Aim to keep roughly 50-60% on average. These are family memories — err on the side of keeping.
IMPORTANT: Different moments within the same scene are worth keeping separately. A child looking at a cat is a different memory than the child reaching for the cat, even if taken seconds apart.""",
        "subgroup_rules": """Subgroups — moment-aware:
- Default: keep 1-2 photos per subgroup. For 5+ photo subgroups, keep 2-3.
- A different moment = a keep. Examples of different moments:
  * Different expression (smiling vs laughing vs looking)
  * Different action stage (walking vs reaching vs holding)
  * Different framing that shows something new (close-up adds face detail)
  * The subject interacting with something different
- Only cull when photos are truly the same moment with no meaningful difference.
- Action bursts: keep frames showing genuinely different action stages.""",
    },

    "v3_conservative_cull": {
        "keep_philosophy": """KEEP vs CULL:
Keep roughly 60-70%. Only cull when clearly redundant or technically flawed.
The user values having multiple angles of the same moment — especially for children, pets, and events.
When you're unsure, KEEP. The user can always cull later, but can't recover a culled photo.""",
        "subgroup_rules": """Subgroups — conservative:
- Default: keep 2 photos per subgroup. For subgroups of 5+, keep 2-3.
- Only cull the clearly weakest: blurry, eyes closed, bad timing, blocked view.
- For landscapes/scenic: keep 2-3 variants if the user took them — they saw something worth capturing from different angles.
- For action: keep 2-3 showing different stages.
- For portraits/groups: keep the 2 best expressions.""",
    },
}


def fetch_batch_detail(batch_id):
    """Fetch full batch detail from the server."""
    url = f"{API_BASE}/api/batches/{batch_id}"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"ERROR fetching batch: {e}", file=sys.stderr)
        return None


def run_variant_via_server(batch_id, model="gemini-3.1-flash-lite-preview"):
    """Run or get cached LLM result from server (uses current prompt)."""
    url = f"{API_BASE}/api/batches/{batch_id}/rank?model={model}"
    try:
        req = urllib.request.Request(url, method="POST")
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"ERROR running LLM: {e}", file=sys.stderr)
        return None


def load_user_decisions():
    """Load all user decisions from DB."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    decisions = {}
    for row in conn.execute("SELECT asset_id, state FROM photo_decisions WHERE state IS NOT NULL"):
        decisions[row["asset_id"]] = row["state"]
    conn.close()
    return decisions


def compare_decisions(batch_detail, llm_response, user_decisions, variant_name):
    """Compare LLM decisions against user decisions."""
    assets = batch_detail.get("assets", [])

    # Parse LLM response
    raw = llm_response if isinstance(llm_response, dict) else {}
    if "response" in raw:
        raw = raw["response"]

    imgs = raw.get("img", [])
    sgs = raw.get("sg", [])

    # Build subgroup keep sets
    sg_keep = set()
    sg_all = set()
    for sg in sgs:
        for idx in (sg.get("keep", []) or []):
            if isinstance(idx, int): sg_keep.add(idx)
        for idx in (sg.get("all", []) or []):
            if isinstance(idx, int): sg_all.add(idx)

    results = {"agree": 0, "wrong_cull": 0, "wrong_keep": 0, "no_decision": 0, "total": 0}
    details = []

    for img in imgs:
        if isinstance(img, list) and len(img) >= 6:
            idx, stars, cat, note, sg_id, kc = img[0], img[1], img[2], img[3], img[4], img[5]
        else:
            continue

        if not isinstance(idx, int) or idx < 0 or idx >= len(assets):
            continue

        asset_id = assets[idx]["id"]
        llm_decision = "keep" if kc == "k" else "cull"
        user_decision = user_decisions.get(asset_id)

        if user_decision is None:
            results["no_decision"] += 1
            continue

        results["total"] += 1
        if llm_decision == user_decision:
            results["agree"] += 1
        elif llm_decision == "cull" and user_decision == "keep":
            results["wrong_cull"] += 1
        elif llm_decision == "keep" and user_decision == "cull":
            results["wrong_keep"] += 1

        details.append({
            "idx": idx, "stars": stars, "cat": cat, "note": note,
            "llm": llm_decision, "user": user_decision,
            "agree": llm_decision == user_decision,
        })

    return results, details


def main():
    parser = ArgumentParser(description="Test prompt variants on batches")
    parser.add_argument("--batch", help="Specific batch ID to test")
    parser.add_argument("--all-test-batches", action="store_true", help="Test all recommended batches")
    parser.add_argument("--variant", help="Specific variant to test (default: all)")
    args = parser.parse_args()

    test_batches = []
    if args.batch:
        test_batches = [args.batch]
    elif args.all_test_batches:
        test_batches = [
            "2024-02-10-75515d02efc2",  # Ball pit + snowy streets (8 disagreements)
            "2024-05-10-b4523b5454de",  # Toddler + cat (6 disagreements)
        ]
    else:
        print("Usage: --batch BATCH_ID or --all-test-batches")
        sys.exit(1)

    user_decisions = load_user_decisions()

    # For now, we can only test v0 (current prompt) via the server
    # Other variants would need direct Vertex AI calls
    print("NOTE: Currently only v0_current can be tested via the server API.")
    print("Other variants need direct Vertex AI integration (TODO).")
    print()

    for batch_id in test_batches:
        print(f"=== Batch: {batch_id} ===")
        batch_detail = fetch_batch_detail(batch_id)
        if not batch_detail:
            continue

        print(f"  Photos: {len(batch_detail.get('assets', []))}")

        # Test current prompt (v0)
        result = run_variant_via_server(batch_id)
        if result:
            metrics, details = compare_decisions(batch_detail, result, user_decisions, "v0_current")
            total = metrics["total"]
            if total > 0:
                agree_pct = metrics["agree"] / total * 100
                wc_pct = metrics["wrong_cull"] / total * 100
                wk_pct = metrics["wrong_keep"] / total * 100
                print(f"  v0_current: {agree_pct:.0f}% agree, {wc_pct:.0f}% wrong-cull, {wk_pct:.0f}% wrong-keep")

                # Show disagreements
                disagree = [d for d in details if not d["agree"]]
                if disagree:
                    print(f"  Disagreements ({len(disagree)}):")
                    for d in disagree:
                        print(f"    idx={d['idx']:>2d} llm={d['llm']:<4s} user={d['user']:<4s} "
                              f"stars={d['stars']} [{d['cat']}] {d['note'][:40]}")
        print()

    # Print variant descriptions for reference
    print("=== PROMPT VARIANTS (for manual testing) ===")
    for name, v in VARIANTS.items():
        prompt = VARIANT_BASE.format(**v)
        word_count = len(prompt.split())
        print(f"\n--- {name} ({word_count} words) ---")
        # Show key differences
        lines = v["subgroup_rules"].strip().split("\n")
        for line in lines[:3]:
            print(f"  {line.strip()}")
        if len(lines) > 3:
            print(f"  ... ({len(lines) - 3} more lines)")


if __name__ == "__main__":
    main()
