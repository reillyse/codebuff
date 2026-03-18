#!/bin/bash
# Build and install local codebuff CLI globally (no git operations)
# Usage: ./scripts/build-codebuff.sh
#
# This script:
# 1. Installs dependencies
# 2. Builds the CLI binary
# 3. Installs it globally
#
# Works with nvm, fnm, or system node.
# For pulling latest upstream changes first, use update-global-codebuff.sh instead.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_DIR="$PROJECT_ROOT/cli"
CLAUDE_OAUTH_FILE="$PROJECT_ROOT/common/src/constants/claude-oauth.ts"

# Restore CLAUDE_OAUTH_ENABLED to false on exit (even on failure)
cleanup() {
  if [ -f "$CLAUDE_OAUTH_FILE" ]; then
    sed -i.bak 's/export const CLAUDE_OAUTH_ENABLED = true/export const CLAUDE_OAUTH_ENABLED = false/' "$CLAUDE_OAUTH_FILE"
    rm -f "${CLAUDE_OAUTH_FILE}.bak"
  fi
}
trap cleanup EXIT

echo "🔨 Building and installing codebuff globally"
echo ""

# Get current version before build
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

# Enable Claude OAuth for local builds
echo "🔑 Enabling CLAUDE_OAUTH_ENABLED for local build..."
sed -i.bak 's/export const CLAUDE_OAUTH_ENABLED = false/export const CLAUDE_OAUTH_ENABLED = true/' "$CLAUDE_OAUTH_FILE"
rm -f "${CLAUDE_OAUTH_FILE}.bak"

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
