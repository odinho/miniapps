# Batch prediction mode

Vertex AI batch prediction processes many Gemini requests as a single job at
**~50% the cost** of real-time inference. Good fit for ranking thousands of
batches where latency doesn't matter.

## When to use it

| Mode                   | Throughput    | Latency    | Cost     | Setup         |
| ---------------------- | ------------- | ---------- | -------- | ------------- |
| `rank:many` (parallel) | ~1-2 batches/s | same       | standard | none          |
| `rank:batch:submit`    | 500+ in one go | 30min–2h   | 50% off  | GCS bucket    |

Rule of thumb:
- **< 100 batches** → `rank:many`
- **> 500 batches** or re-ranking the whole library → `rank:batch:submit`

## Prerequisites

1. **GCS bucket** in the same project (`tagrdevin`). Create one:

   ```bash
   gcloud storage buckets create gs://tagrdevin-immich-cull-batch \
     --project=tagrdevin --location=us-central1
   ```

2. **gcloud auth** — the SDK uses Application Default Credentials. Same
   credentials that get you Vertex AI access.

3. **Running server** — the CLI talks to localhost:3737 for prepared request
   bodies (image prep) and to ingest results.

## Workflow

```bash
# 1. Submit a job for 500 pending batches
npm run rank:batch:submit -- --bucket gs://tagrdevin-immich-cull-batch

# Output includes a job name and a sidecar file path:
#   Job name: projects/…/batchPredictionJobs/1234
#   Sidecar:  /tmp/batch-job-2026-04-13-12-34-56.json

# 2. Come back later and ingest results (uses the latest sidecar by default)
npm run rank:batch:status
```

`rank:batch:submit` flags:

| Flag            | Default                                            |
| --------------- | -------------------------------------------------- |
| `--bucket`      | required                                           |
| `--count N`     | 500 (batches per job)                              |
| `--concurrent N`| 8 (in-flight request-prep calls to the server)     |
| `--server URL`  | `http://localhost:3737`                            |
| `--model`       | default from `DEFAULT_LLM_CONFIG`                  |
| `--project`     | `tagrdevin`                                        |
| `--location`    | `us-central1` (batch is regional, not `global`)    |

`rank:batch:status` flags:

| Flag            | Default                                        |
| --------------- | ---------------------------------------------- |
| `--sidecar`     | most recent `/tmp/batch-job-*.json`            |
| `--server URL`  | `http://localhost:3737`                        |

## How it works internally

1. **Submit** writes a JSONL file where each line is `{"request": {contents, generationConfig}}`. Images are inline base64 at 1200px JPEG quality 75 — identical to the real-time path (same `LlmClient.prepareImageBuffers` + `buildGeminiContents`).
2. The JSONL is uploaded via `gcloud storage cp` to `gs://.../input-TIMESTAMP.jsonl`.
3. A Vertex batch prediction job is created with `dest: gs://.../output-TIMESTAMP/`.
4. A sidecar JSON file in `/tmp` records the job name and the ordered list of batch IDs — needed to map output lines back to batches.
5. **Status** checks the job via `@google/genai` `batches.get()`. When SUCCEEDED, it downloads the output JSONL via `gcloud storage cat`, parses each line (`response.candidates[0].content.parts[0].text` is the raw JSON), and POSTs results to `POST /api/batches/:id/llm-run` — same storage path as real-time (caches per-model in `llm_batch_runs`).

## Limits

- **Requests per job**: up to 30,000 (Vertex). Default count of 500 is conservative.
- **Per-request size**: each JSONL line is ~1-2 MB with 10 images. 500 batches ≈ 500-1000 MB input file. Fine for GCS; upload takes a few minutes.
- **Turnaround**: typically 30 min – 2 h for flash-lite. No SLA; small jobs often finish in minutes.
- **Location**: batch requires a regional endpoint. `us-central1` is the default. Gemini 3.x's `global` routing is only for real-time.

## Troubleshooting

- **"Job still running"** — just rerun `rank:batch:status` later; nothing lost.
- **"No result files found"** — Vertex writes files named `predictions.jsonl` or `prediction.results-*` into the output prefix. If neither exists, the job may have failed silently; check `job.error` in the status output.
- **Line count mismatch** — output may be sharded across multiple files; order within each shard matches input order but shards may come back in any order. For very large jobs, consider smaller `--count`.
- **"Failed to parse LLM response as JSON"** — same empty-response issue as real-time (transient). Those batches stay without LLM results and can be retried via `rank:many`.
- **GCS bucket access denied** — check `gcloud auth list` shows the expected account, and that it has `roles/storage.admin` (or at least objectCreator/objectViewer) on the bucket.

## Picking up failed batches

After an ingest, any batch that failed (empty response, HTTP error, parse error) stays with `hasLlmResult: false`. Run `rank:many` against those — the real-time path is more forgiving.
