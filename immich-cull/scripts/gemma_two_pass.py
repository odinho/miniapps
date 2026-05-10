#!/usr/bin/env python3
"""
Two-pass Gemma experiment:
  Pass 1: Describe each photo (vision)
  Pass 2: Decide keep/cull from descriptions only (reasoning)

Also tests: simple ranking (order by worth keeping).
"""

import json
import sqlite3
import sys
import time
import base64
import urllib.request
from pathlib import Path

API_BASE = "http://localhost:3737"
OLLAMA_URL = "http://localhost:11434"
MODEL = "gemma4:e4b"
DB_PATH = Path(__file__).resolve().parent.parent / "data" / "state.db"

batch_id = sys.argv[1] if len(sys.argv) > 1 else "2024-03-31-3ee20ac7073d"


def ollama_chat(messages, temperature=0.3, num_predict=4000, json_mode=True):
    payload = json.dumps({
        "model": MODEL,
        "messages": messages,
        "stream": False,
        **({"format": "json"} if json_mode else {}),
        "options": {"temperature": temperature, "num_predict": num_predict, "num_ctx": 32768,
                    "top_k": 20, "top_p": 0.85},
    }).encode()
    req = urllib.request.Request(f"{OLLAMA_URL}/api/chat", data=payload,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    resp = json.loads(urllib.request.urlopen(req, timeout=600).read())
    elapsed = time.time() - t0
    text = resp.get("message", {}).get("content", "")
    tokens_in = resp.get("prompt_eval_count", 0)
    tokens_out = resp.get("eval_count", 0)
    return text, elapsed, tokens_in, tokens_out


def load_user_decisions():
    db = sqlite3.connect(str(DB_PATH))
    d = {}
    for r in db.execute("SELECT asset_id, state FROM photo_decisions WHERE state IS NOT NULL"):
        d[r[0]] = r[1]
    db.close()
    return d


def fetch_batch(bid):
    return json.loads(urllib.request.urlopen(f"{API_BASE}/api/batches/{bid}", timeout=10).read())


def load_images(assets):
    images = []
    for a in assets:
        try:
            img = urllib.request.urlopen(
                f"{API_BASE}/api/preview?id={urllib.request.quote(a['id'])}&w=512", timeout=10
            ).read()
            images.append(base64.b64encode(img).decode())
        except:
            images.append("")
    return images


def evaluate(results, assets, decisions):
    agree = disagree = 0
    errors = []
    for idx_str, kc in results.items():
        idx = int(idx_str)
        if idx >= len(assets):
            continue
        aid = assets[idx]["id"]
        if aid not in decisions:
            continue
        llm = "keep" if kc in ("k", "keep") else "cull"
        user = decisions[aid]
        if llm == user:
            agree += 1
        else:
            disagree += 1
            errors.append(f"  [{idx}] {assets[idx]['filename']}: gemma={llm}, user={user}")
    return agree, disagree, errors


def main():
    decisions = load_user_decisions()
    batch = fetch_batch(batch_id)
    assets = batch["assets"]
    n = len(assets)
    user_count = sum(1 for a in assets if a["id"] in decisions)

    print(f"=== Two-Pass Gemma Experiment ===")
    print(f"Batch: {batch_id} ({n} photos, {user_count} with user decisions)")
    print()

    print("Loading images...")
    images = load_images(assets)
    meta = [{"i": i, "f": a["filename"]} for i, a in enumerate(assets)]

    # === APPROACH 1: Two-pass (describe then decide) ===
    print("--- Approach 1: Two-pass (describe → decide) ---")

    # Pass 1: Describe
    print("  Pass 1: Describing images...")
    desc_prompt = (
        f"Describe each of these {n} personal/family photos in one sentence. "
        f"Focus on: who is in it, what they're doing, quality, and if it looks like a duplicate of another.\n\n"
        f"Images: {json.dumps(meta)}\n\n"
        f"Return JSON: {{\"descriptions\": {{\"0\": \"sentence\", \"1\": \"sentence\", ...}}}}"
    )
    desc_text, t1, tok1_in, tok1_out = ollama_chat([
        {"role": "user", "content": desc_prompt, "images": images},
    ])
    try:
        descriptions = json.loads(desc_text).get("descriptions", {})
    except:
        print(f"  FAILED to parse descriptions: {desc_text[:200]}")
        descriptions = {}

    if descriptions:
        print(f"  Got {len(descriptions)} descriptions in {t1:.0f}s ({tok1_in}in/{tok1_out}out)")
        for k in sorted(descriptions.keys(), key=int)[:3]:
            print(f"    [{k}] {descriptions[k][:80]}")
        if len(descriptions) > 3:
            print(f"    ...")

        # Pass 2: Decide (text only, no images)
        print("  Pass 2: Deciding keep/cull from descriptions...")
        desc_list = "\n".join(f"  Photo {k}: {v}" for k, v in sorted(descriptions.items(), key=lambda x: int(x[0])))
        decide_prompt = (
            f"Based on these photo descriptions from a personal/family photo session, "
            f"decide which to keep and which to cull.\n\n"
            f"Photos:\n{desc_list}\n\n"
            f"Rules:\n"
            f"- Keep photos with people, family moments, distinct scenes\n"
            f"- Keep screenshots and reference shots\n"
            f"- Cull near-duplicates (keep only the best described one)\n"
            f"- Cull blurry or accidental shots\n"
            f"- When in doubt, keep\n\n"
            f"Return JSON: {{\"decisions\": {{\"0\": \"k\", \"1\": \"c\", ...}}}}"
        )
        dec_text, t2, tok2_in, tok2_out = ollama_chat([
            {"role": "user", "content": decide_prompt},
        ])
        try:
            results = json.loads(dec_text).get("decisions", {})
        except:
            print(f"  FAILED to parse decisions: {dec_text[:200]}")
            results = {}

        if results:
            agree, disagree, errors = evaluate(results, assets, decisions)
            total = agree + disagree
            n_keep = sum(1 for v in results.values() if v in ("k", "keep"))
            print(f"  Agreement: {agree}/{total} ({100*agree/total:.1f}%)")
            print(f"  Keep/Cull: {n_keep}/{len(results)-n_keep}")
            print(f"  Total time: {t1+t2:.0f}s (desc {t1:.0f}s + decide {t2:.0f}s)")
            for e in errors[:5]:
                print(e)
    print()

    # === APPROACH 2: Rank by worth keeping ===
    print("--- Approach 2: Rank all photos by worth keeping ---")
    rank_prompt = (
        f"Look at these {n} personal/family photos and rank them by how worth keeping they are.\n\n"
        f"Images: {json.dumps(meta)}\n\n"
        f"Return JSON: {{\"ranking\": [best_index, ..., worst_index]}}\n"
        f"Put the most worth keeping photo first, least worth keeping last."
    )
    rank_text, t3, tok3_in, tok3_out = ollama_chat([
        {"role": "user", "content": rank_prompt, "images": images},
    ])
    try:
        ranking = json.loads(rank_text).get("ranking", [])
    except:
        print(f"  FAILED to parse ranking: {rank_text[:200]}")
        ranking = []

    if ranking:
        print(f"  Ranking ({t3:.0f}s, {tok3_in}in/{tok3_out}out): {ranking}")
        # Try different keep thresholds
        for keep_n in [n // 3, n // 2, int(n * 0.6), int(n * 0.7)]:
            keep_set = set(ranking[:keep_n])
            results = {str(i): "k" if i in keep_set else "c" for i in range(n)}
            agree, disagree, errors = evaluate(results, assets, decisions)
            total = agree + disagree
            print(f"  Keep top {keep_n}/{n}: {agree}/{total} ({100*agree/total:.1f}%)")
    print()

    # === APPROACH 3: Simple keep/cull, ultra-terse prompt ===
    print("--- Approach 3: Ultra-terse prompt ---")
    terse_prompt = (
        f"{n} family photos. Which to keep, which to delete?\n"
        f"Keep: people, memories, references. Delete: blurry, duplicates, empty.\n"
        f"Return JSON: {{\"keep\": [indices], \"cull\": [indices]}}"
    )
    terse_text, t4, tok4_in, tok4_out = ollama_chat([
        {"role": "user", "content": terse_prompt, "images": images},
    ])
    try:
        terse = json.loads(terse_text)
        keep_set = set(terse.get("keep", []))
        cull_set = set(terse.get("cull", []))
        results = {}
        for i in range(n):
            results[str(i)] = "k" if i in keep_set else "c"
        agree, disagree, errors = evaluate(results, assets, decisions)
        total = agree + disagree
        n_keep = len(keep_set)
        print(f"  Agreement: {agree}/{total} ({100*agree/total:.1f}%)")
        print(f"  Keep/Cull: {n_keep}/{n-n_keep}, Time: {t4:.0f}s")
        for e in errors[:5]:
            print(e)
    except Exception as e:
        print(f"  FAILED: {e}")
        print(f"  Raw: {terse_text[:200]}")


if __name__ == "__main__":
    main()
