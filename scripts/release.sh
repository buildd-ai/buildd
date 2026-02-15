#!/usr/bin/env bash
set -euo pipefail

# Auto-version release script
# Scans conventional commits since last version tag to determine bump level:
#   feat:  → minor
#   fix:/chore:/etc → patch
#   BREAKING CHANGE or !: → major

CURRENT=$(node -p "require('./package.json').version")
echo "Current version: v$CURRENT"

# Find commits since last version tag (or all commits if no tag exists)
LAST_TAG=$(git describe --tags --abbrev=0 --match "v*" 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
  COMMITS=$(git log "$LAST_TAG"..HEAD --oneline --no-merges)
  echo "Commits since $LAST_TAG:"
else
  COMMITS=$(git log --oneline --no-merges -50)
  echo "No version tag found, scanning recent commits:"
fi

if [ -z "$COMMITS" ]; then
  echo "No new commits to release."
  exit 0
fi

echo "$COMMITS"
echo ""

# Determine bump level
BUMP="patch"
if echo "$COMMITS" | grep -qiE "BREAKING CHANGE|^[a-f0-9]+ \w+!:"; then
  BUMP="major"
elif echo "$COMMITS" | grep -qE "^[a-f0-9]+ feat(\(.+\))?:"; then
  BUMP="minor"
fi

# Bump version
npm version "$BUMP" --no-git-tag-version > /dev/null
NEW_VERSION=$(node -p "require('./package.json').version")
echo "Bump: $BUMP → v$NEW_VERSION"

# Commit version bump
git add package.json
git commit -m "chore: bump version to v$NEW_VERSION"

# Tag and push
git tag "v$NEW_VERSION"
git push origin HEAD --tags

# Create PR
gh pr create --base main --head dev \
  --title "v$NEW_VERSION" \
  --body "$(cat <<EOF
## v$NEW_VERSION

### Changes since ${LAST_TAG:-inception}
$(echo "$COMMITS" | sed 's/^/- /')
EOF
)" 2>/dev/null || echo "PR already exists — updating title..."

echo ""
echo "Released v$NEW_VERSION"
