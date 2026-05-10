#!/usr/bin/env bash
# Drive all batch-level prompt experiments sequentially.
# Cloud-only runs first (fast, no ollama contention).
# Local runs after — use smaller preview to fit context.
# Logs to /tmp/batch-run.log.
set -euo pipefail

cd "$(dirname "$0")/.."
LOG=/tmp/batch-run.log

{
  echo "=== batch experiments started $(date -Iseconds) ==="

  # Phase 1: cloud-only, 3 prompts
  for prompt in batch_adaptive batch_priorities batch_min; do
    echo ""
    echo "=== PROMPT: $prompt (cloud) ==="
    npx tsx scripts/batch_prompt_experiment.ts \
      --prompt "$prompt" \
      --models "v1_prod,31flashlite_batch,3flash_batch" \
      --batches 25 \
      --max-photos 50 \
      --min-photos 10 \
      --server http://localhost:3737 \
      || echo "  [prompt=$prompt cloud] exited non-zero, continuing"
  done

  # Phase 2: local models, smaller batches to fit context
  for prompt in batch_adaptive batch_priorities; do
    echo ""
    echo "=== PROMPT: $prompt (local) ==="
    npx tsx scripts/batch_prompt_experiment.ts \
      --prompt "$prompt" \
      --models "qwen_terse_batch,gemma4_e4b_batch" \
      --batches 15 \
      --max-photos 25 \
      --min-photos 10 \
      --local-preview 512 \
      --server http://localhost:3737 \
      || echo "  [prompt=$prompt local] exited non-zero, continuing"
  done

  echo ""
  echo "=== ALL DONE $(date -Iseconds) ==="
} > "$LOG" 2>&1
