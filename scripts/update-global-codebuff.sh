#!/bin/bash
# Build and install local codebuff CLI globally
# Usage: ./scripts/update-global-codebuff.sh
#
# This script:
# 1. Fetches latest from origin/main
# 2. Rebases your patch branch on top of origin/main
# 3. Builds the CLI and installs it globally
#
# Works with nvm, fnm, or system node.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_DIR="$PROJECT_ROOT/cli"

# Your personal patch branch
PATCH_BRANCH="reillyse/hippo-integration"

echo "🔄 Updating codebuff: rebase patches on latest main + install globally"
echo ""

# Get current version before update
CURRENT_VERSION=$(codebuff --version 2>/dev/null || echo "not installed")
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

# Use a dev version number for local builds
VERSION="0.0.0-local.$(date +%Y%m%d%H%M%S)"
echo "Building version: $VERSION"
echo ""

# Build the binary
echo "📦 Building CLI binary..."
cd "$CLI_DIR"
export npm_package_version="$VERSION"
bun run build:binary

# Check if binary was created
BINARY_PATH="$CLI_DIR/bin/codebuff"
if [ ! -f "$BINARY_PATH" ]; then
  echo "❌ Binary not found at: $BINARY_PATH"
  exit 1
fi

# Copy to global bin directory
echo ""
echo "📋 Installing to $GLOBAL_BIN/codebuff..."

# Remove existing binary first (may need to handle permissions)
if [ -f "$GLOBAL_BIN/codebuff" ]; then
  rm -f "$GLOBAL_BIN/codebuff" 2>/dev/null || {
    echo "⚠️  Need elevated permissions to replace existing binary"
    sudo rm -f "$GLOBAL_BIN/codebuff"
  }
fi

cp "$BINARY_PATH" "$GLOBAL_BIN/codebuff"
chmod +x "$GLOBAL_BIN/codebuff"

# Verify installation
echo ""
NEW_VERSION=$(codebuff --version 2>/dev/null || echo "unknown")
echo "✅ Installed: $NEW_VERSION"
echo "   Location: $(which codebuff)"
