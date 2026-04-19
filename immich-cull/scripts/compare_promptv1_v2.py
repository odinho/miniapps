#!/usr/bin/env python3
"""Compare Stage A (prompt v1) to Stage v2 (keep-more prompt).

For each variant present in both runs (qwen_terse, 31flashlite), compute:
  - Change in keep count per group
  - Change in user-match rate
  - Per-group pick diff (v2 adds a 2nd photo that was user-kept, v2 swaps, etc.)
  - Overlap between v1 pick and v2 pick

Usage:
  python3 scripts/compare_promptv1_v2.py > docs/experiments/2026-04-20-promptv2-results.md
"""
import json
from pathlib import Path
from collections import Counter

DATA_DIR = Path(__file__).parent.parent / "data" / "experiments"
V1 = DATA_DIR / "2026-04-19-stageA.json"
V2 = DATA_DIR / "2026-04-20-promptv2.json"

# Mapping: v2 variant name -> v1 variant name
VARIANT_MAP = {
    "qwen36_a3b_terse_v2": "qwen36_a3b_terse",
    "31flashlite_v2": "31flashlite",
}

def load(path):
    with open(path) as f:
        return json.load(f)

def by_group_key(results):
    m = {}
    for g in results:
        k = f"{g['group']['batchId']}::{g['group']['subgroupId']}"
        m[k] = g
    return m

def group_variant(group, variant_name):
    for v in group["variants"]:
        if v["variant"] == variant_name:
            return v
    return None

def main():
    v1 = load(V1)
    v2 = load(V2)

    print("# Prompt v2 vs v1 — side-by-side")
    print()
    print(f"v1 groups: {len(v1['results'])}, v2 groups: {v2.get('completedGroups', len(v2['results']))} (target {v2.get('targetGroups', '?')})")
    print()
    print(f"v2 prompt version: `{v2.get('promptVersion', '?')}`")
    print()

    v1_map = by_group_key(v1["results"])
    v2_map = by_group_key(v2["results"])

    # Only groups present in both
    common = set(v1_map) & set(v2_map)
    print(f"Common groups: {len(common)}")
    print()

    for v2_name, v1_name in VARIANT_MAP.items():
        print(f"## {v1_name} → {v2_name}")
        print()

        keep_cnt_v1 = []
        keep_cnt_v2 = []
        match_v1 = 0
        match_v2 = 0
        total = 0
        added_user_pick = 0  # v2 adds a pick that was user's
        added_nonuser_pick = 0
        swapped = 0
        identical = 0
        superset = 0  # v2 includes all v1 picks + more
        pick_diffs = []

        for gk in sorted(common):
            g1 = v1_map[gk]
            g2 = v2_map[gk]
            vr1 = group_variant(g1, v1_name)
            vr2 = group_variant(g2, v2_name)
            if not vr1 or not vr2:
                continue
            if vr1["reason"].startswith(("ERROR", "PARSE")): continue
            if vr2["reason"].startswith(("ERROR", "PARSE")): continue
            total += 1
            set1 = set(vr1["bestPicks"])
            set2 = set(vr2["bestPicks"])
            user_keep = set(
                g1["group"]["assetIds"].index(uid)
                for uid in g1["group"]["userKeepIds"]
                if uid in g1["group"]["assetIds"]
            )

            keep_cnt_v1.append(len(set1))
            keep_cnt_v2.append(len(set2))
            if vr1["matchesUser"]: match_v1 += 1
            if vr2["matchesUser"]: match_v2 += 1

            if set1 == set2:
                identical += 1
            else:
                if set1 < set2:
                    superset += 1
                    new_picks = set2 - set1
                    if new_picks & user_keep:
                        added_user_pick += 1
                    else:
                        added_nonuser_pick += 1
                else:
                    swapped += 1
                pick_diffs.append({
                    "group": gk,
                    "v1": sorted(set1),
                    "v2": sorted(set2),
                    "user": sorted(user_keep),
                })

        def mean(xs):
            return sum(xs) / len(xs) if xs else 0

        print(f"- Groups scored: {total}")
        print(f"- Avg keep count: v1={mean(keep_cnt_v1):.2f} → v2={mean(keep_cnt_v2):.2f}")
        print(f"- User-match rate: v1={match_v1}/{total} ({100 * match_v1 / total:.0f}%) → v2={match_v2}/{total} ({100 * match_v2 / total:.0f}%)")
        print()
        print(f"- Pick shifts:")
        print(f"  - identical picks: {identical}/{total}")
        print(f"  - v2 is superset of v1 (added): {superset}")
        print(f"    - added pick that user had kept: **{added_user_pick}** ← wins")
        print(f"    - added pick user had NOT kept: {added_nonuser_pick}")
        print(f"  - swapped (different picks): {swapped}")
        print()
        print(f"- Keep-count distribution: v1={Counter(keep_cnt_v1).most_common()} v2={Counter(keep_cnt_v2).most_common()}")
        print()

        if pick_diffs:
            print(f"### Per-group pick diffs ({v1_name})")
            print()
            for d in pick_diffs[:20]:
                marker = " ✓" if any(i in d["user"] for i in d["v2"]) else ""
                print(f"- `{d['group']}`: v1={d['v1']} → v2={d['v2']} (user={d['user']}){marker}")
            if len(pick_diffs) > 20:
                print(f"- ... and {len(pick_diffs) - 20} more")
            print()

if __name__ == "__main__":
    main()
