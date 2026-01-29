#!/bin/bash
# Check for Google Doc updates using rclone or gdrive CLI
#
# Backend priority: rclone > gdrive
# rclone is preferred (tokens don't expire after 7 days)
#
# Usage:
#   ./scripts/check-updates.sh              # Check existing docs
#   ./scripts/check-updates.sh --check-new  # Also check for new docs in folder
#
# Exit codes:
#   0 = Changes detected and rebuilt successfully
#   1 = Error (build failed, auth issue, etc.)
#   2 = No changes detected
#
# Example with deploy:
#   ./scripts/check-updates.sh && npm run deploy
#
# Documents prefixed "Kopi av " (Google's copy prefix) are ignored.

set -e
cd "$(dirname "$0")/.."

CONFIG_FILE="config.json"
META_FILE="cache/meta/documents.json"
CHECK_NEW=false
BACKEND=""

# Detect backend: prefer rclone
if command -v rclone &>/dev/null && rclone listremotes 2>/dev/null | grep -q "^drive:"; then
  BACKEND="rclone"
elif [[ -x "cache/gdrive/gdrive" ]]; then
  BACKEND="gdrive"
  GDRIVE="./cache/gdrive/gdrive"
elif command -v gdrive &>/dev/null; then
  BACKEND="gdrive"
  GDRIVE="gdrive"
else
  echo "❌ No Drive backend found."
  echo "   Install rclone: sudo apt install rclone && rclone config"
  echo "   Or gdrive: npm run setup:gdrive"
  exit 1
fi

echo "Using backend: $BACKEND"

[[ "$1" == "--check-new" ]] && CHECK_NEW=true

# Ensure meta directory exists
mkdir -p cache/meta

# Initialize meta file if missing
[[ -f "$META_FILE" ]] || echo '{}' > "$META_FILE"

NEEDS_REBUILD=false

# Read config
FOLDER_ID=$(jq -r '.folderId' "$CONFIG_FILE")

# Get known documents from meta cache (populated by previous builds)
DOC_IDS=$(jq -r 'keys[]' "$META_FILE" 2>/dev/null)

if [[ -z "$DOC_IDS" ]]; then
  echo "No cached documents found. Run 'npm run build' first to populate cache."
  echo "Or use --check-new to discover documents from Drive folder."
  $CHECK_NEW || exit 0
fi

echo "Checking for document updates..."
echo

# ============ RCLONE BACKEND ============
if [[ "$BACKEND" == "rclone" ]]; then
  # Fetch all docs in one call (efficient!)
  DRIVE_DOCS=$(rclone lsjson --drive-root-folder-id "$FOLDER_ID" drive: 2>/dev/null) || {
    echo "❌ Failed to list folder via rclone"
    exit 1
  }

  # Check each cached document
  for DOC_ID in $DOC_IDS; do
    # Find doc in the JSON response
    DOC_INFO=$(echo "$DRIVE_DOCS" | jq -r --arg id "$DOC_ID" '.[] | select(.ID == $id)')

    if [[ -z "$DOC_INFO" ]]; then
      echo "  ⚠ $DOC_ID: Not found in folder (deleted?)"
      continue
    fi

    DOC_NAME=$(echo "$DOC_INFO" | jq -r '.Name' | sed -E 's/\.(docx|gdoc)$//')
    MODIFIED=$(echo "$DOC_INFO" | jq -r '.ModTime')

    # Get cached modified time
    CACHED=$(jq -r --arg id "$DOC_ID" '.[$id].modifiedTime // ""' "$META_FILE")

    if [[ "$MODIFIED" != "$CACHED" ]]; then
      echo "  ✓ $DOC_NAME: Changed ($MODIFIED)"
      # Update cache
      jq --arg id "$DOC_ID" --arg time "$MODIFIED" --arg name "$DOC_NAME" \
        '.[$id] = {modifiedTime: $time, name: $name}' "$META_FILE" > "$META_FILE.tmp" \
        && mv "$META_FILE.tmp" "$META_FILE"
      NEEDS_REBUILD=true
    else
      echo "  · $DOC_NAME: No changes"
    fi
  done

  # Check for new documents
  if $CHECK_NEW; then
    echo
    echo "Checking for new documents in folder..."

    KNOWN_IDS=$(jq -r 'keys[]' "$META_FILE" 2>/dev/null)
    NEW_DOCS_FOUND=false

    while IFS= read -r DOC_INFO; do
      [[ -z "$DOC_INFO" ]] && continue

      NEW_ID=$(echo "$DOC_INFO" | jq -r '.ID')
      NEW_NAME=$(echo "$DOC_INFO" | jq -r '.Name' | sed -E 's/\.(docx|gdoc)$//')
      IS_DIR=$(echo "$DOC_INFO" | jq -r '.IsDir')

      # Skip directories and copies
      [[ "$IS_DIR" == "true" ]] && continue
      [[ "$NEW_NAME" == "Kopi av "* ]] && continue

      if ! echo "$KNOWN_IDS" | grep -q "^${NEW_ID}$"; then
        echo "  📄 New document: $NEW_NAME"
        echo "     ID: $NEW_ID"
        NEW_DOCS_FOUND=true
      fi
    done < <(echo "$DRIVE_DOCS" | jq -c '.[]')

    if $NEW_DOCS_FOUND; then
      NEEDS_REBUILD=true
    fi
  fi

# ============ GDRIVE BACKEND ============
else
  # Check each cached document
  for DOC_ID in $DOC_IDS; do
    # Get current info from Google Drive
    INFO=$($GDRIVE files info "$DOC_ID" 2>/dev/null) || {
      echo "  ⚠ $DOC_ID: Failed to get info (auth issue?)"
      continue
    }

    DOC_NAME=$(echo "$INFO" | grep -i "^Name:" | sed 's/^Name: *//')
    MODIFIED=$(echo "$INFO" | grep -i "^Modified:" | sed 's/^Modified: *//')

    # Get cached modified time
    CACHED=$(jq -r --arg id "$DOC_ID" '.[$id].modifiedTime // ""' "$META_FILE")

    if [[ "$MODIFIED" != "$CACHED" ]]; then
      echo "  ✓ $DOC_NAME: Changed ($MODIFIED)"
      # Update cache
      jq --arg id "$DOC_ID" --arg time "$MODIFIED" --arg name "$DOC_NAME" \
        '.[$id] = {modifiedTime: $time, name: $name}' "$META_FILE" > "$META_FILE.tmp" \
        && mv "$META_FILE.tmp" "$META_FILE"
      NEEDS_REBUILD=true
    else
      echo "  · $DOC_NAME: No changes"
    fi
  done

  # Optionally check for new documents
  if $CHECK_NEW; then
    echo
    echo "Checking for new documents in folder..."

    # List all Google Docs in folder
    FOLDER_DOCS=$($GDRIVE files list --query "'$FOLDER_ID' in parents and mimeType='application/vnd.google-apps.document'" 2>/dev/null) || {
      echo "  ⚠ Failed to list folder"
    }

    # Extract IDs we already know about (from meta cache)
    KNOWN_IDS=$(jq -r 'keys[]' "$META_FILE" 2>/dev/null)

    # Parse gdrive output (skip header line)
    # Format: Id  Name  Type  Size  Created
    NEW_DOCS_FOUND=false
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      NEW_ID=$(echo "$line" | awk '{print $1}')
      # Name is between ID and "document" type
      NEW_NAME=$(echo "$line" | sed -E 's/^[^ ]+\s+//' | sed -E 's/\s+document\s+.*//')

      # Skip copies and already-known docs
      if [[ "$NEW_NAME" == "Kopi av "* ]]; then
        continue
      fi
      if ! echo "$KNOWN_IDS" | grep -q "^${NEW_ID}$"; then
        echo "  📄 New document: $NEW_NAME"
        echo "     ID: $NEW_ID"
        NEW_DOCS_FOUND=true
      fi
    done < <(echo "$FOLDER_DOCS" | tail -n +2)

    if $NEW_DOCS_FOUND; then
      NEEDS_REBUILD=true
    fi
  fi
fi

echo

if $NEEDS_REBUILD; then
  echo "🔨 Changes detected, rebuilding..."
  node src/build.js --force && npx @11ty/eleventy
  # Exit 0 = rebuilt successfully
else
  echo "✓ No changes detected"
  exit 2  # Exit 2 = no changes (not an error, just nothing to do)
fi
