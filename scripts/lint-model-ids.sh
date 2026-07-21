#!/usr/bin/env bash
# Fail if model-ID literals (claude-X-Y, gpt-4, etc.) appear outside the allowlist.
# Run in CI after checkout to prevent new hardcoded model IDs from creeping in.
#
# Allowlisted files: registry / pricing / defaults (their whole purpose is model IDs),
# the QA judge (pinned intentionally), the runner UI list, and all UI dropdowns.
# Everything else must route through the tier system (premium / standard / budget).

set -euo pipefail

ALLOWLIST=(
  "packages/core/model-aliases.ts"
  "packages/core/model-prices.ts"
  "packages/core/model-tier-registry.ts"
  "packages/core/model-tier-defaults.ts"
  "packages/core/mcp-tools.ts"           # help-text / param documentation strings only
  "apps/web/src/app/api/qa/judge/route.ts"
  "apps/runner/src/index.ts"
  "apps/web/src/lib/config-helpers.ts"
  "apps/web/src/app"
)

PATTERN='claude-(haiku|sonnet|opus|fable|sonnet-5|fable-5|opus-4)-[0-9]|claude-[0-9]|gpt-4[0-9o-]|gpt-3\.5'

violations=$(grep -rn -E "$PATTERN" --include="*.ts" --include="*.tsx" \
  . | grep -v "node_modules\|\.next\|dist\|\.git\|__tests__\|\.test\." || true)

for path in "${ALLOWLIST[@]}"; do
  violations=$(echo "$violations" | grep -v "^$path" | grep -v "^\.\/$path" || true)
done

if [ -n "$violations" ]; then
  echo "ERROR: hardcoded model IDs found outside allowlist:"
  echo "$violations"
  echo ""
  echo "Use tier ('premium'/'standard'/'budget') in create_task, or add a justified"
  echo "allowlist entry to scripts/lint-model-ids.sh with a comment explaining why."
  exit 1
fi
echo "lint-model-ids: OK"
