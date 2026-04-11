#!/usr/bin/env python3
"""
Test multiple Gemma prompt variations on a single batch.
Compares each variation against user decisions.

Usage: python3 scripts/gemma_prompt_experiment.py [--batch BATCH_ID] [--preview-px 512]
"""

import json
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "state.db"
API_BASE = "http://localhost:3737"
OLLAMA_URL = "http://localhost:11434"
MODEL = "gemma4:e4b"

# Get batch ID from args or use default
batch_id = None
preview_px = 512
for i, arg in enumerate(sys.argv[1:], 1):
    if arg == "--batch" and i < len(sys.argv) - 1:
        batch_id = sys.argv[i + 1]
    if arg == "--preview-px" and i < len(sys.argv) - 1:
        preview_px = int(sys.argv[i + 1])

if not batch_id:
    batch_id = "2024-03-31-3ee20ac7073d"  # default: median difficulty


def load_user_decisions():
    db = sqlite3.connect(str(DB_PATH))
    decisions = {}
    for r in db.execute("SELECT asset_id, state FROM photo_decisions WHERE state IS NOT NULL"):
        decisions[r[0]] = r[1]
    db.close()
    return decisions


def fetch_batch(bid):
    resp = urllib.request.urlopen(f"{API_BASE}/api/batches/{bid}", timeout=10).read()
    return json.loads(resp)


def run_ollama(system_prompt, user_prompt, images_b64, temperature=0.2, extra_opts=None):
    """Run Ollama with given prompts and images, return parsed JSON + timing."""
    messages = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": user_prompt,
            "images": images_b64,
        },
    ]
    opts = {"temperature": temperature, "num_predict": 16000, "num_ctx": 32768}
    if extra_opts:
        opts.update(extra_opts)
    payload = json.dumps({
        "model": MODEL,
        "messages": messages,
        "stream": False,
        "format": "json",
        "options": opts,
    }).encode()

    t0 = time.time()
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req, timeout=600).read()
    elapsed = time.time() - t0

    result = json.loads(resp)
    raw_text = result.get("message", {}).get("content", "")
    tokens_in = result.get("prompt_eval_count", 0)
    tokens_out = result.get("eval_count", 0)

    try:
        parsed = json.loads(raw_text)
    except json.JSONDecodeError:
        parsed = None

    return parsed, elapsed, tokens_in, tokens_out


def evaluate(parsed, assets, decisions):
    """Compare LLM output against user decisions. Returns (agree, disagree, details)."""
    if not parsed:
        return 0, 0, []

    imgs = parsed.get("img", [])
    agree = 0
    disagree = 0
    details = []

    for img in imgs:
        if not isinstance(img, list) or len(img) < 2:
            continue
        idx = img[0]
        # Handle both full format [idx,stars,cat,note,sg,kc] and simple [idx,kc]
        if len(img) >= 6:
            kc_raw = img[5]
        elif len(img) == 2:
            kc_raw = img[1]
        else:
            kc_raw = img[-1]
        if not isinstance(idx, int) or idx >= len(assets):
            continue

        aid = assets[idx]["id"]
        if aid not in decisions:
            continue

        llm_state = "keep" if kc_raw == "k" else "cull"
        user_state = decisions[aid]
        match = llm_state == user_state
        if match:
            agree += 1
        else:
            disagree += 1
        details.append({
            "idx": idx,
            "filename": assets[idx]["filename"],
            "llm": llm_state,
            "user": user_state,
            "match": match,
            "note": img[3] if len(img) > 3 else "",
            "stars": img[1] if len(img) > 1 else 0,
        })

    return agree, disagree, details


def prepare_images_at_size(batch_detail, px):
    """Get base64 images at a specific size."""
    images = []
    import base64
    for asset in batch_detail["assets"]:
        try:
            img_resp = urllib.request.urlopen(
                f"{API_BASE}/api/preview?id={urllib.request.quote(asset['id'])}&w={px}",
                timeout=10,
            ).read()
            images.append(base64.b64encode(img_resp).decode())
        except Exception as e:
            print(f"  WARNING: Could not load image for {asset['filename']}: {e}")
            images.append("")
    return images

def prepare_images(batch_detail):
    """Get base64 images from the API preview endpoint."""
    images = []
    for asset in batch_detail["assets"]:
        try:
            img_resp = urllib.request.urlopen(
                f"{API_BASE}/api/preview?id={urllib.request.quote(asset['id'])}&w={preview_px}",
                timeout=10,
            ).read()
            import base64
            images.append(base64.b64encode(img_resp).decode())
        except Exception as e:
            print(f"  WARNING: Could not load image for {asset['filename']}: {e}")
            images.append("")
    return images


# === PROMPT VARIATIONS ===

PROMPTS = {}

# V0: Current production prompt (baseline)
PROMPTS["v0_baseline"] = {
    "description": "Current production prompt (same as Gemini)",
    "system": None,  # Will use the actual production prompt
}

# V1: Simplified — fewer rules, focus on the core task
PROMPTS["v1_simple"] = {
    "description": "Simplified prompt, fewer rules",
    "system": """You review personal/family photos from a single session.

For each photo: rate 0-5 stars, categorize, write a brief note, and decide keep or cull.
Group similar photos (same moment/subject). Within groups, keep only the 1-2 best.

IMPORTANT: Lean toward KEEP. Only cull if a photo is clearly redundant, blurry, or low-value.
Family photos with people are almost always worth keeping.

Return JSON:
{"sum":"summary","img":[[index,stars,"category","note",null,"k" or "c"],...],"sg":[]}

Stars: 0=filler, 1=good, 2=strong, 3=excellent, 4=exceptional, 5=gallery-worthy. Most are 0-1.
Categories: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth
""",
}

# V2: No subgroups — just per-image k/c (simplest possible task)
PROMPTS["v2_no_subgroups"] = {
    "description": "No subgroups, just per-image keep/cull",
    "system": """Review these personal/family photos. For each one, decide: keep or cull?

Rules:
- Keep photos with people (family, friends) unless very blurry or exact duplicate
- Keep reference/documentation shots (screenshots, receipts, notes)
- Keep food photos if they look intentional
- Cull only if truly redundant, blurry, accidental, or empty
- When in doubt, KEEP

Return JSON: {"sum":"summary","img":[[index,stars,"category","3-5 word note",null,"k" or "c"],...]}
Stars 0-5 (most should be 0-1). Categories: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth

Example: {"sum":"Park outing","img":[[0,2,"grp","Family smiling on bench",null,"k"],[1,0,"lan","Empty path, no people",null,"c"]]}
""",
}

# V3: Conservative — explicit "keep 60-70%"
PROMPTS["v3_conservative"] = {
    "description": "Conservative: explicit keep target 60-70%",
    "system": """Review personal/family photos from one session. Decide keep or cull for each.

TARGET: Keep 60-70% of photos. Only cull the clearly worst ones.

What to KEEP (default):
- People, especially children and family moments
- Any photo that captures a distinct moment
- Screenshots, documents, reference shots (user values these)
- Food photos if intentional
- Snapchat saves (user manually saved these)

What to CULL:
- Near-identical duplicates (keep the sharpest/best expression)
- Genuinely blurry or accidental shots
- Empty/meaningless backgrounds with no subject

If similar photos exist, group them and keep the best 1-2. But most photos should be kept.

Return JSON:
{"sum":"1 sentence","img":[[index,stars,"cat","3-5 word note","sgId" or null,"k" or "c"],...],"sg":[{"id":"g1","type":"dup","all":[best,worst],"keep":[best],"why":"reason"}]}
Categories: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth
Stars: 0-5 (most 0-1). "all" and "keep" are integer arrays.
""",
}

# V4: Two-phase in one prompt — describe first, then decide
PROMPTS["v4_describe_first"] = {
    "description": "Describe all photos first, then decide",
    "system": """Review personal/family photos. Do this in TWO steps:

STEP 1 — Describe each photo briefly (what's in it, who, quality).
STEP 2 — Based on your descriptions, decide keep/cull. Keep 60-70%.

Keep: people, family moments, references, intentional shots.
Cull: only blurry, accidental, or truly redundant (near-identical to a better version).
When in doubt, keep.

Return JSON:
{"sum":"summary","img":[[index,stars,"cat","3-5 word note",null,"k" or "c"],...]}
Stars 0-5, Categories: por grp sel lan tra evt pet act doc rec wb ss snap tech veh food meme oth
""",
}

# V5: Ultra-simple output — no stars, no subgroups, no categories
PROMPTS["v5_ultra_simple"] = {
    "description": "Minimal output: just k/c per image, keep-biased",
    "system": """Look at these personal/family photos. For each one, decide: keep (k) or cull (c).

When uncertain, KEEP. Most photos should be kept. Only cull if:
- Nearly identical to another photo (keep the sharper one)
- Very blurry or accidental
- Completely empty/meaningless

Group portraits and family photos: almost always keep.
Screenshots and saved images: almost always keep.

Return JSON: {"img":[[0,"k"],[1,"c"],[2,"k"],...]}
Just the index and "k" or "c" for each image. Nothing else needed.
""",
    "temperature": 0.3,
    "ollama_opts": {"top_k": 20, "top_p": 0.85, "num_predict": 2000},
}

# V6: Same as v5 but with larger images
PROMPTS["v6_ultra_simple_800px"] = {
    "description": "Ultra-simple + 800px images",
    "system": PROMPTS["v5_ultra_simple"]["system"],
    "temperature": 0.3,
    "ollama_opts": {"top_k": 20, "top_p": 0.85, "num_predict": 2000},
    "preview_px": 800,
}

# V7: Conservative with tuned Ollama params
PROMPTS["v7_conservative_tuned"] = {
    "description": "Conservative prompt + low temp + top_k 20",
    "system": PROMPTS["v3_conservative"]["system"],
    "temperature": 0.3,
    "ollama_opts": {"top_k": 20, "top_p": 0.85, "repeat_penalty": 1.1},
}


def main():
    decisions = load_user_decisions()
    batch = fetch_batch(batch_id)
    assets = batch["assets"]

    print(f"=== Gemma Prompt Experiment ===")
    print(f"Batch: {batch_id} ({len(assets)} photos, preview: {preview_px}px)")
    print(f"User decisions: {sum(1 for a in assets if a['id'] in decisions)} available")
    print()

    # Load production prompt for baseline
    # We'll read it from the running server's prompt
    try:
        # Get production prompt from a dummy call inspection — just use the v1_simple as standin
        pass
    except:
        pass

    print("Preparing images...")
    images_b64 = prepare_images(batch)
    print(f"  {len(images_b64)} images loaded")
    print()

    # Build user prompt (same for all variations)
    images_meta = [{"i": i, "f": a["filename"]} for i, a in enumerate(assets)]
    user_prompt = (
        f"Session batch with {len(assets)} images, indices 0-{len(assets)-1}.\n"
        f"Images: {json.dumps(images_meta)}\n\n"
        f"The images follow in order (0 to {len(assets)-1}).\n"
        f"Review and return JSON."
    )

    results = []
    for name, variant in PROMPTS.items():
        if name == "v0_baseline":
            print(f"--- {name}: {variant['description']} ---")
            print("  (skipping baseline — use cached server result)")
            print()
            continue

        if name == "v5_larger_images" and preview_px <= 512:
            print(f"--- {name}: {variant['description']} ---")
            print("  (skipping — run with --preview-px 800 to test)")
            print()
            continue

        print(f"--- {name}: {variant['description']} ---")
        system = variant["system"]
        temp = variant.get("temperature", 0.2)
        extra_opts = variant.get("ollama_opts")
        variant_px = variant.get("preview_px")

        # Use different image set if variant wants different size
        if variant_px and variant_px != preview_px:
            print(f"  Loading {variant_px}px images...")
            variant_images = prepare_images_at_size(batch, variant_px)
        else:
            variant_images = images_b64

        parsed, elapsed, tok_in, tok_out = run_ollama(system, user_prompt, variant_images, temp, extra_opts)

        if parsed:
            agree, disagree, details = evaluate(parsed, assets, decisions)
            total = agree + disagree
            pct = 100 * agree / total if total else 0
            n_keep = sum(1 for d in details if d["llm"] == "keep")
            n_cull = sum(1 for d in details if d["llm"] == "cull")
            errors = [d for d in details if not d["match"]]

            print(f"  Agreement: {agree}/{total} ({pct:.1f}%)")
            print(f"  Keep/Cull: {n_keep}/{n_cull}, Time: {elapsed:.0f}s, Tokens: {tok_in}in/{tok_out}out")
            if errors:
                print(f"  Errors ({len(errors)}):")
                for e in errors[:5]:
                    print(f"    [{e['idx']}] {e['filename']}: gemma={e['llm']}, user={e['user']} — {e['note']}")
                if len(errors) > 5:
                    print(f"    ... +{len(errors)-5} more")
            print()
            results.append((name, pct, agree, total, elapsed))
        else:
            print(f"  FAILED to parse JSON ({elapsed:.0f}s)")
            print()
            results.append((name, 0, 0, 0, elapsed))

    print("=== RESULTS ===")
    print(f"{'Variant':<25} {'Agree%':>7} {'Score':>7} {'Time':>6}")
    print("-" * 50)
    for name, pct, agree, total, elapsed in sorted(results, key=lambda x: -x[1]):
        print(f"{name:<25} {pct:>6.1f}% {agree:>3}/{total:<3} {elapsed:>5.0f}s")


if __name__ == "__main__":
    main()
