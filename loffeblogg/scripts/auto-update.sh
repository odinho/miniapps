#!/bin/bash
# Auto-update script for systemd timer
# Checks for updates, rebuilds if needed, and deploys
#
# Usage: ./scripts/auto-update.sh

set -e
cd "$(dirname "$0")/.."

LOG_PREFIX="[loffeblogg]"

echo "$LOG_PREFIX Starting auto-update at $(date)"

# Run check-updates, capture exit code
set +e
./scripts/check-updates.sh
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
