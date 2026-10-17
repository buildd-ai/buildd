#!/usr/bin/env bash
# Fail when a branch's diff adds the runner's auto-generated agent-instructions
# block (written by apps/runner/src/codex-instructions.ts for the agent to read,
# never to ship). Runs on every push to a PR (no-prod-data.yml), which covers
# pushes after create_pr, so it is the real backstop for the create_pr guard.
# Usage: scripts/check-no-agent-instructions.sh <base-ref>   (default origin/dev)
set -euo pipefail
base="${1:-origin/dev}"
marker='BEGIN buildd agent instructions'
if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "error: base '$base' is not a commit here (fetch it first); refusing to report a clean diff" >&2
  exit 2
fi
# Files that legitimately name the marker: the writer, the scanner, their tests, this check.
diff_out="$(git diff "$base"...HEAD -U0 --no-color -- . \
  ':!apps/runner/src/codex-instructions.ts' \
  ':!apps/runner/__tests__/unit/codex-instructions.test.ts' \
  ':!packages/core/agent-instruction-leak.ts' \
  ':!packages/core/__tests__/agent-instruction-leak.test.ts' \
  ':!apps/web/src/lib/agent-instruction-guard.test.ts' \
  ':!scripts/check-no-agent-instructions.sh' \
  ':!scripts/no-agent-instructions.test.ts' \
  )"
# A failing git diff aborts here (set -e); only grep's no-match is tolerated.
hits="$(printf '%s\n' "$diff_out" | grep -E '^\+' | grep -v '^+++' | grep -F "$marker" || true)"
if [ -n "$hits" ]; then
  echo "error: the diff adds the runner's auto-generated agent instructions block:" >&2
  echo "$hits" | head -5 >&2
  echo "Remove those lines (git checkout $base -- <file>) and push again." >&2
  exit 1
fi
echo "no agent-instructions block in the diff"
