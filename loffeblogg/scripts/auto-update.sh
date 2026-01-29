#!/bin/bash
# Auto-update script for systemd timer
# Checks for updates, rebuilds if needed, and deploys
#
# Usage: ./scripts/auto-update.sh

set -e
cd "$(dirname "$0")/.."

LOG_PREFIX="[loffeblogg]"

echo "$LOG_PREFIX Starting auto-update at $(date)"

# Check for new documents less frequently (every 6 runs = ~3 hours with 30min timer)
CHECK_NEW_INTERVAL=6
COUNTER_FILE="cache/meta/check-new-counter"

# Initialize or read counter
if [[ -f "$COUNTER_FILE" ]]; then
  COUNTER=$(cat "$COUNTER_FILE")
else
  COUNTER=0
fi

# Determine if we should check for new documents
CHECK_NEW_FLAG=""
if (( COUNTER >= CHECK_NEW_INTERVAL )); then
  CHECK_NEW_FLAG="--check-new"
  COUNTER=0
  echo "$LOG_PREFIX Checking for new documents (every ${CHECK_NEW_INTERVAL} runs)"
else
  ((COUNTER++))
fi
echo "$COUNTER" > "$COUNTER_FILE"

# Run check-updates, capture exit code
set +e
./scripts/check-updates.sh $CHECK_NEW_FLAG
EXIT_CODE=$?
set -e

case $EXIT_CODE in
  0)
    echo "$LOG_PREFIX Changes detected, deploying..."
    rsync -avz --delete _site/ odin@hetzner.s0.no:loffetur.s0.no/
    echo "$LOG_PREFIX Deploy complete at $(date)"
    ;;
  2)
    echo "$LOG_PREFIX No changes detected"
    ;;
  *)
    echo "$LOG_PREFIX Error during update (exit code: $EXIT_CODE)"
    exit 1
    ;;
esac
