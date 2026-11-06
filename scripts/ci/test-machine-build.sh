#!/usr/bin/env bash
# Runs INSIDE the integration test container. Checks out one commit and builds
# apps/web there. Piped over ssh by scripts/ci/sync-test-machine.sh:
#
#   tailscale ssh <host> "docker exec -i <container> bash -s -- <sha> <repo-url> <limit-secs>" < this file
#
# Why this bounds itself, rather than trusting the ssh client's timeout:
# killing `tailscale ssh` on the CI runner ends the session, and the host-side
# `docker exec` client with it, but NOT the process inside the container.
# Docker does not signal an exec'd process when its client goes away. So a hung
# `git fetch`, `bun install` or `next build` would keep running, and the next
# attempt (or the next job: the machine is shared) would `rm -rf` the checkout
# under it. Two defences:
#
#   1. Every process this script starts carries a marker in its environment.
#      On start, any marked process left over from an earlier attempt is
#      killed. Matching is by marker, never by process name: this container
#      also runs a live buildd runner made of bun, node and git processes.
#   2. The build runs in the background while this shell polls it. Past
#      <limit-secs> it kills the marked processes and exits 124, the
#      timeout(1) convention, so the caller can tell "too slow" from "failed".
#
# Test seams (the caller never sets these; docker exec does not pass env):
#   SYNC_MARKER_VAR   name of the marker variable (default BUILDD_CI_SYNC)
#   SYNC_POLL_SECS    poll interval (default 5)
#   SYNC_WORKDIR      checkout path (default /tmp/buildd-ci)
#   SYNC_BODY         replaces the checkout+build commands

# Everything is inside main, so bash has parsed the whole script before it
# runs any of it: stdin is the ssh session and can close while we run.
main() {
  local sha=${1:?usage: test-machine-build.sh <sha> <repo-url> <limit-secs>}
  local repo=${2:?missing repo url}
  local limit=${3:-1140}
  local marker=${SYNC_MARKER_VAR:-BUILDD_CI_SYNC}
  local poll=${SYNC_POLL_SECS:-5}
  local dir=${SYNC_WORKDIR:-/tmp/buildd-ci}
  export PATH=/home/coder/.local/bin:/home/coder/.bun/bin:$PATH

  local leftover
  leftover=$(kill_marked "$marker" "")
  [ -n "$leftover" ] && echo "Killed leftover build processes from an earlier attempt: $leftover"

  local body=${SYNC_BODY:-'
    set -e
    dir=$1; repo=$2; sha=$3
    (chmod -R u+rwx "$dir" 2>/dev/null || true) && rm -rf "$dir"
    git init -q "$dir"
    git -C "$dir" remote add origin "$repo"
    git -C "$dir" fetch --depth 1 origin "$sha"
    git -C "$dir" checkout -q FETCH_HEAD
    test "$(git -C "$dir" rev-parse HEAD)" = "$sha" || { echo "SHA mismatch: test machine HEAD is not $sha"; exit 1; }
    cd "$dir" && bun install 2>&1 | tail -3
    cd apps/web && DATABASE_URL=postgresql://x:x@localhost/x AUTH_SECRET=build-secret bun run build:only 2>&1 | tail -50
    test -d .next || { echo "Build failed: .next directory missing"; exit 1; }
  '}

  local token="$sha-$$-$(date +%s)"
  env "$marker=$token" bash -c "$body" _ "$dir" "$repo" "$sha" &
  local pid=$!
  # After the fork, so the build keeps the default SIGPIPE. This shell must
  # outlive a closed session to enforce the limit; a write to a dead pipe
  # would otherwise kill it first.
  trap '' PIPE

  local start=$SECONDS
  while kill -0 "$pid" 2>/dev/null; do
    if [ $((SECONDS - start)) -ge "$limit" ]; then
      echo "Build on the test machine exceeded ${limit}s; killing it."
      kill_marked "$marker" "$token" >/dev/null
      wait "$pid" 2>/dev/null
      exit 124
    fi
    sleep "$poll"
  done
  wait "$pid"
  exit $?
}

# Kills every process whose environment has <var>=<value>, or <var>=anything
# when value is empty. Prints the pids it signalled. Only reads /proc, so it
# works the same under coreutils and busybox.
kill_marked() {
  local var=$1 want=$2 p env pids=()
  for p in /proc/[0-9]*; do
    p=${p#/proc/}
    [ "$p" = "$$" ] && continue
    env=$(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null) || continue
    if [ -n "$want" ]; then
      case $'\n'"$env"$'\n' in *$'\n'"$var=$want"$'\n'*) pids+=("$p") ;; esac
    else
      case $'\n'"$env" in *$'\n'"$var="*) pids+=("$p") ;; esac
    fi
  done
  [ ${#pids[@]} -eq 0 ] && return 0
  kill -TERM "${pids[@]}" 2>/dev/null
  sleep 3
  kill -KILL "${pids[@]}" 2>/dev/null
  echo "${pids[*]}"
  return 0
}

main "$@"
