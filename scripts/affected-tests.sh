#!/usr/bin/env bash
# Determine which test files to run based on changed files in the current PR/push.
# Output (last line): space-separated list of test file paths, or "ALL" or "SKIP".
# Logs reasoning to stderr so CI can see it without polluting the output.

set -euo pipefail

log() { echo "::notice::$*" >&2; }

# Determine changed files
if [ -n "${GITHUB_BASE_REF:-}" ]; then
  log "PR detected — comparing against origin/${GITHUB_BASE_REF}"
  CHANGED=$(git diff --name-only "origin/${GITHUB_BASE_REF}...HEAD")
elif [ "${GITHUB_EVENT_NAME:-}" = "push" ]; then
  log "Push to ${GITHUB_REF_NAME:-dev} — comparing against HEAD~1"
  CHANGED=$(git diff --name-only HEAD~1)
else
  log "Local run — comparing against origin/dev"
  CHANGED=$(git diff --name-only origin/dev...HEAD 2>/dev/null || git diff --name-only HEAD~1)
fi

# If no changes detected, skip tests
if [ -z "$CHANGED" ]; then
  log "No changed files — skipping tests"
  echo "SKIP"
  exit 0
fi

FILE_COUNT=$(echo "$CHANGED" | wc -l | tr -d ' ')
log "Changed files: $FILE_COUNT"

# Count changed files — if too many, run all tests
if [ "$FILE_COUNT" -gt 20 ]; then
  log "More than 20 files changed — running all tests"
  echo "ALL"
  exit 0
fi

# Check if any shared/core files changed — run all tests if so
if echo "$CHANGED" | grep -qE '^(packages/core/|packages/shared/|bunfig\.toml|package\.json|tests/setup\.ts)'; then
  SHARED=$(echo "$CHANGED" | grep -E '^(packages/core/|packages/shared/|bunfig\.toml|package\.json|tests/setup\.ts)' | head -3)
  log "Shared files changed — running all tests: $SHARED"
  echo "ALL"
  exit 0
fi

# Map changed .ts files to colocated .test.ts files
TESTS=""
while IFS= read -r file; do
  # Skip non-ts files
  case "$file" in
    *.ts|*.tsx) ;;
    *) continue ;;
  esac

  # Skip test files themselves (they'll be included if they changed)
  if [[ "$file" == *.test.ts || "$file" == *.test.tsx ]]; then
    if [ -f "$file" ]; then
      TESTS="$TESTS $file"
    fi
    continue
  fi

  # Look for colocated test file
  test_file="${file%.ts}.test.ts"
  test_file_tsx="${file%.tsx}.test.tsx"
  if [ -f "$test_file" ]; then
    TESTS="$TESTS $test_file"
  elif [ -f "$test_file_tsx" ]; then
    TESTS="$TESTS $test_file_tsx"
  fi

  # For route.ts files, also check route.test.ts in same directory
  dir=$(dirname "$file")
  if [ -f "$dir/route.test.ts" ]; then
    TESTS="$TESTS $dir/route.test.ts"
  fi
done <<< "$CHANGED"

# Deduplicate
if [ -n "$TESTS" ]; then
  RESULT=$(echo "$TESTS" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/ *$//')
  COUNT=$(echo "$RESULT" | wc -w | tr -d ' ')
  log "Running $COUNT affected test(s): $RESULT"
  echo "$RESULT"
else
  log "No affected test files found — skipping tests"
  echo "SKIP"
fi
