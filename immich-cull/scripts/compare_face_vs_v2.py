#!/usr/bin/env python3
"""Compare face-coverage prompt to v2 prompt (same qwen_terse model).

Both were run on the same 30 groups from Stage A. Face-coverage added
explicit per-image `faces=[name,...]` metadata. We want to know whether
adding face data changes picks in a way that better matches user intent.
"""
import json
from pathlib import Path
from collections import Counter

DATA_DIR = Path(__file__).parent.parent / "data" / "experiments"

def load(path):
    with open(path) as f:
        return json.load(f)

def main():
    v1 = load(DATA_DIR / "2026-04-19-stageA.json")
    v2 = load(DATA_DIR / "2026-04-20-promptv2.json")
    face = load(DATA_DIR / "2026-04-20-face-coverage.json")

    # Index by group key
    def by_key(results, get_group):
        m = {}
        for r in results:
            g = get_group(r)
            k = f"{g['batchId']}::{g['subgroupId']}"
            m[k] = r
        return m

    v1_map = by_key(v1["results"], lambda r: r["group"])
    v2_map = by_key(v2["results"], lambda r: r["group"])
    face_map = by_key(face["results"], lambda r: r["group"])

    print("# Face-coverage vs prompt-v2 (both qwen_terse)")
    print()
    print(f"Groups: {len(face_map)}")
    print()
    print(f"| group | v1 pick | v2 pick | face pick | faces covered | user keeps |")
    print(f"|---|---|---|---|---|---|")

    face_match_user = 0
    v2_match_user = 0
    face_keep_cnt = []
    v2_keep_cnt = []

    # Groups where v2 added a wrong extra (added a pick not in user's keeps)
    # Does face-coverage fix that?

    for k in sorted(face_map):
        f_r = face_map[k]
        g = f_r["group"]
        user = set(g["assetIds"].index(uid) for uid in g["userKeepIds"] if uid in g["assetIds"])
        face_pick = set(f_r["pick"]["best"])

        v1_r = v1_map.get(k)
        v2_r = v2_map.get(k)
        v1_pick = set()
        v2_pick = set()
        if v1_r:
            qwen_v1 = next((v for v in v1_r["variants"] if v["variant"] == "qwen36_a3b_terse"), None)
            if qwen_v1 and not qwen_v1["reason"].startswith(("ERROR", "PARSE")):
                v1_pick = set(qwen_v1["bestPicks"])
        if v2_r:
            qwen_v2 = next((v for v in v2_r["variants"] if v["variant"] == "qwen36_a3b_terse_v2"), None)
            if qwen_v2 and not qwen_v2["reason"].startswith(("ERROR", "PARSE")):
                v2_pick = set(qwen_v2["bestPicks"])

        if face_pick:
            face_keep_cnt.append(len(face_pick))
            if face_pick & user:
                face_match_user += 1
        if v2_pick:
            v2_keep_cnt.append(len(v2_pick))
            if v2_pick & user:
                v2_match_user += 1

        covered = f_r.get("distinctFacesCovered") or []
        total = f_r.get("totalFacesInGroup") or []
        cov_str = f"{len(covered)}/{len(total)}" if total else "-"
        print(f"| `{k}` | {sorted(v1_pick)} | {sorted(v2_pick)} | {sorted(face_pick)} | {cov_str} | {sorted(user)} |")

    print()
    print("## Summary")
    print()
    n = len(face_map)
    print(f"- face user-match: {face_match_user}/{n} ({100*face_match_user/n:.0f}%)")
    print(f"- v2 user-match (same groups): {v2_match_user}/{n} ({100*v2_match_user/n:.0f}%)")
    print(f"- face avg keep count: {sum(face_keep_cnt)/max(len(face_keep_cnt),1):.2f}")
    print(f"- v2 avg keep count: {sum(v2_keep_cnt)/max(len(v2_keep_cnt),1):.2f}")
    print()

    # How often did face-coverage change the pick vs v2?
    different = 0
    face_added_user_keep = 0
    face_dropped_user_keep = 0
    for k in sorted(face_map):
        f_pick = set(face_map[k]["pick"]["best"])
        v2_r = v2_map.get(k)
        if not v2_r: continue
        v2_ent = next((v for v in v2_r["variants"] if v["variant"] == "qwen36_a3b_terse_v2"), None)
        if not v2_ent or v2_ent["reason"].startswith(("ERROR","PARSE")): continue
        v2_pick = set(v2_ent["bestPicks"])
        user = set(face_map[k]["group"]["assetIds"].index(uid) for uid in face_map[k]["group"]["userKeepIds"] if uid in face_map[k]["group"]["assetIds"])
        if f_pick != v2_pick:
            different += 1
            added = f_pick - v2_pick
            dropped = v2_pick - f_pick
            if added & user: face_added_user_keep += 1
            if dropped & user: face_dropped_user_keep += 1

    print(f"- Groups where face pick differs from v2: {different}/{n}")
    print(f"  - ... of those, face ADDED a user-kept index: {face_added_user_keep}")
    print(f"  - ... of those, face DROPPED a user-kept index: {face_dropped_user_keep}")

if __name__ == "__main__":
    main()
