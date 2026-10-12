#!/usr/bin/env bash
# Release entry point. The default path dispatches .github/workflows/release.yml
# (one implementation for local and scheduled releases); --hotfix opens a
# branch → main PR with a patch bump; --tag tags main by hand.

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
  # Matched via a pure-bash substring test, not `git log | grep -q`: with
  # `set -o pipefail`, grep can exit right after matching the first (newest)
  # line while git is still mid-write on the next one, and the SIGPIPE that
  # kills git then outranks grep's success in the pipeline's exit status —
  # turning a real match into a false negative under exactly the process
  # scheduling jitter a loaded CI runner introduces.
  HEAD_VERSION=$(jq -r '.version // empty' apps/web/package.json 2>/dev/null || true)
  BUMP_LOG=$'\n'"$(git log origin/main..HEAD --format='%s' 2>/dev/null || true)"$'\n'
  if [ "$HEAD_VERSION" = "$SEMVER" ] \
     && [[ "$BUMP_LOG" == *$'\n'"chore: bump version to ${NEW_VERSION}"$'\n'* ]]; then
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

# --finalize / --finalize-force used to reset dev to main and force-push it.
# That destroyed whatever landed on dev after the release cut (the same failure
# sync-dev.yml was rewritten to stop). dev is now reconciled by sync-dev.yml
# merging main into it, never by a reset, so both are refusals.
if [ "${1:-}" = "--finalize" ] || [ "${1:-}" = "--finalize-force" ]; then
  echo "❌ ${1} is gone: it force-reset dev to main and could delete work that landed after the cut."
  echo "   sync-dev.yml merges main into dev after every merge to main. To do it by hand:"
  echo "   git checkout dev && git merge origin/main && git push origin dev"
  exit 1
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

# Normal release: dispatch the Release workflow on dev, so a release from a
# workstation and a scheduled one run the exact same code (release.yml decides
# legacy vs frozen-candidate flow from the RELEASE_CANDIDATE_CUT repo variable,
# and captures dev's SHA at dispatch time). Flags:
#   --dry-run   frozen-candidate flow, prints the candidate, changes nothing
#   --force     cut even with no feat/fix commits since the last tag
# To run the candidate engine itself locally (e.g. a dry run against your own
# fetch): bun run release:candidate -- cut --dry-run --source origin/dev
DRY_RUN=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --force) FORCE=true ;;
    *) echo "❌ Unknown option: $arg (expected --dry-run, --force, --hotfix, --tag or --cleanup)"; exit 1 ;;
  esac
done

gh workflow run release.yml --ref dev -f force="$FORCE" -f dry_run="$DRY_RUN"
echo "Dispatched the Release workflow on dev (force=${FORCE}, dry_run=${DRY_RUN})."
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "buildd-ai/buildd")
echo "Follow it: https://github.com/${REPO}/actions/workflows/release.yml"

# When the release PR merges:
#   - release-tag.yml tags main from apps/web/package.json and creates the GitHub release
#   - sync-dev.yml merges main back into dev (never a reset)
# Manual escape hatch if tagging was bypassed: bun run release -- --tag
