#!/usr/bin/env bash
# Fail if production data appears in a change to this PUBLIC repo.
#
# Scoping is deliberate, to keep this useful rather than noisy:
#   - counts and UUIDs are checked in COMMIT MESSAGES and the PR BODY only,
#     where they are almost never legitimate. Code and fixtures use UUIDs and
#     large numbers for honest reasons.
#   - identifiers (personal handles, private repo names) are checked EVERYWHERE,
#     including added code, because they are never legitimate here.
#
# The identifier list is NOT stored in this repo. It would itself be a personal
# handle and a private repo name committed to a public repository -- the exact
# thing this script exists to prevent. It is supplied at run time from the
# repository variable NO_PROD_DATA_IDENTIFIERS (an ERE alternation, e.g.
# 'handle|private-repo-a|private-repo-b'). If unset, that check is skipped and
# this script says so rather than passing quietly.
#
# Usage:
#   scripts/check-no-prod-data.sh <base-ref> [pr-body-file]
#
# Exit: 0 clean, 1 violation found, 2 usage error.

set -uo pipefail

BASE="${1:-}"
BODY_FILE="${2:-}"
[ -z "$BASE" ] && { echo "usage: $0 <base-ref> [pr-body-file]" >&2; exit 2; }

IDENTIFIERS="${NO_PROD_DATA_IDENTIFIERS:-}"

# A grouped thousands figure (comma-separated, N,NNN) or a bare 4-digit+ count
# beside a data noun. Written as a description, not an example: documentation that
# instantiates the pattern trips this check, as this PR's own body first did.
COUNTS='[0-9],[0-9]{3}\b|\b[0-9]{4,}[[:space:]]+(rows?|memories|teams?|keys?|users?|accounts?|workspaces?|workers?|chunks?)\b'

# Canonical UUID.
UUIDS='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

# This script names the forbidden categories, so exclude it from the content scan
# or it flags its own documentation.
SELF='scripts/check-no-prod-data.sh'

fail=0
report() { echo "::error::$1"; printf '%s\n' "$2" | sed 's/^/   /'; fail=1; }

scan() { # <label> <text> <where>
  local label="$1" text="$2" where="$3" pat_name pat hits
  [ -z "$text" ] && return 0
  for pat_name in COUNTS UUIDS IDENTIFIERS; do
    pat="${!pat_name}"
    [ -z "$pat" ] && continue
    hits="$(printf '%s' "$text" | grep -inE "$pat" | head -5)"
    [ -n "$hits" ] && report "$where contains $pat_name — $label" "$hits"
  done
}

scan "production data must never enter public git history; it is permanent" \
     "$(git log --format='%B' "${BASE}..HEAD" 2>/dev/null)" "commit message"

if [ -n "$BODY_FILE" ] && [ -f "$BODY_FILE" ]; then
  scan "state evidence qualitatively instead" "$(cat "$BODY_FILE")" "PR body"
fi

# Added lines: identifiers only. Snapshots are generated, and excluded.
if [ -n "$IDENTIFIERS" ]; then
  added="$(git diff "${BASE}...HEAD" -- . \
            ":(exclude)packages/core/drizzle/meta" \
            ":(exclude)${SELF}" 2>/dev/null | grep '^+' | grep -v '^+++')"
  if [ -n "$added" ]; then
    hits="$(printf '%s' "$added" | grep -inE "$IDENTIFIERS" | head -5)"
    [ -n "$hits" ] && report "added lines reference a personal handle or a private repo" "$hits"
  fi
fi

if [ -z "$IDENTIFIERS" ]; then
  echo "::warning::NO_PROD_DATA_IDENTIFIERS is not set — handle and private-repo checks were skipped."
fi

if [ "$fail" -eq 0 ]; then
  echo "no-prod-data: clean"
else
  echo
  echo "This repository is public. See 'This Repo Is Public' in CLAUDE.md."
  echo "Exact figures belong in the private knowledge-base repo."
fi
exit "$fail"
