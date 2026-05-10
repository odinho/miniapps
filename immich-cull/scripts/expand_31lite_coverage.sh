#!/bin/bash
# Run gemini-3.1-flash-lite-preview on reviewed batches that only have Gemma4 data.
# This expands our analysis dataset from 20 to 70+ batches for better statistical significance.
#
# Requires server: npx tsx src/server.ts --local --vertex --port 3737

set -e
API="http://localhost:3737"
MODEL="gemini-3.1-flash-lite-preview"

# Get target batches from the database
BATCHES=$(python3 -c "
import sqlite3
conn = sqlite3.connect('data/state.db')
conn.row_factory = sqlite3.Row
reviewed = set(r['view_id'] for r in conn.execute('SELECT view_id FROM view_status WHERE view_type=\"batch\" AND status=\"reviewed\"'))
runs = conn.execute('SELECT DISTINCT batch_id, model FROM llm_batch_runs WHERE status=\"completed\"').fetchall()
batch_models = {}
for r in runs:
    batch_models.setdefault(r['batch_id'], set()).add(r['model'])
targets = [b for b in sorted(batch_models) if b in reviewed and 'gemma4:e4b' in batch_models[b] and 'gemini-3.1-flash-lite-preview' not in batch_models[b]]
# Take first 50
for b in targets[:50]:
    print(b)
conn.close()
")

TOTAL=$(echo "$BATCHES" | wc -l)
echo "Running $MODEL on $TOTAL batches..."
echo

COUNT=0
ERRORS=0
for batch in $BATCHES; do
  COUNT=$((COUNT + 1))
  echo -n "[$COUNT/$TOTAL] $batch ... "

  result=$(curl -sS -X POST "$API/api/batches/$batch/rank?model=$MODEL" 2>&1)

  if echo "$result" | grep -q '"cached":true'; then
    echo "cached"
  elif echo "$result" | grep -q '"error"'; then
    error=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','?'))" 2>/dev/null)
    echo "ERROR: $error"
    ERRORS=$((ERRORS + 1))
  else
    tokens=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{d.get(\"inputTokens\",0)} in / {d.get(\"outputTokens\",0)} out')" 2>/dev/null)
    echo "done ($tokens)"
  fi
done

echo
echo "Completed: $COUNT batches, $ERRORS errors"
echo "Now re-extract data: python3 scripts/extract_autocull_data.py --all-models"
