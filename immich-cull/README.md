# immich-cull

AI-assisted photo culling tool for [Immich](https://immich.app/). Groups similar photos (bursts, same scene over minutes) using CLIP embeddings, ranks them with Gemini LLM, and presents a keyboard-driven review UI for fast keep/cull decisions.

## Quick Start

```bash
# Install
cd immich-cull
npm install

# Local testing (uses Facet SQLite database)
npm run cluster:local -- --db /path/to/photo_scores_pro.db

# Start review UI
npm run review -- --port 3737
# Open http://localhost:3737

# With Immich (requires SSH tunnel to Immich PostgreSQL)
ssh -f -N -L 15432:<postgres-container-ip>:5432 user@immich-host
cp .env.example .env  # edit with your Immich DB credentials
npm run review:immich -- --port 3737
```

## How It Works

1. **Cluster**: Groups photos by time proximity + CLIP embedding cosine similarity. Finds bursts, same-scene sequences, and similar-perspective shots across a 60-minute window.

2. **Review**: Web UI shows all group images in a justified grid. Click to preview full-size. Keyboard shortcuts for fast keep/cull marking.

3. **Apply** (coming): Writes star ratings via Immich API, moves culled photos to Immich trash (30-day recovery), writes XMP sidecars.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` `→` | Navigate images |
| `↑` `↓` | Navigate groups |
| `K` / `J` | Keep selected |
| `X` / `F` | Cull selected |
| `B` | Keep selected, cull rest |
| `Shift+K` | Keep all |
| `Shift+X` | Cull all |
| `1`-`5` | Keep first N, cull rest |
| `Space` | Toggle full preview |
| `A` / `Enter` | Approve group & next |
| `S` | Skip group |
| `Backspace` | Undo last approve/skip |
| `Esc` | Close preview / back |
| `?` | Help |

## Data Sources

- **Facet SQLite**: For local testing without Immich. Uses CLIP ViT-L-14 embeddings (768-dim).
- **Immich PostgreSQL**: Production mode. Reads CLIP ViT-B-32 embeddings (512-dim) from `smart_search` table via read-only connection.

## Configuration

Copy `.env.example` to `.env` and set:

```
IMMICH_DB_HOST=localhost
IMMICH_DB_PORT=15432
IMMICH_DB_USER=postgres
IMMICH_DB_PASSWORD=<your-password>
IMMICH_DB_NAME=immich
```

Clustering thresholds are in `src/shared/types.ts` (`DEFAULT_CLUSTER_CONFIG`).

## Safety

- **Read-only database access** — never writes to Immich's PostgreSQL
- **All writes through Immich API** — documented, safe, forwards-compatible
- **Culled photos go to Immich trash** — 30-day recovery window
- **Undecided images default to keep** on approve
- **Backspace undo** — reverses last approve/skip
- **Existing star ratings are never auto-downgraded**

## Stack

TypeScript, Fastify, sharp, pg, better-sqlite3, @google/genai (coming)

## See Also

- [PLAN.md](PLAN.md) — roadmap and architecture decisions
