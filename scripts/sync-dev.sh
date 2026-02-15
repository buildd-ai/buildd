#!/bin/bash
set -e

echo "🔄 Syncing dev with main after squash merge..."

# Ensure we're on dev
git checkout dev

# Fetch latest
echo "📡 Fetching latest from origin..."
git fetch origin

# Find commits in dev that aren't in main
echo ""
echo "📝 Commits in dev that will be preserved:"
git log origin/main..HEAD --oneline --no-merges

echo ""
read -p "Continue with sync? This will reset dev to main and cherry-pick the above commits. (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Aborted"
    exit 1
fi

# Save current commits to temp branch
TEMP_BRANCH="temp-dev-$(date +%s)"
git branch $TEMP_BRANCH

echo "✅ Saved current dev to $TEMP_BRANCH"

# Get list of commits to cherry-pick (excluding merge commits)
COMMITS=$(git log origin/main..HEAD --no-merges --reverse --format=%H)

if [ -z "$COMMITS" ]; then
    echo "⚠️  No commits to preserve, just resetting to main"
    git reset --hard origin/main
    git push --force origin dev
    echo "✅ Dev synced with main"
    exit 0
fi

# Reset to main
echo "🔄 Resetting dev to main..."
git reset --hard origin/main

# Cherry-pick commits one by one
echo "🍒 Cherry-picking commits..."
for commit in $COMMITS; do
    echo "  Applying $(git log -1 --oneline $commit)"
    if ! git cherry-pick $commit 2>&1; then
        # Check if it's an empty commit (already applied in squash merge)
        if git status | grep -q "nothing to commit"; then
            echo "    ⏭️  Skipping (already in main)"
            git cherry-pick --skip
            continue
        fi
        echo ""
        echo "❌ Cherry-pick conflict! Resolve conflicts, then run:"
        echo "   git cherry-pick --continue"
        echo "   # repeat until done, then:"
        echo "   git push --force origin dev"
        echo ""
        echo "Or abort with: git cherry-pick --abort && git reset --hard $TEMP_BRANCH"
        exit 1
    fi
done

# Push
echo "⬆️  Force pushing to origin/dev..."
git push --force origin dev

echo ""
echo "✅ Dev synced successfully!"
echo "   Temp branch: $TEMP_BRANCH (delete with: git branch -D $TEMP_BRANCH)"
