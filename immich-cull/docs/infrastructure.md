# Infrastructure notes

## Immich connection

- Server: `192.168.10.74:2283` (Immich v2.5.2)
- Auth: API key in `.env` (`IMMICH_URL`, `IMMICH_API_KEY`)
- 72,688 total images, ~2000 Snapchat saves auto-filtered
- Asset list cached to `data/immich-assets-cache.json` — incremental fetch on restart (~1s vs ~30s cold)
- File sizes from Immich exifInfo (`withExif: true` on search)
- Image dimensions from Immich `width`/`height` fields (already rotation-corrected for most cameras)

## Vertex AI

- Project: `tagrdevin`
- Real-time: `@google/genai` with `vertexai: true`
- Gemini 3.x uses `location: "global"`, 2.x uses `europe-west1`
- Application Default Credentials via `odin@tana.inc`

## GCS bucket

- `gs://tagrdevin-immich-cull-batch` in us-central1
- Used by batch prediction CLI (currently limited to 2.x models)

## Known camera issues

- **Nikon D800E** NEF files: EXIF orientation tag is always 1 (normal) even for portrait shots. Rotation info is in proprietary MakerNote, not standard EXIF. Thumbnails from Immich are unrotated. This is a camera firmware bug — same issue in Immich's own UI.

## Auto-keep patterns

Regex patterns in `auto_keep_patterns` table, matched against asset path and filename. Excludes matching assets from batching entirely.

Current: `/Snapchat/Snapchat-` — filters ~2000 Snapchat saves (pre-curated by user, always keep).

Requires server restart. Use `--include-all` flag to bypass.
