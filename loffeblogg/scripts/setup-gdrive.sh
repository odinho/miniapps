#!/bin/bash
# Download and setup gdrive CLI for automatic document discovery
#
# Downloads gdrive v3 from https://github.com/glotlabs/gdrive/releases
# Installs to cache/gdrive/gdrive (local to project)
#
# After running this script, authenticate with: gdrive account add

set -e

VERSION="3.9.1"
INSTALL_DIR="cache/gdrive"
BINARY="$INSTALL_DIR/gdrive"

cd "$(dirname "$0")/.."

# Check if already installed
if [[ -x "$BINARY" ]]; then
  INSTALLED_VERSION=$("$BINARY" version 2>/dev/null | head -1 | awk '{print $2}')
  echo "gdrive $INSTALLED_VERSION already installed at $BINARY"
  exit 0
fi

# Check if globally available
if command -v gdrive &>/dev/null; then
  GLOBAL_PATH=$(which gdrive)
  GLOBAL_VERSION=$(gdrive version 2>/dev/null | head -1 | awk '{print $2}')
  echo "gdrive $GLOBAL_VERSION found globally at $GLOBAL_PATH"
  echo "No local install needed."
  exit 0
fi

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  linux)  PLATFORM="linux-x64" ;;
  darwin) PLATFORM="macos-x64" ;;
  *)
    echo "❌ Unsupported OS: $OS"
    echo "   Download manually from https://github.com/glotlabs/gdrive/releases"
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64) ;; # Already set above
  arm64|aarch64)
    echo "⚠ ARM64 not officially supported, trying x64 (may work via emulation)"
    ;;
  *)
    echo "❌ Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

URL="https://github.com/glotlabs/gdrive/releases/download/${VERSION}/gdrive_${PLATFORM}.tar.gz"

echo "Downloading gdrive v${VERSION} for ${PLATFORM}..."
echo "URL: $URL"
echo

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Download and extract
curl -fsSL "$URL" | tar -xz

# Make executable
chmod +x gdrive

echo
echo "✓ Installed gdrive to $(pwd)/gdrive"
echo
echo "Next steps:"
echo "  1. Authenticate: ./cache/gdrive/gdrive account add"
echo "  2. Build: npm run build"
echo
