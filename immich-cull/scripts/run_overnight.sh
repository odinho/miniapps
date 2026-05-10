#!/usr/bin/env bash
# Overnight work — cloud-only batch experiments, plus a final analysis + report dump.
# Ollama is kept free so the already-running v3 subgroup run can finish undisturbed.
#
# Phases (sequential, all cloud models):
#   1. Expand batch_adaptive to 50 batches (currently 15)
#   2. Expand batch_priorities to 50 batches (currently 15)
#   3. Run batch_v1_style (new variant) on 50 batches
#   4. Dump final analyses + markdown report
#
# Logs: /tmp/overnight.log
set -euo pipefail
cd "$(dirname "$0")/.."
LOG=/tmp/overnight.log
REPORT=docs/experiments/2026-04-21-overnight-report.md

# Cloud models only so we don't fight ollama.
CLOUD_MODELS="v1_prod,31flashlite_batch,3flash_batch"

{
  echo "=== overnight started $(date -Iseconds) ==="

  for prompt in batch_adaptive batch_priorities batch_v1_style; do
    echo ""
    echo "=== expanding $prompt to 50 batches ==="
    npx tsx scripts/batch_prompt_experiment.ts \
      --prompt "$prompt" \
      --models "$CLOUD_MODELS" \
      --batches 50 \
      --min-photos 8 \
      --server http://localhost:3737 \
      || echo "  [prompt=$prompt] exited non-zero, continuing"
  done

  echo ""
  echo "=== final analyses $(date -Iseconds) ==="
  python3 scripts/analyze_promptv3.py 2>&1 | tee /tmp/final-v3-analysis.txt
  python3 scripts/analyze_batch_experiment.py 2>&1 | tee /tmp/final-batch-analysis.txt

  echo ""
  echo "=== writing morning report ==="
  python3 scripts/morning_report.py > "$REPORT" || echo "report generation failed"

  echo ""
  echo "=== ALL DONE $(date -Iseconds) ==="
  echo "report at: $REPORT"
} > "$LOG" 2>&1
