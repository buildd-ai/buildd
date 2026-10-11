#!/bin/sh
# Installed as /usr/local/bin/buildd-once in the --once container image
# (apps/runner/Dockerfile.once). Runs exactly one buildd task and exits with
# the code from apps/runner/src/run-once.ts:
#   0 completed, 1 failed (retryable), 3 claim refused (do not retry), 64 usage.
#
#   buildd-once --task <task-id>
set -eu

# Between two tasks in one reused cloud container (apps/runner/src/
# container-reset.ts). Before anything below writes to /tmp or HOME.
if [ "${1:-}" = --reset-container ]; then
  cd "${BUILDD_REPO_ROOT:-/opt/buildd}"
  exec bun run apps/runner/src/container-reset-cli.ts
fi

# Cloudflare egress interception re-signs HTTPS for the credentialed hosts
# (api.anthropic.com, github.com, ...) with a per-container CA that appears at
# this path once the container starts. Trust it alongside the system roots:
# NODE_EXTRA_CA_CERTS adds it for Bun and Claude Code; the rest point at a
# combined bundle (system roots + this CA) for git/curl (OpenSSL) and gh (Go),
# so hosts that are not intercepted keep verifying against the normal roots.
# The agent env allowlist (agent-env.ts) passes these to the agent's tools.
CF_CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ "${BUILDD_EXECUTOR:-}" = cloud ] && [ ! -s "$CF_CA" ]; then
  # Written by the platform just after start; don't race it. Without it the
  # intercepted hosts fail TLS verification, which is loud, not a leak.
  i=0; while [ ! -s "$CF_CA" ] && [ "$i" -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
  [ -s "$CF_CA" ] || echo "[buildd-once] warning: $CF_CA not found; HTTPS to intercepted hosts will fail verification" >&2
fi
if [ -s "$CF_CA" ]; then
  bundle="${TMPDIR:-/tmp}/buildd-ca-bundle.pem"
  cat /etc/ssl/certs/ca-certificates.crt "$CF_CA" > "$bundle"
  export NODE_EXTRA_CA_CERTS="$CF_CA" SSL_CERT_FILE="$bundle" GIT_SSL_CAINFO="$bundle" \
    CURL_CA_BUNDLE="$bundle" REQUESTS_CA_BUNDLE="$bundle"
fi

# A lease container's deferred warm snapshot upload (apps/runner/src/
# warm-upload-cli.ts), just before the cloud agent releases the container.
# After the CA setup: the upload goes to an intercepted HTTPS pseudo-host.
if [ "${1:-}" = --upload-warm ]; then
  cd "${BUILDD_REPO_ROOT:-/opt/buildd}"
  exec bun run apps/runner/src/warm-upload-cli.ts
fi

# Local runs pass GH_TOKEN; make git use it for https clones and pushes. On
# Cloudflare no token is in env (the egress proxy adds it) and this is a no-op.
if [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] && ! git config --global --get credential.https://github.com.helper >/dev/null 2>&1; then
  gh auth setup-git >/dev/null 2>&1 || true
fi

# Run from the repo root: its bunfig.toml preloads the `server-only` stub that
# @buildd/core imports need outside Next.js.
cd "${BUILDD_REPO_ROOT:-/opt/buildd}"
exec bun run apps/runner/src/index.ts --once "$@"
