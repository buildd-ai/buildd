#!/bin/sh
# Installed as /usr/local/bin/buildd-once in the --once container image
# (apps/runner/Dockerfile.once). Runs exactly one buildd task and exits with
# the code from apps/runner/src/run-once.ts:
#   0 completed, 1 failed (retryable), 3 claim refused (do not retry), 64 usage.
#
#   buildd-once --task <task-id>
set -eu

# Local runs pass GH_TOKEN; make git use it for https clones and pushes. On
# Cloudflare no token is in env (the egress proxy adds it) and this is a no-op.
if [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] && ! git config --global --get credential.https://github.com.helper >/dev/null 2>&1; then
  gh auth setup-git >/dev/null 2>&1 || true
fi

# Run from the repo root: its bunfig.toml preloads the `server-only` stub that
# @buildd/core imports need outside Next.js.
cd "${BUILDD_REPO_ROOT:-/opt/buildd}"
exec bun run apps/runner/src/index.ts --once "$@"
