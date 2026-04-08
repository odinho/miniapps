#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import re
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


CATEGORY_MAP = {
    "por": "portrait",
    "grp": "group_portrait",
    "sel": "selfie",
    "lan": "landscape",
    "scene": "landscape",
    "tra": "travel",
    "evt": "event",
    "pet": "pet",
    "act": "action",
    "doc": "document",
    "rec": "receipt",
    "wb": "whiteboard",
    "ss": "screenshot",
    "snap": "snapchat_save",
    "tech": "technical_construction",
    "veh": "vehicle",
    "food": "food",
    "meme": "meme",
    "oth": "other",
    "portrait": "portrait",
    "group_portrait": "group_portrait",
    "selfie": "selfie",
    "landscape": "landscape",
    "travel": "travel",
    "event": "event",
    "action": "action",
    "document": "document",
    "receipt": "receipt",
    "whiteboard": "whiteboard",
    "screenshot": "screenshot",
    "snapchat": "snapchat_save",
    "snapchat_save": "snapchat_save",
    "technical_construction": "technical_construction",
    "vehicle": "vehicle",
    "food": "food",
    "meme": "meme",
    "other": "other",
}


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Compare user culling decisions against saved LLM recommendations."
    )
    parser.add_argument(
        "--state-db",
        type=Path,
        default=repo_root / "data" / "state.db",
        help="Path to immich-cull state.db",
    )
    parser.add_argument(
        "--facet-db",
        type=Path,
        default=repo_root.parent.parent / "facet" / "photo_scores_pro.db",
        help="Path to Facet photo_scores_pro.db",
    )
    return parser.parse_args()


def expand_category(value: object) -> str:
    if value is None:
        return "other"
    return CATEGORY_MAP.get(str(value).lower(), str(value).lower())


def parse_facet_date(date_str: str | None, filename: str) -> datetime:
    if not date_str:
        return try_parse_filename_date(filename) or datetime.fromtimestamp(0)
    normalized = re.sub(r"^(\d{4}):(\d{2}):(\d{2})", r"\1-\2-\3", date_str)
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return try_parse_filename_date(filename) or datetime.fromtimestamp(0)


def try_parse_filename_date(filename: str) -> datetime | None:
    match = re.search(r"(\d{8})_(\d{6})", filename)
    if not match:
        return None
    try:
        return datetime.strptime("".join(match.groups()), "%Y%m%d%H%M%S")
    except ValueError:
        return None


def load_assets(facet_db_path: Path) -> list[dict]:
    conn = sqlite3.connect(facet_db_path)
    rows = conn.execute(
        """
        SELECT path, filename, date_taken
        FROM photos
        WHERE clip_embedding IS NOT NULL
        ORDER BY date_taken ASC
        """
    ).fetchall()
    conn.close()
    return [
        {
            "id": path,
            "path": path,
            "filename": filename,
            "dt": parse_facet_date(date_taken, filename),
        }
        for path, filename, date_taken in rows
    ]


def split_if_too_large(assets: list[dict], max_size: int = 30) -> list[list[dict]]:
    if len(assets) <= max_size:
        return [assets]

    max_gap_seconds = 0.0
    max_gap_idx = 0
    for idx in range(1, len(assets)):
        gap = (assets[idx]["dt"] - assets[idx - 1]["dt"]).total_seconds()
        if gap > max_gap_seconds:
            max_gap_seconds = gap
            max_gap_idx = idx

    if max_gap_seconds == 0:
        max_gap_idx = math.ceil(len(assets) / 2)

    parts: list[list[dict]] = []
    for chunk in (assets[:max_gap_idx], assets[max_gap_idx:]):
        if not chunk:
            continue
        if len(chunk) > max_size:
            parts.extend(split_if_too_large(chunk, max_size=max_size))
        else:
            parts.append(chunk)
    return parts


def fingerprint_for_asset_ids(asset_ids: list[str]) -> str:
    return hashlib.sha256("\n".join(sorted(asset_ids)).encode()).hexdigest()[:16]


def build_batches(assets: list[dict]) -> dict[str, dict]:
    folder_pattern = re.compile(r"/(\d{8}-[^/]+)/")
    folder_assets: dict[str, list[dict]] = defaultdict(list)
    time_assets: list[dict] = []

    for asset in assets:
        match = folder_pattern.search(asset["path"])
        if match:
            folder_assets[match.group(1)].append(asset)
        else:
            time_assets.append(asset)

    batches: dict[str, dict] = {}

    for items in folder_assets.values():
        for sub_batch in split_if_too_large(sorted(items, key=lambda item: item["dt"])):
            asset_ids = [asset["id"] for asset in sub_batch]
            batches[fingerprint_for_asset_ids(asset_ids)] = {"assets": sub_batch}

    sorted_time_assets = sorted(time_assets, key=lambda item: item["dt"])
    if sorted_time_assets:
        current = [sorted_time_assets[0]]
        gap_seconds = 4 * 3600
        for idx in range(1, len(sorted_time_assets)):
            gap = (sorted_time_assets[idx]["dt"] - sorted_time_assets[idx - 1]["dt"]).total_seconds()
            if gap > gap_seconds:
                for sub_batch in split_if_too_large(current):
                    asset_ids = [asset["id"] for asset in sub_batch]
                    batches[fingerprint_for_asset_ids(asset_ids)] = {"assets": sub_batch}
                current = []
            current.append(sorted_time_assets[idx])
        for sub_batch in split_if_too_large(current):
            asset_ids = [asset["id"] for asset in sub_batch]
            batches[fingerprint_for_asset_ids(asset_ids)] = {"assets": sub_batch}

    return batches


def parse_run(response_json: str, batch_assets: list[dict]) -> tuple[list[dict], list[dict]]:
    payload = json.loads(response_json)
    subgroup_map: dict[str, dict] = {}
    subgroups: list[dict] = []

    for raw_group in payload.get("sg") or payload.get("similaritySubgroups") or []:
        def map_item(value: object) -> str | None:
            if isinstance(value, int):
                return batch_assets[value]["id"] if 0 <= value < len(batch_assets) else None
            return value if isinstance(value, str) else None

        all_ids = [item for item in (map_item(v) for v in (raw_group.get("all") or raw_group.get("imageIds") or [])) if item]
        keep_ids = [item for item in (map_item(v) for v in (raw_group.get("keep") or raw_group.get("recommendedKeepIds") or [])) if item]

        if len(all_ids) >= 3:
            max_keep = max(1, math.ceil(len(all_ids) * 0.5))
            keep_ids = keep_ids[:max_keep]

        subgroup = {
            "id": raw_group.get("id") or raw_group.get("subgroupId") or "",
            "type": raw_group.get("type") or raw_group.get("subgroupType") or "unknown",
            "all_ids": all_ids,
            "keep_ids": keep_ids,
            "cull_ids": [asset_id for asset_id in all_ids if asset_id not in keep_ids],
        }
        subgroup_map[subgroup["id"]] = subgroup
        subgroups.append(subgroup)

    images: list[dict] = []
    for raw_img in payload.get("img") or payload.get("images") or []:
        if isinstance(raw_img, list):
            idx = raw_img[0] if len(raw_img) > 0 else None
            stars = raw_img[1] if len(raw_img) > 1 else 0
            category = raw_img[2] if len(raw_img) > 2 else "other"
            subgroup_id = raw_img[4] if len(raw_img) > 4 else None
            keep_cull = raw_img[5] if len(raw_img) > 5 else None
        else:
            idx = raw_img.get("i", raw_img.get("index"))
            stars = raw_img.get("s", raw_img.get("suggestedStars", 0))
            category = raw_img.get("c", raw_img.get("categories", ["other"]))
            subgroup_id = raw_img.get("g", raw_img.get("similaritySubgroupId"))
            keep_cull = raw_img.get("kc", raw_img.get("llmKeepCull"))

        if not isinstance(idx, int) or idx < 0 or idx >= len(batch_assets):
            continue

        categories = [expand_category(category)] if isinstance(category, str) else [expand_category(item) for item in category]
        llm_state = "keep" if keep_cull in ("k", "keep") else "cull" if keep_cull in ("c", "cull") else None
        asset_id = batch_assets[idx]["id"]

        if llm_state is None and subgroup_id in subgroup_map:
            subgroup = subgroup_map[subgroup_id]
            if asset_id in subgroup["keep_ids"]:
                llm_state = "keep"
            elif asset_id in subgroup["cull_ids"]:
                llm_state = "cull"

        images.append(
            {
                "asset_id": asset_id,
                "stars": int(stars or 0),
                "categories": categories,
                "subgroup_id": subgroup_id,
                "llm_state": llm_state,
            }
        )

    return images, subgroups


def format_category_list(counter: Counter, limit: int = 5) -> str:
    items = [f"{category} {count}" for category, count in counter.most_common(limit)]
    return ", ".join(items) if items else "none"


def build_summary(stats: dict) -> str:
    agreement_rate = stats["agree"] / stats["comparable"] if stats["comparable"] else 0.0
    llm_keep_rate = stats["llm_keep"] / stats["comparable"] if stats["comparable"] else 0.0
    user_keep_rate = stats["user_keep"] / stats["comparable"] if stats["comparable"] else 0.0
    subgroup_override_rate = (
        stats["subgroup_override"] / stats["subgroup_seen"] if stats["subgroup_seen"] else 0.0
    )

    star_line = (
        f"Stars: {stats['star_pairs']} user star overrides matched; average LLM-user delta {stats['star_avg_delta']:+.2f}."
        if stats["star_pairs"]
        else "Stars: no comparable user star overrides were present, so star calibration is inconclusive."
    )

    return "\n".join(
        [
            (
                f"Analyzed {stats['matched_runs']}/{stats['total_runs']} LLM runs ({stats['comparable']} comparable photos); "
                f"{stats['unmatched_runs']} runs were skipped because their saved fingerprints no longer match the current Facet batch set. "
                f"Agreement was {agreement_rate:.1%}. The LLM is more lenient than the user: it kept {llm_keep_rate:.1%} of comparable photos vs {user_keep_rate:.1%} kept by the user."
            ),
            (
                "Systematic disagreements: user culled photos the LLM kept mostly in "
                f"{format_category_list(stats['user_culls_llm_keeps'])}. "
                "User rescued some LLM culls mostly in "
                f"{format_category_list(stats['user_keeps_llm_culls'])}."
            ),
            (
                f"Subgroups were overridden in {stats['subgroup_override']}/{stats['subgroup_seen']} cases ({subgroup_override_rate:.1%}), "
                f"with the user keeping fewer images than the LLM in {stats['subgroup_user_kept_fewer']} subgroups and swapping ranked picks in {stats['subgroup_rank_swap']}."
            ),
            star_line,
            "Prompt changes:",
            "1. Make bursts and near-duplicates stricter: default to keep only the single best frame unless a second frame has a clearly different expression or action peak.",
            "2. Add a hard penalty for weak action/walking/running variants without sharp faces, eye contact, or a unique gesture.",
            "3. Treat vehicle and generic reference shots as culls unless they are emotionally meaningful, document something important, or are unusually well composed.",
            "4. For group/portrait sequences, explicitly prefer the frame with the best faces and cull alternate near-matches even if they are technically fine.",
            "5. Clarify `snapchat_save` handling: keep meaningful social context, text, or memory value; cull disposable saves that behave like screenshots.",
        ]
    )


def main() -> None:
    args = parse_args()
    state_db_path = args.state_db
    facet_db_path = args.facet_db

    if not state_db_path.exists():
        raise SystemExit(f"Missing state DB: {state_db_path}")
    if not facet_db_path.exists():
        raise SystemExit(f"Missing Facet DB: {facet_db_path}")

    batches_by_fingerprint = build_batches(load_assets(facet_db_path))

    state_conn = sqlite3.connect(state_db_path)
    state_conn.row_factory = sqlite3.Row
    runs = state_conn.execute(
        """
        SELECT id, batch_id, batch_fingerprint, response_json
        FROM llm_batch_runs
        WHERE response_json IS NOT NULL
        ORDER BY id
        """
    ).fetchall()
    photo_decisions = {
        row["asset_id"]: {"state": row["state"], "user_stars": row["user_stars"]}
        for row in state_conn.execute("SELECT asset_id, state, user_stars FROM photo_decisions")
    }

    counts = Counter()
    user_culls_llm_keeps: Counter = Counter()
    user_keeps_llm_culls: Counter = Counter()
    star_deltas: list[int] = []

    for run in runs:
        batch = batches_by_fingerprint.get(run["batch_fingerprint"])
        if batch is None:
            counts["unmatched_runs"] += 1
            continue

        counts["matched_runs"] += 1
        images, subgroups = parse_run(run["response_json"], batch["assets"])

        for image in images:
            decision = photo_decisions.get(image["asset_id"])
            if not decision or decision["state"] not in {"keep", "cull"}:
                continue

            if image["llm_state"] in {"keep", "cull"}:
                counts["comparable"] += 1
                counts[f"llm_{image['llm_state']}"] += 1
                counts[f"user_{decision['state']}"] += 1

                if image["llm_state"] == decision["state"]:
                    counts["agree"] += 1
                elif image["llm_state"] == "keep" and decision["state"] == "cull":
                    counts["llm_keep_user_cull"] += 1
                    for category in image["categories"]:
                        user_culls_llm_keeps[category] += 1
                elif image["llm_state"] == "cull" and decision["state"] == "keep":
                    counts["llm_cull_user_keep"] += 1
                    for category in image["categories"]:
                        user_keeps_llm_culls[category] += 1

            if decision["user_stars"] is not None:
                counts["star_pairs"] += 1
                star_deltas.append(image["stars"] - int(decision["user_stars"]))

        for subgroup in subgroups:
            subgroup_states = [photo_decisions.get(asset_id, {}).get("state") for asset_id in subgroup["all_ids"]]
            if not any(state in {"keep", "cull"} for state in subgroup_states):
                continue

            user_keep = {
                asset_id
                for asset_id in subgroup["all_ids"]
                if photo_decisions.get(asset_id, {}).get("state") == "keep"
            }
            llm_keep = set(subgroup["keep_ids"])

            counts["subgroup_seen"] += 1
            if user_keep == llm_keep:
                counts["subgroup_exact_match"] += 1
                continue

            counts["subgroup_override"] += 1
            if len(user_keep) < len(llm_keep):
                counts["subgroup_user_kept_fewer"] += 1
            elif len(user_keep) > len(llm_keep):
                counts["subgroup_user_kept_more"] += 1
            if (user_keep - llm_keep) and (llm_keep - user_keep):
                counts["subgroup_rank_swap"] += 1

    summary = build_summary(
        {
            "matched_runs": counts["matched_runs"],
            "total_runs": len(runs),
            "unmatched_runs": counts["unmatched_runs"],
            "comparable": counts["comparable"],
            "agree": counts["agree"],
            "llm_keep": counts["llm_keep"],
            "user_keep": counts["user_keep"],
            "user_culls_llm_keeps": user_culls_llm_keeps,
            "user_keeps_llm_culls": user_keeps_llm_culls,
            "subgroup_seen": counts["subgroup_seen"],
            "subgroup_override": counts["subgroup_override"],
            "subgroup_user_kept_fewer": counts["subgroup_user_kept_fewer"],
            "subgroup_rank_swap": counts["subgroup_rank_swap"],
            "star_pairs": counts["star_pairs"],
            "star_avg_delta": (sum(star_deltas) / len(star_deltas)) if star_deltas else 0.0,
        }
    )
    print(summary)


if __name__ == "__main__":
    main()
