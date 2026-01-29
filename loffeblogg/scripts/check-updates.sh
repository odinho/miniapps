#!/bin/bash
# Check for Google Doc updates and rebuild if needed
#
# Usage:
#   ./scripts/check-updates.sh              # Check existing docs
#   ./scripts/check-updates.sh --check-new  # Also check for new docs
#
# Exit codes:
#   0 = Changes detected and rebuilt
#   1 = Error
#   2 = No changes

set -e
cd "$(dirname "$0")/.."

# Check for updates (exit 0=changes, 2=no changes, 1=error)
node src/check-updates.js "$@"
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
  echo "Rebuilding..."
  node src/build.js --force && npx @11ty/eleventy
elif [[ $EXIT_CODE -eq 2 ]]; then
  exit 2
else
  exit 1
fi
