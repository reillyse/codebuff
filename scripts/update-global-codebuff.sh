#!/bin/bash
# Fetch latest upstream codebuff, rebase patches, then build and install globally
# Usage: ./scripts/update-global-codebuff.sh
#
# This script:
# 1. Fetches latest from origin/main
# 2. Rebases your patch branch on top of origin/main
# 3. Delegates to build-codebuff.sh to build and install globally
#
# If you just want to build without pulling upstream changes,
# use build-codebuff.sh instead.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Your personal patch branch
PATCH_BRANCH="reillyse/hippo-integration"

echo "🔄 Updating codebuff: fetch upstream + rebase patches + build"
echo ""

cd "$PROJECT_ROOT"

# Fetch latest from upstream
echo "⬇️  Fetching latest from origin/main..."
git fetch origin main

# Switch to patch branch if not already on it
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "$PATCH_BRANCH" ]; then
  echo "🔀 Switching to $PATCH_BRANCH..."
  git checkout "$PATCH_BRANCH"
fi

# Rebase patch branch on top of latest origin/main
echo "🔁 Rebasing $PATCH_BRANCH onto origin/main..."
if ! git rebase origin/main; then
  echo ""
  echo "❌ Rebase failed! Resolve conflicts, then run:"
  echo "   git rebase --continue"
  echo "   ./scripts/build-codebuff.sh"
  exit 1
fi

echo ""
echo "✅ Rebase successful"
echo ""

# Delegate to build script
exec "$SCRIPT_DIR/build-codebuff.sh"
