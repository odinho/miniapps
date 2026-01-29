#!/bin/bash
# Install systemd user units for loffeblogg
#
# Usage: ./systemd/install.sh

set -e
cd "$(dirname "$0")/.."

WORKDIR="$(pwd)"
HOME_DIR="$HOME"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

echo "Installing systemd units..."
echo "  Working directory: $WORKDIR"
echo "  Systemd user dir: $SYSTEMD_USER_DIR"

mkdir -p "$SYSTEMD_USER_DIR"

# Install timer (no substitution needed)
cp systemd/loffeblogg.timer "$SYSTEMD_USER_DIR/"

# Install service with path substitution
sed -e "s|%WORKDIR%|$WORKDIR|g" \
    -e "s|%HOME%|$HOME_DIR|g" \
    systemd/loffeblogg.service > "$SYSTEMD_USER_DIR/loffeblogg.service"

# Reload and enable
systemctl --user daemon-reload
systemctl --user enable --now loffeblogg.timer

echo "Done! Timer status:"
systemctl --user status loffeblogg.timer --no-pager
