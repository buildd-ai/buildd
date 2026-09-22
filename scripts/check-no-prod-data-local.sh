#!/usr/bin/env bash
# Local reproduction of .github/workflows/no-prod-data.yml, so a violation is
# caught before push instead of surfacing as a CI failure nobody can reproduce.
#
# Measured over this repo's own history: the gate's most common trip is a
# PR-body or commit-message finding, not code -- both are known before you
# ever open the PR. This lets that half be checked locally, honestly.
#
# What this CANNOT check: the personal-handle/private-repo identifier rule.
# That pattern lives in the repo secret NO_PROD_DATA_IDENTIFIERS precisely so
# it never appears in a workstation env or a world-readable log (see the
# comment atop no-prod-data.yml). Export NO_PROD_DATA_IDENTIFIERS yourself if
# you have it and want that half checked too; otherwise this degrades to a
# warning rather than a false green -- see check_no_prod_data.py's
# NO_PROD_DATA_LOCAL handling.
#
# Usage:
#   scripts/check-no-prod-data-local.sh [base-ref] [--body FILE] [--title FILE]
#
# base-ref defaults to origin/dev. Diffs and commit messages are compared
# against it, same as CI compares against the PR's base branch.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BASE_REF="origin/dev"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --body|--title) ARGS+=("$1" "$2"); shift 2 ;;
    *) BASE_REF="$1"; shift ;;
  esac
done

if git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  git fetch --quiet origin "${BASE_REF#origin/}" 2>/dev/null || true
else
  echo "no-prod-data (local): '$BASE_REF' not found locally and could not be fetched -- skipping." >&2
  exit 0
fi

if [ -z "${NO_PROD_DATA_IDENTIFIERS:-}" ]; then
  echo "no-prod-data (local): NO_PROD_DATA_IDENTIFIERS is not set -- the handle/" >&2
  echo "  private-repo scan will be skipped. CI still enforces it with the real secret." >&2
fi

NO_PROD_DATA_LOCAL=1 python3 scripts/check_no_prod_data.py "$BASE_REF" "${ARGS[@]}"
