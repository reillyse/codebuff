#!/bin/bash
# Build and install local codebuff-lite CLI globally (no git operations)
# Usage: ./scripts/build-codebuff-lite.sh
#
# This script:
# 1. Installs dependencies
# 2. Builds the cli-lite binary
# 3. Installs it globally
#
# Works with nvm, fnm, or system node.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_LITE_DIR="$PROJECT_ROOT/cli-lite"

echo "🔨 Building and installing codebuff-lite globally"
echo ""

# Get current version before build
CURRENT_VERSION=$(codebuff-lite --version 2>/dev/null || echo "not installed")
echo "Current global version: $CURRENT_VERSION"

cd "$PROJECT_ROOT"

# Reinstall dependencies in case they changed
echo "📦 Installing dependencies..."
bun install

echo ""

# Find where global npm binaries are installed
GLOBAL_BIN=$(npm config get prefix)/bin
if [ ! -d "$GLOBAL_BIN" ]; then
  echo "❌ Could not find global npm bin directory: $GLOBAL_BIN"
  exit 1
fi
echo "Global bin directory: $GLOBAL_BIN"

# Use a dev version number for local builds, including git SHA for traceability
GIT_SHA=$(cd "$PROJECT_ROOT" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
VERSION="0.0.0-local.$(date +%Y%m%d%H%M%S)+${GIT_SHA}"
echo "Building version: $VERSION"
echo ""

# Build the binary
echo "📦 Building CLI-lite binary..."
cd "$CLI_LITE_DIR"
export npm_package_version="$VERSION"
bun run build:binary

# Check if binary was created
BINARY_PATH="$CLI_LITE_DIR/bin/codebuff-lite"
if [ ! -f "$BINARY_PATH" ]; then
  echo "❌ Binary not found at: $BINARY_PATH"
  exit 1
fi

# Determine install targets:
# 1. Always install to the npm global bin dir
# 2. Also install to wherever `which codebuff-lite` currently resolves
#    (handles nvm, fnm, etc. where the active node bin differs from npm prefix)
INSTALL_TARGETS=("$GLOBAL_BIN/codebuff-lite")
WHICH_TARGET=$(which codebuff-lite 2>/dev/null || true)
if [ -n "$WHICH_TARGET" ] && [ "$WHICH_TARGET" != "$GLOBAL_BIN/codebuff-lite" ]; then
  INSTALL_TARGETS+=("$WHICH_TARGET")
fi

for TARGET in "${INSTALL_TARGETS[@]}"; do
  echo ""
  echo "📋 Installing to $TARGET..."
  if [ -f "$TARGET" ]; then
    rm -f "$TARGET" 2>/dev/null || {
      echo "⚠️  Need elevated permissions to replace $TARGET"
      sudo rm -f "$TARGET"
    }
  fi
  cp "$BINARY_PATH" "$TARGET"
  chmod +x "$TARGET"
done

# Verify installation
echo ""
NEW_VERSION=$(codebuff-lite --version 2>/dev/null || echo "unknown")
echo "✅ Installed: $NEW_VERSION"
echo "   Location: $(which codebuff-lite)"
