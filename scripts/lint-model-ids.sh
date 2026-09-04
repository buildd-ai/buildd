#!/usr/bin/env bash
# Fail if model-ID literals (claude-opus-5, gpt-5-codex, …) appear outside the
# allowlist. Run in CI after checkout to stop new hardcoded model IDs creeping
# in: everything else must route through the tier system (premium / standard /
# budget), so a model change is a registry row and not a deploy.
#
# History (C30): the allowlist carried the bare prefix `apps/web/src/app`, which
# excluded the ENTIRE Next.js app tree — every route, page and component — and
# left only apps/runner, packages/* and apps/web/src/lib policed. The pattern
# also missed `gpt-5*`, `gpt-4.1` and bare `gpt-4`. The gate passed because it
# was measuring almost nothing. Every entry below is now file-specific and
# carries the reason it is allowed; the run prints what it measured so a future
# coverage collapse is visible instead of silent.
#
# Usage:
#   bash scripts/lint-model-ids.sh              # lint the repo
#   bash scripts/lint-model-ids.sh --self-test  # prove the check can fail

set -euo pipefail

# File-specific allowlist. Directories are NOT allowed here — a directory entry
# is how this gate lost its coverage. Each entry states why.
ALLOWLIST=(
  "packages/core/model-aliases.ts"                 # the alias table: model IDs are its content
  "packages/core/model-prices.ts"                  # price book keyed by model ID
  "packages/core/model-tier-registry.ts"           # tier → model resolution
  "packages/core/model-tier-defaults.ts"           # code-level fallback tiers
  "packages/core/model-tier-liveness.ts"           # audits tier IDs; the IDs in its docstrings ARE the spec of the parser
  "packages/core/model-display.ts"                 # humanises model IDs; the IDs in its docstrings ARE the spec of the parser
  "packages/core/model-catalog.ts"                 # normalises vendor model IDs; every hit is prose in a docstring, the code itself contains no ID literal
  "packages/core/mcp-tools.ts"                     # help/param documentation strings only
  "apps/web/src/app/api/qa/judge/route.ts"         # judge model pinned deliberately (PR #1029)
  "apps/runner/src/index.ts"                       # runner UI model dropdown
  "apps/runner/src/backends/codex-backend.ts"      # brokers OpenAI/codex model IDs for the SDK
  "apps/web/src/lib/config-helpers.ts"             # mission-config UI dropdown options
  "apps/web/src/app/api/models/route.ts"           # filters legacy generations out of the live catalog
)

# claude-<family>-<n>, claude-<n>, any gpt-<n> (covers gpt-4, gpt-4o, gpt-4.1,
# gpt-5, gpt-5-codex, gpt-3.5), and the o-series reasoning models.
PATTERN='claude-(haiku|sonnet|opus|fable|mythos)-[0-9]|claude-[0-9]|gpt-[0-9]|o[0-9]-(mini|preview)'

# Excluded from the scan, deliberately and visibly (counts are printed):
#   - build output and vendored code
#   - tests: fixtures and assertions legitimately name concrete model IDs
EXCLUDE_BUILD='node_modules|\.next|/dist/|\.git/'
EXCLUDE_TESTS='__tests__|\.test\.|\.spec\.'

scan() {
  # $1 = root to scan. Prints "path:line:match" for every hit.
  grep -rn -E "$PATTERN" --include="*.ts" --include="*.tsx" "$1" 2>/dev/null || true
}

ROOT="${ROOT:-.}"

if [ "${1:-}" = "--self-test" ]; then
  # A gate that cannot fail is indistinguishable from a gate that passes. Plant
  # a violation in a path no allowlist entry covers and require a non-zero exit.
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/src"
  printf 'export const M = "claude-opus-5";\n' > "$tmp/src/canary.ts"
  printf 'export const G = "gpt-5-codex";\n'  > "$tmp/src/canary2.tsx"
  printf 'export const OK = "premium";\n'     > "$tmp/src/clean.ts"

  found=$(scan "$tmp" | grep -c -E 'canary' || true)
  clean=$(scan "$tmp" | grep -c -E 'clean\.ts' || true)
  echo "lint-model-ids self-test: canary matches=$found (expected 2), clean-file matches=$clean (expected 0)"
  if [ "$found" -ne 2 ] || [ "$clean" -ne 0 ]; then
    echo "ERROR: self-test failed — the pattern no longer detects hardcoded model IDs."
    exit 1
  fi
  echo "lint-model-ids self-test: OK (the check can fail)"
  exit 0
fi

all_hits=$(scan "$ROOT" | grep -v -E "$EXCLUDE_BUILD" || true)
test_hits=$(echo "$all_hits" | grep -c -E "$EXCLUDE_TESTS" || true)
violations=$(echo "$all_hits" | grep -v -E "$EXCLUDE_TESTS" || true)
total=$(echo "$violations" | grep -c . || true)

allowed=0
for path in "${ALLOWLIST[@]}"; do
  case "$path" in
    */) echo "ERROR: allowlist entry '$path' is a directory; only file paths are allowed."; exit 1 ;;
    *.ts|*.tsx) ;;
    *) echo "ERROR: allowlist entry '$path' is not a .ts/.tsx file; directory prefixes silence whole trees."; exit 1 ;;
  esac
  hits=$(echo "$violations" | grep -c -E "^(\./)?$path:" || true)
  allowed=$((allowed + hits))
  violations=$(echo "$violations" | grep -v -E "^(\./)?$path:" || true)
done

remaining=$(echo "$violations" | grep -c . || true)
scanned=$(grep -rl -E '.' --include="*.ts" --include="*.tsx" "$ROOT" 2>/dev/null | grep -v -E "$EXCLUDE_BUILD" | grep -c . || true)

# Print what was measured, not just the verdict.
echo "lint-model-ids: scanned $scanned source file(s); $total non-test match(es); \
$allowed allowlisted; $test_hits test-file match(es) excluded; $remaining violation(s)"

if [ "$remaining" -gt 0 ]; then
  echo "ERROR: hardcoded model IDs found outside the allowlist:"
  echo "$violations"
  echo ""
  echo "Use tier ('premium'/'standard'/'budget') in create_task, or add a"
  echo "FILE-SPECIFIC allowlist entry to scripts/lint-model-ids.sh with a comment"
  echo "explaining why that file legitimately names a model ID."
  exit 1
fi
echo "lint-model-ids: OK"
