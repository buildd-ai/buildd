#!/usr/bin/env bash
# Thin wrapper kept for `bun run test:affected` and anything that still calls
# the old path. The selection lives in scripts/affected-tests.ts (reverse import
# graph); see its header for the rules. Last stdout line: ALL, SKIP, or a
# space-separated list of test files. Reasoning goes to stderr.
set -euo pipefail
exec bun "$(dirname "$0")/affected-tests.ts" "$@"
