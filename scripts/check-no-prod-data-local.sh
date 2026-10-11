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
#                                    [--staged] [--message-file FILE]
#
# --staged scans the index (merge-base..staged tree) rather than committed HEAD;
# --message-file adds a candidate commit message. CI scans committed HEAD.
#
# base-ref defaults to the nearest of origin/dev and origin/mission/*: the
# candidate with the fewest commits between it and HEAD. A task branch cut from
# a mission integration branch is PR'd against that branch, so diffing it
# against origin/dev would re-scan commits that are already on the mission
# branch (and were already gated there). Diffs and commit messages are compared
# against it, same as CI compares against the PR's base branch.
# --resolve-only prints the chosen base and exits (used by the tests).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BASE_REF=""
RESOLVE_ONLY=0
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --body|--title|--message-file) ARGS+=("$1" "$2"); shift 2 ;;
    --staged) ARGS+=("$1"); shift ;;
    --resolve-only) RESOLVE_ONLY=1; shift ;;
    *) BASE_REF="$1"; shift ;;
  esac
done

if [ -z "$BASE_REF" ]; then
  BASE_REF="origin/dev"
  best=""
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    n=$(git rev-list --count "$ref..HEAD" 2>/dev/null) || continue
    if [ -z "$best" ] || [ "$n" -lt "$best" ]; then
      best="$n"
      BASE_REF="$ref"
    fi
  done < <({ git rev-parse --verify --quiet origin/dev >/dev/null && echo origin/dev; \
             git for-each-ref --format='%(refname:short)' 'refs/remotes/origin/mission/'; } )
fi

if [ "$RESOLVE_ONLY" = 1 ]; then
  echo "$BASE_REF"
  exit 0
fi

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

# ${ARGS[@]+...}: macOS ships bash 3.2, where expanding an EMPTY array under
# `set -u` is an "unbound variable" error — every no-flag run (the pre-commit
# hook's) died here before checking anything.
NO_PROD_DATA_LOCAL=1 python3 scripts/check_no_prod_data.py "$BASE_REF" ${ARGS[@]+"${ARGS[@]}"}
