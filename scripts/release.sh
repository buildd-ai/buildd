#!/usr/bin/env bash
# Create a release PR from dev → main with auto-detected semver.
# Uses conventional commits to determine bump: feat → minor, fix → patch, BREAKING CHANGE → major.
# Tags main with the version after merge.

set -euo pipefail

# PACKAGE_FILES env override lets the reusable workflow (buildd-ai/.github)
# point at any repo's layout. --tag keeps its own (read-only) default, so
# remember whether the caller set one.
PACKAGE_FILES_FROM_ENV="${PACKAGE_FILES:-}"
PACKAGE_FILES="${PACKAGE_FILES:-apps/runner/package.json apps/web/package.json packages/core/package.json packages/shared/package.json}"

# bump_versions SEMVER PREV_TAG REPO
# Promotes CHANGELOG [Unreleased] to SEMVER and writes SEMVER into every
# PACKAGE_FILES entry. Shared by the normal release and --hotfix: a hotfix that
# skips this ships a version main already has, and Tag Release cannot tag it.
bump_versions() {
  local semver="$1" prev_tag="$2" repo="$3"
  local today
  today=$(date -u +"%Y-%m-%d")

  if [ -f CHANGELOG.md ] && grep -q "^## \[Unreleased\]" CHANGELOG.md; then
    python3 - "$semver" "$today" "$prev_tag" "$repo" <<'PYEOF'
import sys, re

new_ver, today, prev_tag, repo = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

with open("CHANGELOG.md") as f:
    content = f.read()

# Find [Unreleased] section and check it has actual entries
m = re.search(r'^## \[Unreleased\](.*?)(?=^## \[)', content, re.MULTILINE | re.DOTALL)
if not m or not re.search(r'^- ', m.group(1), re.MULTILINE):
    print("  i  [Unreleased] has no entries - skipping promotion")
    sys.exit(0)

# Insert versioned header right after "## [Unreleased]\n"
content = content.replace("## [Unreleased]\n", f"## [Unreleased]\n\n## [{new_ver}] - {today}\n", 1)

# Update the [Unreleased] comparison link at the footer
content = re.sub(
    r'^\[Unreleased\]:.*$',
    f'[Unreleased]: https://github.com/{repo}/compare/v{new_ver}...HEAD\n[{new_ver}]: https://github.com/{repo}/compare/{prev_tag}...v{new_ver}',
    content,
    flags=re.MULTILINE,
)

with open("CHANGELOG.md", "w") as f:
    f.write(content)

print(f"  Promoted [Unreleased] -> [{new_ver}] ({today})")
PYEOF
  fi

  echo "Bumping package.json versions to ${semver}..."
  BUMPED_FILES=""
  for PKG in $PACKAGE_FILES; do
    if [ -f "$PKG" ]; then
      jq --arg v "$semver" '.version = $v' "$PKG" > tmp.json && mv tmp.json "$PKG"
      BUMPED_FILES="${BUMPED_FILES} ${PKG}"
      echo "  ✅ ${PKG} → ${semver}"
    fi
  done
}

# commit_version_bump NEW_VERSION — commits whatever bump_versions changed.
# Returns 1 when there was nothing to commit.
commit_version_bump() {
  local new_version="$1" files=""
  # shellcheck disable=SC2086
  if [ -n "$BUMPED_FILES" ] && ! git diff --quiet $BUMPED_FILES 2>/dev/null; then
    files="$BUMPED_FILES"
  fi
  if [ -f CHANGELOG.md ] && ! git diff --quiet CHANGELOG.md 2>/dev/null; then
    files="$files CHANGELOG.md"
  fi
  [ -z "$files" ] && return 1
  # shellcheck disable=SC2086
  git add $files
  git commit -m "chore: bump version to ${new_version}"
}


# Hotfix: create release PR from current branch → main (patch bump only)
if [ "${1:-}" = "--hotfix" ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "dev" ]; then
    echo "❌ Hotfix must be run from a feature/hotfix branch, not ${BRANCH}"
    exit 1
  fi

  # The version has to be one Tag Release can actually tag once this merges:
  # above every tag (including ones only origin has — a concurrent release),
  # and above what main's package.json already claims (an untagged prior ship).
  # Tag Release reads apps/web/package.json on main, so that is the file that
  # must move; bumping only the PR title ships a version that is already taken.
  git fetch --tags origin
  git fetch origin main

  LATEST_TAG=$(git tag --sort=-v:refname --list 'v*' | head -1)
  [ -z "$LATEST_TAG" ] && LATEST_TAG="v0.0.0"
  MAIN_VERSION=$(git show origin/main:apps/web/package.json 2>/dev/null | jq -r '.version // empty' 2>/dev/null || true)
  [ -z "$MAIN_VERSION" ] && MAIN_VERSION="0.0.0"

  BASE_VERSION=$(printf '%s\n%s\n' "${LATEST_TAG#v}" "$MAIN_VERSION" | sort -V | tail -1)
  IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE_VERSION"
  PATCH=$((PATCH + 1))
  SEMVER="${MAJOR}.${MINOR}.${PATCH}"
  NEW_VERSION="v${SEMVER}"

  echo "Hotfix: latest tag ${LATEST_TAG}, main at v${MAIN_VERSION} → ${NEW_VERSION} (patch)"

  # Defense-in-depth: NEW_VERSION is above every fetched tag by construction,
  # so this only fires if the computation above is ever changed.
  if git rev-parse -q --verify "refs/tags/${NEW_VERSION}" >/dev/null; then
    echo "❌ ${NEW_VERSION} is already tagged. Refusing to open a hotfix that cannot be tagged."
    exit 1
  fi

  # Another release/hotfix PR claiming the same version would leave whichever
  # merges second untagged. Fail closed if GitHub cannot be asked.
  # --limit: gh's default page is 30; missing a colliding PR must not pass.
  if ! OPEN_TITLES=$(gh pr list --state open --base main --limit 500 --json title --jq '.[].title'); then
    echo "❌ Could not list open PRs to check for a version collision; refusing to continue."
    exit 1
  fi
  if printf '%s\n' "$OPEN_TITLES" | grep -qE "^(Release|Hotfix) ${NEW_VERSION//./\\.}([^0-9.]|$)"; then
    echo "❌ An open PR is already titled 'Release/Hotfix ${NEW_VERSION}'. Merge or close it first, then re-run."
    exit 1
  fi

  # Re-run after a failed push / `gh pr create`: the bump commit is already on
  # this branch, and origin/main has not moved, so the same version comes out.
  # Re-bumping would change nothing, so reuse the existing commit.
  HEAD_VERSION=$(jq -r '.version // empty' apps/web/package.json 2>/dev/null || true)
  if [ "$HEAD_VERSION" = "$SEMVER" ] \
     && git log origin/main..HEAD --format='%s' | grep -qxF "chore: bump version to ${NEW_VERSION}"; then
    echo "  i  ${NEW_VERSION} bump already committed on ${BRANCH} (earlier run) — reusing it"
  else
    REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "buildd-ai/buildd")
    bump_versions "$SEMVER" "$LATEST_TAG" "$REPO"
    if ! commit_version_bump "$NEW_VERSION"; then
      echo "❌ Version bump to ${NEW_VERSION} changed no files. Check PACKAGE_FILES, or whether this branch already carries a partial bump commit (git log origin/main..HEAD). Refusing to open an untaggable hotfix."
      exit 1
    fi
  fi

  BODY=$(cat <<EOF
## ${NEW_VERSION} (hotfix)

### Changes
$(git log origin/main..HEAD --format='- %s' --no-merges 2>/dev/null | grep -v 'chore: bump version' | head -10 || true)

---
*Hotfix — auto-generated by \`bun run release -- --hotfix\`*
EOF
)

  # Push branch and create PR targeting main
  git push -u origin "$BRANCH"
  gh pr create --base main --head "$BRANCH" --title "Hotfix ${NEW_VERSION}" --body "$BODY"
  echo ""
  echo "⚠️  After merging: git checkout dev && git merge origin/main && git push origin dev"
  exit 0
fi

# Manual tag: create git tag + GitHub release from package.json version on current main HEAD.
# Useful when release-tag.yml was bypassed (e.g., agent merged without PR title match).
if [ "${1:-}" = "--tag" ]; then
  # Read version from the first package.json in PACKAGE_FILES that exists.
  # Default keeps backwards compatibility with buildd's layout.
  PACKAGE_FILES="${PACKAGE_FILES_FROM_ENV:-apps/web/package.json package.json}"
  SEMVER=""
  for PKG in $PACKAGE_FILES; do
    if [ -f "$PKG" ]; then
      SEMVER=$(jq -r '.version' "$PKG" 2>/dev/null)
      [ -n "$SEMVER" ] && [ "$SEMVER" != "null" ] && break
    fi
  done
  if [ -z "$SEMVER" ] || [ "$SEMVER" = "null" ]; then
    echo "Could not read version from any of: $PACKAGE_FILES"
    exit 1
  fi
  TAG="v${SEMVER}"

  # Ensure we're on main with latest
  git fetch origin main
  git checkout main
  git pull origin main --ff-only

  # Check if tag already exists
  if git rev-parse "$TAG" >/dev/null 2>&1; then
    echo "Tag ${TAG} already exists"
    exit 0
  fi

  echo "Creating tag ${TAG} on main..."
  git tag "$TAG"
  git push origin "$TAG"

  # Build release notes from previous tag
  PREV_TAG=$(git tag --sort=-v:refname --list 'v*' | grep -v "^${TAG}$" | head -1)
  if [ -n "$PREV_TAG" ]; then
    NOTES=$(git log "${PREV_TAG}..${TAG}" --format='- %s' --no-merges | grep -v 'chore: bump version')
  else
    NOTES="Initial release"
  fi
  [ -z "$NOTES" ] && NOTES="See git log for details."

  gh release create "$TAG" --title "$TAG" --notes "$NOTES"
  echo "Created GitHub release ${TAG}"
  exit 0
fi

# Finalize: reset dev to main after the release PR has been merged. Use after
# `bun run release` → PR merge → `bun run release:finalize`. Keeps dev's history
# identical to main so future release PRs aren't cluttered with prior releases'
# individual commits (which linger because each release squashes to main).
#
# Destructive: force-pushes dev. Aborts if dev has commits not yet on main
# (something landed on dev between the release merge and finalize).
if [ "${1:-}" = "--finalize" ]; then
  git fetch origin --prune

  # Compare file contents (not commit history). Each release squashes to main
  # so the individual commits live on in dev with different SHAs — looking at
  # commit messages would always trip. The only thing we care about is whether
  # dev contains file changes that didn't make it into main.
  #
  # Exclude package.json version bumps (transiently differ between version-bump
  # commit on dev and the squashed release on main).
  DIFF=$(git diff --name-only origin/main..origin/dev -- . \
    ':(exclude)apps/*/package.json' \
    ':(exclude)packages/*/package.json' \
    ':(exclude)package.json' 2>/dev/null || true)

  if [ -n "$DIFF" ]; then
    echo "❌ dev has file changes that aren't on main yet:"
    echo "$DIFF" | sed 's/^/   /'
    echo ""
    echo "Merge or stash them before finalizing. Re-run with --finalize-force to override."
    exit 1
  fi

  echo "Resetting origin/dev to origin/main..."
  git checkout dev
  git reset --hard origin/main
  git push --force-with-lease origin dev
  echo "  ✅ dev is now identical to main"
  exit 0
fi

# Same as --finalize but skips the "dev has unreleased commits" check.
# Use only when you've inspected the diff and know what you're discarding.
if [ "${1:-}" = "--finalize-force" ]; then
  git fetch origin --prune
  echo "⚠️  Force-resetting dev to main (skipping unreleased-commit check)..."
  git checkout dev
  git reset --hard origin/main
  git push --force-with-lease origin dev
  echo "  ✅ dev is now identical to main"
  exit 0
fi

# Post-release cleanup: delete branches already in main
if [ "${1:-}" = "--cleanup" ]; then
  echo "🧹 Cleaning up stale branches..."
  git fetch origin --prune

  DELETED=0
  for branch in $(git branch -r --no-merged origin/main | grep 'origin/' | grep -v 'origin/main$' | grep -v 'origin/dev$' | grep -v 'origin/HEAD' | sed 's|origin/||'); do
    # Check if all commits in this branch are already in main (squash-merged)
    NEW_COMMITS=0
    for commit in $(git log origin/main..origin/$branch --format=%H --no-merges 2>/dev/null); do
      msg=$(git log -1 --format=%s "$commit" | cut -c1-40)
      if ! git log origin/main --oneline --grep="$msg" --fixed-strings 2>/dev/null | grep -q .; then
        NEW_COMMITS=$((NEW_COMMITS + 1))
      fi
    done

    if [ "$NEW_COMMITS" -eq 0 ]; then
      echo "  ✅ Deleting $branch (all changes in main)"
      git push origin --delete "$branch" 2>/dev/null || true
      DELETED=$((DELETED + 1))
    else
      echo "  ⏭️  Keeping $branch ($NEW_COMMITS unmerged commits)"
    fi
  done

  echo ""
  echo "🧹 Deleted $DELETED stale branches"
  exit 0
fi

# Switch to dev if not already there
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "dev" ]; then
  echo "Switching to dev (was on ${CURRENT_BRANCH})..."
  git checkout dev
fi

# Ensure dev is up-to-date with main to avoid PR conflicts
echo "Syncing main into dev..."
git fetch origin
git pull origin dev --ff-only 2>/dev/null || true
if ! git merge origin/main --no-edit 2>/dev/null; then
  echo "❌ Merge conflicts when syncing main into dev."
  echo "   Resolve conflicts, commit, then re-run: bun run release"
  exit 1
fi
echo "  ✅ dev is up-to-date with main"

# Get the latest version tag, default to v0.0.0
LATEST_TAG=$(git tag --sort=-v:refname --list 'v*' | head -1)
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="v0.0.0"
fi

# Parse current version
VERSION="${LATEST_TAG#v}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

# Determine bump from commits since last tag
if [ "$LATEST_TAG" = "v0.0.0" ]; then
  COMMITS=$(git log origin/main..dev --format='%s' --no-merges 2>/dev/null || git log --format='%s' --no-merges -50)
else
  COMMITS=$(git log "${LATEST_TAG}..dev" --format='%s' --no-merges 2>/dev/null || echo "")
fi

BUMP="patch"
while IFS= read -r msg; do
  [ -z "$msg" ] && continue
  if echo "$msg" | grep -qiE 'BREAKING[ -]CHANGE|^[a-z]+!:'; then
    BUMP="major"
    break
  elif echo "$msg" | grep -qE '^feat(\(.+\))?:'; then
    BUMP="minor"
  fi
done <<< "$COMMITS"

# Apply bump
case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

NEW_VERSION="v${MAJOR}.${MINOR}.${PATCH}"
SEMVER="${MAJOR}.${MINOR}.${PATCH}"

echo "Current: ${LATEST_TAG} → New: ${NEW_VERSION} (${BUMP} bump)"

REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "buildd-ai/buildd")
bump_versions "$SEMVER" "$LATEST_TAG" "$REPO"

# Commit version bump + CHANGELOG promotion to dev (if anything changed)
if commit_version_bump "$NEW_VERSION"; then
  git push origin dev
  echo "Committed version bump to dev"
fi

# Build PR body with commit summary
BODY=$(cat <<EOF
## ${NEW_VERSION}

### Changes
$(git log "${LATEST_TAG}..dev" --format='- %s' --no-merges 2>/dev/null | head -30)

---
*Auto-generated by \`bun run release\`*
EOF
)

# Create or update PR
EXISTING_PR=$(gh pr list --base main --head dev --json number --jq '.[0].number' 2>/dev/null || echo "")

if [ -n "$EXISTING_PR" ]; then
  gh api "repos/${REPO}/pulls/${EXISTING_PR}" --method PATCH \
    -f title="Release ${NEW_VERSION}" -f body="$BODY" --silent
  echo "Updated PR #${EXISTING_PR}: Release ${NEW_VERSION}"
  echo "https://github.com/${REPO}/pull/${EXISTING_PR}"
else
  gh pr create --base main --head dev --title "Release ${NEW_VERSION}" --body "$BODY"
fi

# Note: when this PR merges, two workflows fire automatically:
#   - release-tag.yml tags main and creates the GitHub release (title must match "Release v...")
#   - sync-dev.yml resets dev to main so future release PRs stay clean
# If either is bypassed, the manual escape hatches are:
#   bun run release -- --tag        (manually tag/release main HEAD)
#   bun run release -- --finalize   (manually reset dev to main)
