#!/bin/bash
# Run gemma4:e4b on all batches, skip already-cached ones.
# Usage: bash scripts/run_all_gemma.sh 2>&1 | tee -a /tmp/gemma-run.log

set -euo pipefail
API="http://localhost:3737"
MODEL="gemma4:e4b"
TOTAL_START=$(date +%s)
SUCCESS=0
SKIPPED=0
FAILED=0
ERRORS=""

echo "=== Gemma4 batch run — $(date) ==="
echo "Model: $MODEL"
echo ""

# Get all batch IDs
BATCHES=$(curl -s "$API/api/batches" | python3 -c "
import sys, json
batches = json.load(sys.stdin)
for b in batches:
    print(b['id'] + '|' + str(b['count']))
")

TOTAL=$(echo "$BATCHES" | wc -l)
echo "Total batches: $TOTAL"
echo ""

i=0
for line in $BATCHES; do
    BATCH_ID=$(echo "$line" | cut -d'|' -f1)
    COUNT=$(echo "$line" | cut -d'|' -f2)
    i=$((i + 1))

    # Check if already cached
    CACHED=$(curl -s "$API/api/batches/$BATCH_ID?model=$MODEL" | python3 -c "
import sys, json
d = json.load(sys.stdin)
models = d.get('llmModels', [])
print('yes' if '$MODEL' in models else 'no')
" 2>/dev/null || echo "error")

    if [ "$CACHED" = "yes" ]; then
        SKIPPED=$((SKIPPED + 1))
        echo "[$i/$TOTAL] SKIP $BATCH_ID ($COUNT photos) — already cached"
        continue
    fi

    echo -n "[$i/$TOTAL] RUN  $BATCH_ID ($COUNT photos)... "
    START=$(date +%s)

    # Run the model
    RESULT=$(curl -s --max-time 600 "$API/api/batches/$BATCH_ID/rank?model=$MODEL" \
        -X POST 2>&1)

    END=$(date +%s)
    ELAPSED=$((END - START))

    # Check result
    HAS_ERROR=$(echo "$RESULT" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    if d.get('error'):
        print('error: ' + str(d['error'])[:100])
    elif d.get('response') or d.get('cached'):
        print('ok')
    else:
        print('unknown response')
except:
    print('json parse error')
" 2>/dev/null || echo "curl error")

    if [ "$HAS_ERROR" = "ok" ]; then
        SUCCESS=$((SUCCESS + 1))
        echo "OK (${ELAPSED}s)"
    else
        FAILED=$((FAILED + 1))
        echo "FAIL (${ELAPSED}s) — $HAS_ERROR"
        ERRORS="$ERRORS\n  $BATCH_ID: $HAS_ERROR"
    fi

    # Small delay to not overwhelm Ollama
    sleep 1
done

TOTAL_END=$(date +%s)
TOTAL_ELAPSED=$((TOTAL_END - TOTAL_START))
MINUTES=$((TOTAL_ELAPSED / 60))
SECONDS=$((TOTAL_ELAPSED % 60))

echo ""
echo "=== Summary — $(date) ==="
echo "Total: $TOTAL batches"
echo "Success: $SUCCESS"
echo "Skipped (cached): $SKIPPED"
echo "Failed: $FAILED"
echo "Time: ${MINUTES}m ${SECONDS}s"

if [ -n "$ERRORS" ]; then
    echo ""
    echo "Errors:"
    echo -e "$ERRORS"
fi
