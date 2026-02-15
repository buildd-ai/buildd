#!/usr/bin/env bash
# Determine which test files to run based on changed files in the current PR/push.
# Output: space-separated list of test file paths, or "ALL" to run everything.

set -euo pipefail

# Determine changed files
if [ -n "${GITHUB_BASE_REF:-}" ]; then
  # PR: compare against base branch
  CHANGED=$(git diff --name-only "origin/${GITHUB_BASE_REF}...HEAD")
elif [ "${GITHUB_EVENT_NAME:-}" = "push" ]; then
  # Push to dev: compare against previous commit
  CHANGED=$(git diff --name-only HEAD~1)
else
  # Local: compare against dev
  CHANGED=$(git diff --name-only origin/dev...HEAD 2>/dev/null || git diff --name-only HEAD~1)
fi

# If no changes detected, skip tests
if [ -z "$CHANGED" ]; then
  echo "SKIP"
  exit 0
fi

# Count changed files — if too many, run all tests
FILE_COUNT=$(echo "$CHANGED" | wc -l | tr -d ' ')
if [ "$FILE_COUNT" -gt 20 ]; then
  echo "ALL"
  exit 0
fi

# Check if any shared/core files changed — run all tests if so
if echo "$CHANGED" | grep -qE '^(packages/core/|packages/shared/|bunfig\.toml|package\.json|tests/setup\.ts)'; then
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
  echo "$TESTS" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/ *$//'
else
  echo "SKIP"
fi
