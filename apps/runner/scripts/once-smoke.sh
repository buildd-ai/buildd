#!/usr/bin/env bash
# Smoke test for the --once container image (apps/runner/Dockerfile.once).
#
#   bash apps/runner/scripts/once-smoke.sh            # build, then check
#   SKIP_BUILD=1 bash apps/runner/scripts/once-smoke.sh
#
# Every run uses --network none, so nothing here can reach a real buildd
# server, GitHub or the model API.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="${IMAGE:-buildd-runner-once:smoke}"
PLATFORM=linux/amd64
fail=0

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  echo "== build $IMAGE ($PLATFORM)"
  docker buildx build --platform "$PLATFORM" -f "$ROOT/apps/runner/Dockerfile.once" -t "$IMAGE" --load "$ROOT"
fi

run() { docker run --rm --platform "$PLATFORM" --network none "$@"; }

expect_exit() {
  local want="$1" label="$2"; shift 2
  local got=0
  echo "== $label"
  run "$@" || got=$?
  if [ "$got" = "$want" ]; then
    echo "   PASS exit=$got"
  else
    echo "   FAIL exit=$got, want $want"; fail=1
  fi
}

# (a) No arguments: parseOnceArgs rejects a missing --task before any config
# is read.
expect_exit 64 "(a) buildd-once with no args -> 64 (usage)" \
  "$IMAGE" buildd-once

# (a2) --task but no API key: runOnceFromCli refuses to start.
expect_exit 64 "(a2) buildd-once --task, no API key -> 64 (usage)" \
  "$IMAGE" buildd-once --task "smoke-$RANDOM"

# (b) Bogus key, unreachable server: the task fetch fails, runOnce logs
# "could not be fetched" and exits 1 (failed, retryable). Not 3: nothing was
# refused by a server, so a supervisor should treat it as a failure.
expect_exit 1 "(b) buildd-once --task <random>, bogus key, unreachable server -> 1 (failed)" \
  -e BUILDD_API_KEY=bld_smoke_not_a_real_key \
  -e BUILDD_SERVER=http://127.0.0.1:9 \
  "$IMAGE" buildd-once --task "smoke-$RANDOM"

# (c) The runner resolves the Claude Code binary it will spawn, and it runs.
echo "== (c) runner resolves the bundled Claude Code binary"
if out="$(run "$IMAGE" sh -c 'cd /opt/buildd && p="$(bun -e "import { resolveClaudeBinaryPath } from \"./apps/runner/src/sdk-binary-path\"; console.log(resolveClaudeBinaryPath() ?? \"\")")" && test -n "$p" && echo "$p" && "$p" --version')"; then
  echo "$out" | sed 's/^/   /'; echo "   PASS"
else
  echo "   FAIL: $out"; fail=1
fi

# (d) Non-root, update checks off.
echo "== (d) user and env"
out="$(run "$IMAGE" sh -c 'echo "uid=$(id -u) BUILDD_DISABLE_AUTO_UPDATE=$BUILDD_DISABLE_AUTO_UPDATE"')"
echo "   $out"
case "$out" in "uid=1000 BUILDD_DISABLE_AUTO_UPDATE=1") echo "   PASS" ;; *) echo "   FAIL"; fail=1 ;; esac

echo "== image size"
bytes="$(docker image inspect "$IMAGE" --format '{{.Size}}')"
echo "   $IMAGE: $((bytes / 1024 / 1024)) MiB (uncompressed)"

if [ "$fail" = 0 ]; then echo "== smoke PASSED"; else echo "== smoke FAILED"; fi
exit "$fail"
