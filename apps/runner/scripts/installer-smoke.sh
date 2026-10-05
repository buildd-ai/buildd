#!/bin/bash
# Run the REAL one-line installer the way a stranger does — `curl … | bash` into
# an empty HOME — then prove the installed runner actually starts.
#
#   BUILDD_REF=<branch|sha> bash apps/runner/scripts/installer-smoke.sh
#
# Used by .github/workflows/installer-smoke.yml (clean ubuntu container, non-root
# user with no sudo). Safe to run locally: everything lands under a fresh
# mktemp HOME, never your real ~/.buildd or ~/.local/bin.
#
# Fails if: the installer exits non-zero, the launcher is missing,
# `buildd --version` fails from an unrelated cwd, `buildd --help` or an unknown
# flag starts the runner instead of printing usage, a .env in the current
# folder reaches the runner, or a started runner never answers /health.
set -euo pipefail

REF="${BUILDD_REF:-main}"
REPO="${BUILDD_REPO:-buildd-ai/buildd}"
SMOKE_PORT="${SMOKE_PORT:-18766}"

export HOME="$(mktemp -d)"
# Nothing from the caller's environment may point outside the temp HOME.
unset BUN_INSTALL BUILDD_HOME BUILDD_CONFIG BUILDD_SERVER BUILDD_API_KEY BUILDD_BRANCH PORT PROJECTS_ROOT
# A login shell's PATH must not leak a pre-existing bun/buildd into the check.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
echo "smoke: HOME=$HOME ref=$REF"

# The installer itself comes from the ref under test, piped exactly like the docs say.
curl -fsSL "https://raw.githubusercontent.com/${REPO}/${REF}/apps/runner/install.sh" \
  | BUILDD_REF="$REF" bash

BUILDD="$HOME/.local/bin/buildd"
test -x "$BUILDD" || { echo "smoke: FAIL — launcher $BUILDD was not written"; exit 1; }

# From a cwd with no bunfig.toml: the launcher must not depend on where it is run.
# The folder also holds a project .env, as any repo checkout would. Nothing in
# it may reach the runner: if it did, BUILDD_HOME would point at LEAK_HOME and
# the runner would create it.
PROJECT_DIR="$(mktemp -d)"
LEAK_HOME="$HOME/cwd-env-leaked"
cat > "$PROJECT_DIR/.env" <<ENVEOF
BUILDD_API_KEY=bld_fake_cwd_env
BUILDD_SERVER=http://127.0.0.1:9
BUILDD_HOME=$LEAK_HOME
ENVEOF
cd "$PROJECT_DIR"

# Run the launcher with a deadline: a runner that started never exits on its own.
# Prints the output; returns the exit code, or 124 if it had to be killed.
run_bounded() {
  local out="$HOME/bounded.out" pid code
  "$BUILDD" "$@" >"$out" 2>&1 &
  pid=$!
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
    cat "$out"; return 124
  fi
  wait "$pid" && code=0 || code=$?
  cat "$out"; return "$code"
}

for HELP_ARG in --help -h help; do
  echo "smoke: buildd $HELP_ARG"
  HELP_CODE=0; HELP_OUT=$(run_bounded "$HELP_ARG") || HELP_CODE=$?
  [ "$HELP_CODE" = "0" ] || { echo "smoke: FAIL — buildd $HELP_ARG exited $HELP_CODE (124 = it started the runner):"; echo "$HELP_OUT"; exit 1; }
  echo "$HELP_OUT" | grep -q '^Usage: buildd' || { echo "smoke: FAIL — buildd $HELP_ARG did not print usage:"; echo "$HELP_OUT"; exit 1; }
done

echo "smoke: buildd --not-a-flag"
BAD_CODE=0; BAD_OUT=$(run_bounded --not-a-flag) || BAD_CODE=$?
[ "$BAD_CODE" = "64" ] || { echo "smoke: FAIL — an unknown flag exited $BAD_CODE, expected 64 (124 = it started the runner):"; echo "$BAD_OUT"; exit 1; }
echo "$BAD_OUT" | grep -q 'Unknown argument: --not-a-flag' || { echo "smoke: FAIL — unknown flag was not named:"; echo "$BAD_OUT"; exit 1; }

echo "smoke: buildd --version"
VERSION_OUT=$("$BUILDD" --version 2>&1) || { echo "smoke: FAIL — buildd --version exited non-zero:"; echo "$VERSION_OUT"; exit 1; }
echo "$VERSION_OUT"
echo "$VERSION_OUT" | grep -q '^buildd runner ' || { echo "smoke: FAIL — buildd --version did not print the runner version"; exit 1; }

echo "smoke: starting runner on :$SMOKE_PORT"
LOG="$HOME/runner-smoke.log"
# Port 1 is never listening: registration fails fast instead of reaching a real server.
# No browser tab on a workstation run; a fresh config is otherwise empty.
[ -f "$HOME/.buildd/config.json" ] || echo '{"openBrowser":false}' > "$HOME/.buildd/config.json"
PORT="$SMOKE_PORT" BUILDD_SERVER="http://127.0.0.1:1" "$BUILDD" >"$LOG" 2>&1 &
PID=$!

ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${SMOKE_PORT}/health" >/dev/null 2>&1; then ok=1; break; fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
# Children first: once the launcher loop dies its bun child is reparented and
# `pkill -P` can no longer find it.
pkill -P "$PID" 2>/dev/null || true
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true

if [ "$ok" != "1" ]; then
  echo "smoke: FAIL — runner never answered /health. Log:"
  cat "$LOG"
  exit 1
fi
if [ -e "$LEAK_HOME" ] || grep -q 'injected env' "$LOG"; then
  echo "smoke: FAIL — the runner read the .env in its current folder. Log:"
  cat "$LOG"
  exit 1
fi
echo "smoke: OK — a .env in the current folder was ignored"
echo "smoke: OK — installed runner answers /health"
