#!/bin/bash
# Run the REAL one-line installer in client mode the way the docs say —
# `curl … | bash -s -- --client` into an empty HOME — then prove it is the small
# install it claims to be, that what it ships works, and that the two ways out of
# it behave: a full install upgrades it in place, and --client over a full
# install leaves the runner alone.
#
#   BUILDD_REF=<branch|sha> bash apps/runner/scripts/installer-smoke-client.sh
#
# Used by .github/workflows/installer-smoke.yml next to installer-smoke.sh.
# Safe to run locally: everything lands under a fresh mktemp HOME.
set -euo pipefail

REF="${BUILDD_REF:-main}"
REPO="${BUILDD_REPO:-buildd-ai/buildd}"
INSTALLER_URL="https://raw.githubusercontent.com/${REPO}/${REF}/apps/runner/install.sh"

export HOME="$(mktemp -d)"
unset BUN_INSTALL BUILDD_HOME BUILDD_CONFIG BUILDD_SERVER BUILDD_API_KEY BUILDD_BRANCH PORT PROJECTS_ROOT
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
echo "smoke(client): HOME=$HOME ref=$REF"

fail() { echo "smoke(client): FAIL — $*"; exit 1; }
playwright_cache() {
  if [ "$(uname -s)" = "Darwin" ]; then echo "$HOME/Library/Caches/ms-playwright"; else echo "$HOME/.cache/ms-playwright"; fi
}

curl -fsSL "$INSTALLER_URL" | BUILDD_REF="$REF" bash -s -- --client

BUILDD="$HOME/.local/bin/buildd"
test -x "$BUILDD" || fail "launcher $BUILDD was not written"
test -f "$HOME/.buildd/.client-only" || fail "client install is not marked"

# It is the small install: no runner, no dependencies, no browser.
[ ! -e "$HOME/.buildd/apps/runner/src/index.ts" ] || fail "the runner was checked out"
[ ! -e "$HOME/.buildd/packages" ] || fail "workspace packages were checked out"
[ ! -d "$HOME/.buildd/node_modules" ] && [ ! -d "$HOME/.buildd/apps/runner/node_modules" ] || fail "bun install ran"
[ ! -d "$(playwright_cache)" ] || fail "Chromium was downloaded"
test -f "$HOME/.buildd/apps/runner/plugin/scripts/buildd-hook.mjs" || fail "the agent plugin is missing"
echo "smoke(client): OK — no runner, no node_modules, no Chromium ($(du -sh "$HOME/.buildd" | cut -f1))"

# From a cwd with a project .env, like any repo checkout: nothing in it may matter.
PROJECT_DIR="$(mktemp -d)"
printf 'BUILDD_API_KEY=bld_fake_cwd_env\nBUILDD_SERVER=http://127.0.0.1:9\n' > "$PROJECT_DIR/.env"
cd "$PROJECT_DIR"

OUT=$("$BUILDD" login --help) || fail "buildd login --help exited non-zero: $OUT"
echo "$OUT" | grep -q '^Usage: buildd login' || fail "buildd login --help printed no usage: $OUT"
[ ! -f "$HOME/.buildd/config.json" ] || fail "buildd login --help logged in"
echo "smoke(client): OK — buildd login --help"

OUT=$("$BUILDD" install --status --global 2>&1) || fail "buildd install --status --global exited non-zero: $OUT"
echo "smoke(client): OK — buildd install --status --global"

OUT=$("$BUILDD" --help) || fail "buildd --help exited non-zero: $OUT"
echo "$OUT" | grep -q 'client-only install' || fail "buildd --help does not say this is the client install: $OUT"

for ARGS in "" "service status"; do
  CODE=0; OUT=$("$BUILDD" $ARGS 2>&1) || CODE=$?
  [ "$CODE" = "3" ] || fail "buildd $ARGS exited $CODE, expected 3: $OUT"
  echo "$OUT" | grep -q "runner isn't installed" || fail "buildd $ARGS did not explain: $OUT"
done
echo "smoke(client): OK — starting the runner explains it is not installed"

# Re-running --client updates in place.
curl -fsSL "$INSTALLER_URL" | BUILDD_REF="$REF" bash -s -- --client >/dev/null
test -f "$HOME/.buildd/.client-only" || fail "re-running --client lost the client mark"

# A full install upgrades it in place.
curl -fsSL "$INSTALLER_URL" | BUILDD_REF="$REF" bash
[ ! -f "$HOME/.buildd/.client-only" ] || fail "the full install left the client mark"
test -f "$HOME/.buildd/apps/runner/src/index.ts" || fail "the full install did not check out the runner"
VERSION_OUT=$("$BUILDD" --version 2>&1) || fail "buildd --version after upgrade: $VERSION_OUT"
echo "$VERSION_OUT" | grep -q '^buildd runner ' || fail "buildd --version after upgrade: $VERSION_OUT"
echo "smoke(client): OK — a full install upgrades the client one in place ($VERSION_OUT)"

# --client over a full install changes nothing.
OUT=$(curl -fsSL "$INSTALLER_URL" | BUILDD_REF="$REF" bash -s -- --client 2>&1) || fail "--client over a full install exited non-zero: $OUT"
echo "$OUT" | grep -q 'already has the full buildd runner' || fail "--client over a full install did not say so: $OUT"
test -f "$HOME/.buildd/apps/runner/src/index.ts" || fail "--client deleted the runner"
[ ! -f "$HOME/.buildd/.client-only" ] || fail "--client marked a full install as client-only"
echo "smoke(client): OK — --client leaves a full install alone"
