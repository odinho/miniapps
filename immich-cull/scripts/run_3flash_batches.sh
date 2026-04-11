#!/bin/bash
# Run gemini-3-flash-preview on 7 batches that have 3.1-lite but not 3-flash.
# Requires: npx tsx src/server.ts --local --vertex --port 3737

set -e
API="http://localhost:3737"
MODEL="gemini-3-flash-preview"

BATCHES=(
  "2024-03-24-b289638120b4"
  "2024-02-10-75515d02efc2"
  "2024-03-29-23dfb15bca68"
  "2024-01-13-d9e88b447969"
  "2024-05-13-31e8131d9fe9"
  "2024-05-04-bfd62461f9ed"
  "2024-03-02-96641cbec175"
)

echo "Running $MODEL on ${#BATCHES[@]} batches..."
echo

for batch in "${BATCHES[@]}"; do
  echo "=== $batch ==="
  result=$(curl -sS -X POST "$API/api/batches/$batch/rank?model=$MODEL" \
    -H "Content-Type: application/json")
  cached=$(echo "$result" | grep -o '"cached":[^,]*' | cut -d: -f2)
  if [ "$cached" = "true" ]; then
    echo "  Already cached"
  elif echo "$result" | grep -q '"error"'; then
    echo "  ERROR: $result"
  else
    echo "  Done (new result)"
  fi
  echo
done

echo "All batches processed. Run compare_models.py to see updated results."
