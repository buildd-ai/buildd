#!/usr/bin/env bash
# The "Sync code and build on test machine" step of .github/workflows/integration.yml.
# Checks out one commit on the shared test machine and builds it there,
# retrying, and turns every way that can go wrong into an exit 1 with a
# message saying which kind of failure it was. It never exits 0 without a build.
#
# Usage: sync-test-machine.sh <sha> <repo-url>
# Env:   TEST_USER TEST_HOST TEST_CONTAINER (required), GITHUB_OUTPUT
#
# Time limits. Green runs in late Oct / early Nov 2026 took 7 to 16 minutes for
# this whole step, almost all of it one `next build`. A run of release
# candidate v0.392.0 sat here for 40 minutes until someone cancelled it: an
# ssh session that never returned blocks the retry loop forever, because the
# loop only moves on when an attempt returns.
#   SYNC_ATTEMPT_SECS  one attempt, end to end (default 1200 = 20m, above the
#                      slowest green step). The container side is told to
#                      give up 60s sooner and kill what it started, so it is
#                      normally the one that stops; this side's timeout is
#                      for a session that hangs past that.
#   SYNC_BUDGET_SECS   all attempts plus waits (default 2400 = 40m). Quick
#                      failures still get up to 5 attempts; a hung one uses
#                      most of the budget and leaves room for one more.
#   SYNC_RETRY_SECS    wait between attempts (default 60).
#   TAILSCALE          the tailscale binary (tests substitute a fake).
set -u

sha=${1:?usage: sync-test-machine.sh <sha> <repo-url>}
repo=${2:?missing repo url}
attempt_secs=${SYNC_ATTEMPT_SECS:-1200}
budget_secs=${SYNC_BUDGET_SECS:-2400}
retry_secs=${SYNC_RETRY_SECS:-60}
min_attempt_secs=${SYNC_MIN_ATTEMPT_SECS:-300}
ts=${TAILSCALE:-tailscale}
here=$(cd "$(dirname "$0")" && pwd)
out=${GITHUB_OUTPUT:-/dev/null}

# Keepalives: a dead tailnet path fails the session in ~60s instead of never.
ssh_opts=(-o ServerAliveInterval=15 -o ServerAliveCountMax=4)

rc=1
timed_out=0
attempt=0
deadline=$((SECONDS + budget_secs))
while [ $attempt -lt 5 ]; do
  remaining=$((deadline - SECONDS))
  if [ $remaining -lt "$min_attempt_secs" ]; then
    echo "Sync budget of ${budget_secs}s nearly spent (${remaining}s left); not starting another attempt."
    break
  fi
  attempt=$((attempt + 1))
  limit=$attempt_secs
  [ $limit -gt $remaining ] && limit=$remaining
  remote_limit=$((limit - 60))
  [ $remote_limit -lt 1 ] && remote_limit=1

  echo "Attempt $attempt/5: syncing and building on test machine (limit ${limit}s)..."
  timeout -k 15 "$limit" "$ts" ssh "$TEST_USER@$TEST_HOST" "${ssh_opts[@]}" \
    "docker exec -i $TEST_CONTAINER bash -s -- $sha $repo $remote_limit" \
    < "$here/test-machine-build.sh"
  code=$?
  if [ $code -eq 0 ]; then
    rc=0
    break
  fi
  # 124: the container gave up, or timeout(1) here did. 137: timeout's -k.
  if [ $code -eq 124 ] || [ $code -eq 137 ]; then
    timed_out=1
    echo "::warning::Attempt $attempt did not finish within ${limit}s (exit $code)."
  else
    echo "Attempt $attempt failed (exit $code)."
  fi
  if [ $attempt -lt 5 ] && [ $((deadline - SECONDS - retry_secs)) -ge "$min_attempt_secs" ]; then
    echo "Retrying in ${retry_secs}s..."
    sleep "$retry_secs"
  fi
done

if [ $rc -eq 0 ]; then
  echo "machine_online=true" >> "$out"
  exit 0
fi

# The messages below that say "infrastructure failure" are matched by
# .github/workflows/ci-fix.yml, which reruns the job instead of opening a
# code-fix task. scripts/ci/sync-test-machine.test.ts pins that they match.
echo "All sync attempts failed. Probing Tailscale connectivity..."
if timeout 15 "$ts" ping "$TEST_HOST" 2>&1 | grep -qi "pong"; then
  echo "machine_online=true" >> "$out"
  if [ $timed_out -eq 1 ]; then
    # Reachable but too slow: a wedged ssh session, or a machine too loaded to
    # build in time. Reported as a failure, never a pass: no tests ran.
    echo "::error::Test machine ${TEST_HOST} timed out syncing and building (an attempt ran past ${attempt_secs}s, budget ${budget_secs}s), so NO integration or E2E tests ran. This is an infrastructure failure, not a code failure — but it is reported as a failure so it cannot masquerade as passing coverage. If it persists after a re-run, check the machine's load and for a stuck ssh or docker exec session."
    echo "INTEGRATION_MODE=skipped_timeout"
  else
    echo "::error::SSH failed but machine IS reachable via Tailscale — check SSH/docker config on the test machine"
  fi
  exit 1
fi

# FAILS, deliberately. This branch used to `exit 0` with a warning, on the
# reasoning that an infra outage is not a code problem. The consequence:
# between 2026-07-16 and 2026-08-29 this job reported SUCCESS six consecutive
# times having executed zero tests, because Tailscale was logged out on the
# host the whole time. A green that cannot be told apart from "never ran" is
# worse than a red one.
#
# NOTE: ci-fix.yml detects this error message pattern and handles
# infrastructure failures specially: instead of attempting a code fix (which
# cannot succeed), it auto-reruns the failed job up to 3 times with backoff.
# If the job persistently fails with this error after 3 reruns, a human must
# run 'sudo tailscale up --ssh' on the host.
echo "::error::Test machine ${TEST_HOST} is unreachable over Tailscale, so NO integration or E2E tests ran. This is an infrastructure failure, not a code failure — but it is reported as a failure so it cannot masquerade as passing coverage. Fix: run 'sudo tailscale up --ssh' on the host (it logs out and stays out), then re-run this job."
echo "INTEGRATION_MODE=skipped_unreachable"
echo "machine_online=false" >> "$out"
exit 1
