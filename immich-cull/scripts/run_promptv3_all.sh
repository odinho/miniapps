#!/usr/bin/env bash
# Drive all v3 prompt × model combinations sequentially.
# Run in background; logs to /tmp/promptv3-run.log.
set -euo pipefail

cd "$(dirname "$0")/.."
LOG=/tmp/promptv3-run.log
MODELS="qwen_terse,gemma4_31b,gemma4_e4b,31flashlite"

{
  echo "=== v3 experiments started $(date -Iseconds) ==="
  for prompt in adaptive priorities min; do
    echo ""
    echo "=== PROMPT: $prompt ==="
    npx tsx scripts/prompt_v3_experiment.ts \
      --prompt "$prompt" \
      --models "$MODELS" \
      --server http://localhost:3737 \
      || echo "  [prompt=$prompt] exited non-zero, continuing"
  done
  echo ""
  echo "=== ALL DONE $(date -Iseconds) ==="
} > "$LOG" 2>&1
