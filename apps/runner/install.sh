#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# --service: register the background service non-interactively (for scripted/CI
# installs, e.g. `curl -fsSL buildd.dev/install.sh | bash -s -- --service`).
# Without it, an interactive terminal is asked at the end; a non-interactive one
# (no TTY — piped install with no flag) skips the service and says how to add it later.
#
# --client: buildd for your own Claude Code / Codex / Cursor sessions only
# (`curl -fsSL https://buildd.dev/install.sh | bash -s -- --client`). Checks out
# just what `buildd login` and `buildd install` load, runs no `bun install`,
# downloads no Chromium and offers no service. Running the installer again
# without --client upgrades it in place to the full runner.
WANT_SERVICE=0
CLIENT_MODE=0
REPAIR_MODE=0
for arg in "$@"; do
  [ "$arg" = "--service" ] && WANT_SERVICE=1
  [ "$arg" = "--client" ] && CLIENT_MODE=1
  [ "$arg" = "--repair" ] && REPAIR_MODE=1
done

# Install zstd: apps/runner/src/warm-repo.ts shells out to the real CLI to
# compress/restore the cloud runner's cache tarball, and its unit tests do the
# same to exercise that path for real (no mock) — a sandbox without the binary
# fails those tests even though nothing else here needs it. Best-effort and
# idempotent: a missing package manager or a failed install just leaves those
# tests failing, same as today, rather than aborting the rest of the install.
zstd_userspace_provision() {
  command -v dpkg-deb >/dev/null 2>&1 || return 1
  local work apt_opts
  work="$(mktemp -d)" || return 1
  mkdir -p "$work/lists/partial" "$work/cache/archives/partial" "$work/dl"
  apt_opts=(-o "Dir::State::Lists=$work/lists" -o "Dir::Cache=$work/cache" -o Debug::NoLocking=1)
  if (apt-get "${apt_opts[@]}" update -qq && cd "$work/dl" && apt-get "${apt_opts[@]}" download -qq zstd) >/dev/null 2>&1 \
     && dpkg-deb -x "$work"/dl/zstd_*.deb "$work/root" 2>/dev/null \
     && [ -x "$work/root/usr/bin/zstd" ]; then
    mkdir -p "$HOME/.local/bin"
    install -m 0755 "$work/root/usr/bin/zstd" "$HOME/.local/bin/zstd"
    rm -rf "$work"
    "$HOME/.local/bin/zstd" --version >/dev/null 2>&1
    return $?
  fi
  rm -rf "$work"
  return 1
}

zstd_provision() {
  if command -v zstd >/dev/null 2>&1; then
    return 0
  fi
  case "$(uname -s)" in
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        if [ "$(id -u)" -eq 0 ]; then
          apt-get update -qq && apt-get install -y -qq zstd
          return $?
        elif [ "${BUILDD_NO_SUDO:-}" != "1" ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
          echo -e "${YELLOW}Using sudo (passwordless) to apt-install zstd. Set BUILDD_NO_SUDO=1 to skip.${NC}"
          sudo -n true 2>/dev/null && sudo apt-get update -qq && sudo apt-get install -y -qq zstd
          return $?
        fi
        # Not root and no passwordless escalation (the usual worker sandbox):
        # fetch the .deb with a user-owned apt state dir, unpack into ~/.local.
        zstd_userspace_provision && return 0
      fi
      ;;
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install -q zstd
        return $?
      fi
      ;;
  esac
  return 1
}

zstd_warn() {
  echo -e "${YELLOW}Warning: zstd not installed — warm-repo compression tests will fail without it.${NC}"
  echo -e "${YELLOW}  Install manually: apt-get install zstd (Linux) or brew install zstd (macOS)${NC}"
}

# --repair: reconcile an EXISTING machine/sandbox without reinstalling the
# runner. Today that means provisioning zstd via the same idempotent path a fresh
# install uses (including the no-root user-space .deb unpack into ~/.local/bin),
# for sandboxes created before install.sh provisioned it:
#   bash apps/runner/install.sh --repair
# Exits 0 when zstd is present afterwards, 1 otherwise. Make sure ~/.local/bin is
# on PATH for the shell that runs the tests.
if [ "$REPAIR_MODE" = "1" ]; then
  export PATH="$HOME/.local/bin:$PATH"
  if zstd_provision; then
    echo -e "${GREEN}zstd available: $(command -v zstd)${NC}"
    exit 0
  fi
  zstd_warn
  exit 1
fi

if [ "$CLIENT_MODE" = "1" ]; then
  echo -e "${GREEN}Installing buildd (client only: login and Claude Code / Codex / Cursor setup, no runner)...${NC}"
else
  echo -e "${GREEN}Installing buildd runner...${NC}"
fi

# Check for bun
if ! command -v bun &> /dev/null; then
  echo -e "${YELLOW}Bun not found. Installing...${NC}"
  curl -fsSL https://bun.sh/install | bash
  # bun's installer honours BUN_INSTALL; look where it actually put the binary.
  export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
fi

# Install directory
INSTALL_DIR="$HOME/.buildd"
BIN_DIR="$HOME/.local/bin"

# What to install. Defaults to main of the public repo; BUILDD_REF takes a branch
# or a commit SHA (CI's installer smoke test installs the exact commit under
# test). A non-main install still self-updates to BUILDD_BRANCH (default main)
# once the runner is up — set that too to stay on a branch.
BUILDD_REF="${BUILDD_REF:-main}"
BUILDD_REPO="${BUILDD_REPO:-buildd-ai/buildd}"

# Everything the runner loads at runtime: the runner, every workspace package it
# resolves (directly or through @buildd/core), and the root bunfig + preload that
# stub `server-only` for the plain Bun runtime. A workspace dep missing here makes
# `bun install` fail with "@buildd/<pkg>@workspace:* failed to resolve", and
# `set -e` then exits before the launcher is written.
write_sparse_checkout() {
  cat > .git/info/sparse-checkout << 'SPARSE'
apps/runner/
packages/shared/
packages/core/
packages/ai-kit/
packages/dispatch-contract/
scripts/stub-server-only.ts
bunfig.toml
package.json
SPARSE
}

# --- client mode: begin ---
# What `install.sh --client` checks out: exactly the files `buildd login` and
# `buildd install` load (they import only runtime built-ins, so no `bun install`),
# the agent plugin they install, and the launcher's server-only preload.
# apps/runner/__tests__/unit/install-client-mode.test.ts derives this list from
# the real import graph and fails when it drifts.
write_client_sparse_checkout() {
  cat > .git/info/sparse-checkout << 'CLIENT_SPARSE'
apps/runner/src/login.ts
apps/runner/src/agent-plugin-install.ts
apps/runner/src/buildd-home.ts
apps/runner/src/claude-json-mcp.ts
apps/runner/src/secure-file.ts
apps/runner/plugin/
scripts/stub-server-only.ts
CLIENT_SPARSE
}

# A full runner install already has everything --client provides. Turning it
# into a client one would delete the runner, so --client leaves it alone.
client_mode_guard() {
  local dir="$1"
  if [ -d "$dir/.git" ] && [ ! -f "$dir/.client-only" ] && [ -f "$dir/apps/runner/src/index.ts" ]; then
    echo -e "${YELLOW}$dir already has the full buildd runner, which includes everything --client installs.${NC}"
    echo "Nothing changed. Use it as is: buildd login, then buildd install --global."
    echo "To update it, run the installer without --client."
    return 1
  fi
  return 0
}

# print_client_next_steps <login source, or "">
print_client_next_steps() {
  local login_source="$1"
  echo ""
  echo "Next:"
  echo '  exec $SHELL              reload your shell so buildd is on your PATH'
  if [ -z "$login_source" ]; then
    echo "  buildd login             connect this machine to your buildd account"
    echo "                           (no browser on this machine? buildd login --device)"
  fi
  echo "  buildd install --global  turn buildd on in Claude Code for your workspace folders"
  echo ""
  echo "This is the client-only install: there is no runner, so nothing runs buildd tasks on this machine."
  echo "Update it by running the installer again with --client. To add the runner: curl -fsSL https://buildd.dev/install.sh | bash"
}

# Log in when there is a terminal to do it on, then say the one thing left.
finish_client_install() {
  echo ""
  echo -e "${GREEN}Installed buildd (client only).${NC}"
  local login_source
  login_source="$(buildd_login_source)"
  if [ -z "$login_source" ] && [ -t 1 ] && [ -r /dev/tty ]; then
    echo ""
    "$BIN_DIR/buildd" login < /dev/tty && login_source="$(buildd_login_source)"
  fi
  print_client_next_steps "$login_source"
}
# --- client mode: end ---

if [ "$CLIENT_MODE" = "1" ] && ! client_mode_guard "$INSTALL_DIR"; then
  exit 0
fi

# The plain Bun runtime has no `react-server` condition, so `server-only` throws
# at module load for anything that transitively imports the DB layer. Bun reads
# bunfig.toml from the cwd only, so the launcher passes the preload explicitly
# rather than depending on where `buildd` is run from.

# Clone or update using sparse checkout (only apps/runner)
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing installation..."
  cd "$INSTALL_DIR"

  # Update sparse checkout config (in case it changed, or the mode did)
  if [ "$CLIENT_MODE" = "1" ]; then write_client_sparse_checkout; else write_sparse_checkout; fi

  # Fetch and apply updates (nuke and re-clone if fetch fails — handles corrupted sparse checkouts)
  if git fetch origin "$BUILDD_REF"; then
    git checkout -- bun.lock 2>/dev/null || true  # Discard local lockfile changes
    git read-tree -mu HEAD  # Re-apply sparse checkout to get new paths
    git reset --hard FETCH_HEAD
  else
    echo -e "${YELLOW}Fetch failed — re-cloning from scratch...${NC}"
    cd "$HOME"
    rm -rf "$INSTALL_DIR"
    # Fall through to fresh clone below
  fi
fi

if [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "Cloning buildd (runner only)..."

  # Clean install dir if it exists but isn't a git repo
  [ -d "$INSTALL_DIR" ] && rm -rf "$INSTALL_DIR"

  # Initialize sparse checkout
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  git init
  git remote add origin "https://github.com/${BUILDD_REPO}.git"
  git config core.sparseCheckout true

  if [ "$CLIENT_MODE" = "1" ]; then write_client_sparse_checkout; else write_sparse_checkout; fi

  # Fetch and checkout: a branch gets a local branch tracking it, a SHA is detached.
  git fetch --depth 1 origin "$BUILDD_REF"
  if git rev-parse -q --verify "refs/remotes/origin/$BUILDD_REF" >/dev/null; then
    git checkout -B "$BUILDD_REF" "origin/$BUILDD_REF"
  else
    git checkout --detach FETCH_HEAD
  fi
fi

# Client mode is marked so the launcher knows there is no runner; a full
# install over it removes the mark.
if [ "$CLIENT_MODE" = "1" ]; then
  touch "$INSTALL_DIR/.client-only"
else
  rm -f "$INSTALL_DIR/.client-only"
fi

# Rewrite root package.json to only reference the sparse-checkout workspaces
# (the repo's package.json has "apps/*" and "packages/*" which includes workspaces
# that don't exist in the sparse checkout, causing bun install to hang)
[ "$CLIENT_MODE" = "1" ] || cat > "$INSTALL_DIR/package.json" << 'PKGJSON'
{
  "name": "buildd",
  "private": true,
  "workspaces": [
    "apps/runner",
    "packages/shared",
    "packages/core",
    "packages/ai-kit",
    "packages/dispatch-contract"
  ]
}
PKGJSON

# Register runtime-only files in the local git exclude list so they never appear
# as untracked files in `git status` (and never block the self-update preflight).
# .git/info/exclude is like .gitignore but per-clone and never tracked — it
# survives `git fetch` / `git reset --hard` untouched.
EXCLUDE_FILE="$INSTALL_DIR/.git/info/exclude"
mkdir -p "$(dirname "$EXCLUDE_FILE")"
for pattern in \
  'config.json' 'config.json.bak-*' \
  'history.db' 'history.db-shm' 'history.db-wal' \
  'repos-cache.json' \
  'roles/' 'workers/' 'archive/' \
  'start-runner.sh' '.client-only'
do
  grep -qxF "$pattern" "$EXCLUDE_FILE" 2>/dev/null || echo "$pattern" >> "$EXCLUDE_FILE"
done

# Client mode stops short of the runner: no dependencies, no Chromium.
if [ "$CLIENT_MODE" != "1" ]; then

# Install dependencies
cd "$INSTALL_DIR/apps/runner"
bun install

# Bake headless Chromium into the runner at install time.
# This lets agents do visual self-verification without per-task downloads.
# The runner advertises a 'browser' capability once the binary is confirmed present.
# Always through the repo's pinned Playwright (`bun run browser:install`), never a
# bare `bunx playwright`: that resolves whatever version is cached globally, and
# `playwright install` from another version deletes the pinned version's Chromium.
#
# `--with-deps` installs system libraries with apt, which means sudo for anyone but
# root. It is only attempted when that cannot prompt: as root, or with
# passwordless sudo (announced first). Everyone else gets the browser without
# system libs plus the one apt line to run themselves. BUILDD_NO_SUDO=1 opts out.
# --- chromium deps hint: begin ---
# The system libraries a Chromium installed without --with-deps may still need.
# Linux only: macOS needs none, and has no apt.
chromium_deps_hint() {
  if [ "$1" = "Linux" ]; then
    echo -e "${YELLOW}  Ubuntu/Debian: sudo apt-get install -y libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2${NC}"
  fi
}
# --- chromium deps hint: end ---
echo -e "${GREEN}Installing headless Chromium (pinned Playwright)...${NC}"
CHROMIUM_WITH_DEPS=0
if [ "$(uname -s)" = "Linux" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    CHROMIUM_WITH_DEPS=1
  elif [ "${BUILDD_NO_SUDO:-}" != "1" ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    echo -e "${YELLOW}Using sudo (passwordless) to apt-install Chromium's system libraries. Set BUILDD_NO_SUDO=1 to skip.${NC}"
    CHROMIUM_WITH_DEPS=1
  fi
fi
if [ "$CHROMIUM_WITH_DEPS" = "1" ] && bun run browser:install --with-deps 2>&1; then
  echo -e "${GREEN}Headless Chromium installed successfully${NC}"
else
  [ "$CHROMIUM_WITH_DEPS" = "1" ] && echo -e "${YELLOW}--with-deps failed. Trying without...${NC}"
  if bun run browser:install 2>&1; then
    if [ "$(uname -s)" = "Linux" ]; then
      echo -e "${GREEN}Headless Chromium installed (install system deps manually if launch fails)${NC}"
    else
      echo -e "${GREEN}Headless Chromium installed${NC}"
    fi
    chromium_deps_hint "$(uname -s)"
  else
    echo -e "${YELLOW}Warning: Headless Chromium could not be installed.${NC}"
    echo -e "${YELLOW}  Browser capability will not be advertised. To fix:${NC}"
    echo -e "${YELLOW}  cd $INSTALL_DIR/apps/runner && bun run browser:install --with-deps${NC}"
  fi
fi

fi # end runner-only: dependencies + Chromium

# Create bin directory
mkdir -p "$BIN_DIR"

# Create launcher script
cat > "$BIN_DIR/buildd" << 'LAUNCHER'
#!/bin/bash

# =============================================================================
# buildd launcher
# =============================================================================
# Config is stored in ~/.buildd/config.json (managed by the web UI)
# Env vars override config for CI/Docker use:
#   BUILDD_API_KEY  - API key (overrides config.json)
#   PROJECTS_ROOT   - Project directories to scan
#   BUILDD_SERVER   - Server URL (default: https://buildd.dev)
#   PORT            - Local server port (default: 8766)
#
# Every bun call passes --no-env-file: `buildd` runs from whatever folder you
# are in, and Bun would otherwise auto-load that folder's .env — a project's
# API key and server URL would point this runner at someone else's server.
# =============================================================================

# Ensure bun is on PATH (non-interactive shells like Docker CMD, nohup, systemd
# don't source .bashrc, so bun may not be found after auto-update restart)
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# Stubs `server-only` for the plain Bun runtime. Passed explicitly because Bun
# reads bunfig.toml from the cwd only, and `buildd` runs from anywhere.
BUILDD_PRELOAD="$HOME/.buildd/scripts/stub-server-only.ts"

# Client-only install (`install.sh --client`): login and install work, the
# runner is not there.
CLIENT_ONLY=0
[ -f "$HOME/.buildd/.client-only" ] && CLIENT_ONLY=1
client_only_runner() {
  echo "The buildd runner isn't installed: this is the client-only install (buildd login and buildd install for Claude Code, Codex and Cursor)." >&2
  echo "To add the runner, so this machine can run buildd tasks: curl -fsSL https://buildd.dev/install.sh | bash" >&2
  exit 3
}

# Auto-detect project roots if not set
if [ -z "$PROJECTS_ROOT" ]; then
  ROOTS=""
  for dir in "$HOME/projects" "$HOME/dev" "$HOME/code" "$HOME/src" "$HOME/repos" "$HOME/work" "/home/coder/project"; do
    [ -d "$dir" ] && ROOTS="$ROOTS,$dir"
  done
  ROOTS="${ROOTS#,}"  # Remove leading comma

  # Fall back to home directory if no standard dirs found
  if [ -z "$ROOTS" ]; then
    ROOTS="$HOME"
  fi

  export PROJECTS_ROOT="$ROOTS"
fi

# Subcommands
case "${1:-}" in
  help|-h|--help)
    if [ "$CLIENT_ONLY" = "1" ]; then
      cat << 'CLIENTUSAGE'
Usage: buildd <command>   (client-only install: no runner)

  buildd login [--device]    Sign in and save your key to ~/.buildd/config.json
  buildd logout              Remove the saved key
  buildd status              Show whether you are signed in
  buildd install --global    Turn buildd on in Claude Code for your workspace folders,
                             plus session presence hooks for Claude Code / Codex / Cursor
  buildd install --here      Turn it on for this folder too
  buildd install [--global] --status|--uninstall   Inspect or remove those hooks
  buildd init <workspace-id> Write .mcp.json for this repo

To add the runner (run buildd tasks on this machine): curl -fsSL https://buildd.dev/install.sh | bash
CLIENTUSAGE
      exit 0
    fi
    # Answered by the runner's own usage text (cli-args.ts) without starting it.
    exec bun --no-env-file run --preload "$BUILDD_PRELOAD" "$HOME/.buildd/apps/runner/src/index.ts" --help
    ;;

  init)
    # Per-workspace MCP registration: writes .mcp.json in current repo
    if [ ! -d ".git" ]; then
      echo "Error: not in a git repository. Run 'buildd init' from a repo root." >&2
      exit 1
    fi

    # Read workspace ID from arg or prompt
    WORKSPACE_ID="${2:-}"
    if [ -z "$WORKSPACE_ID" ]; then
      echo "Usage: buildd init <workspace-id>"
      echo ""
      echo "Find your workspace ID in the buildd dashboard."
      exit 1
    fi

    # Read API key from config
    CONFIG_FILE="$HOME/.buildd/config.json"
    BUILDD_KEY=""
    BUILDD_SERVER="https://buildd.dev"
    if [ -f "$CONFIG_FILE" ]; then
      BUILDD_KEY=$(bun --no-env-file -e "const c=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8'));console.log(c.apiKey||'')" 2>/dev/null)
      BUILDD_SERVER=$(bun --no-env-file -e "const c=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8'));console.log(c.builddServer||'https://buildd.dev')" 2>/dev/null)
    fi
    if [ -z "$BUILDD_KEY" ]; then
      echo "Error: not logged in. Run 'buildd login' first." >&2
      exit 1
    fi

    # Write .mcp.json
    cat > .mcp.json << MCPEOF
{
  "mcpServers": {
    "buildd": {
      "type": "http",
      "url": "${BUILDD_SERVER}/api/mcp?workspace=${WORKSPACE_ID}",
      "headers": {
        "Authorization": "Bearer ${BUILDD_KEY}"
      }
    }
  }
}
MCPEOF

    # Add .mcp.json to .gitignore if not already there
    if [ -f .gitignore ]; then
      if ! grep -qx '.mcp.json' .gitignore 2>/dev/null; then
        echo '.mcp.json' >> .gitignore
        echo "Added .mcp.json to .gitignore"
      fi
    else
      echo '.mcp.json' > .gitignore
      echo "Created .gitignore with .mcp.json"
    fi

    # Ensure Claude Code allows project MCP servers
    CLAUDE_SETTINGS="$HOME/.claude/settings.json"
    if [ -f "$CLAUDE_SETTINGS" ]; then
      if ! grep -q '"enableAllProjectMcpServers"' "$CLAUDE_SETTINGS" 2>/dev/null; then
        # Use bun to merge the setting
        bun --no-env-file -e "
          const fs = require('fs');
          const settings = JSON.parse(fs.readFileSync('$CLAUDE_SETTINGS', 'utf-8'));
          settings.enableAllProjectMcpServers = true;
          fs.writeFileSync('$CLAUDE_SETTINGS', JSON.stringify(settings, null, 2) + '\n');
        " 2>/dev/null && echo "Enabled project MCP servers in Claude Code settings"
      fi
    else
      mkdir -p "$HOME/.claude"
      echo '{ "enableAllProjectMcpServers": true }' > "$CLAUDE_SETTINGS"
      echo "Created Claude Code settings with project MCP servers enabled"
    fi

    echo "Created .mcp.json for workspace $WORKSPACE_ID"
    echo "Claude Code will now auto-detect the buildd MCP server in this repo."
    exit 0
    ;;

  install)
    # Lifecycle hooks + session skill for Claude Code / Codex / Cursor (the
    # buildd agent plugin, apps/runner/plugin). See agent-plugin-install.ts.
    AGENT_PLUGIN_INSTALL="$HOME/.buildd/apps/runner/src/agent-plugin-install.ts"
    case " $* " in
      *" --uninstall "*|*" --status "*)
        shift
        exec bun --no-env-file run --preload "$BUILDD_PRELOAD" "$AGENT_PLUGIN_INSTALL" "$@"
        ;;
    esac
    # Everything else (--global, --here, --everywhere, project scope) is the
    # installer's: it registers the MCP server for your workspace folders and
    # installs the presence hooks, and prints exactly what it did.
    shift
    exec bun --no-env-file run --preload "$BUILDD_PRELOAD" "$AGENT_PLUGIN_INSTALL" "$@"
    ;;

  login)
    shift
    exec bun --no-env-file run --preload "$BUILDD_PRELOAD" "$HOME/.buildd/apps/runner/src/login.ts" "$@"
    ;;

  logout)
    CONFIG_FILE="$HOME/.buildd/config.json"
    if [ -f "$CONFIG_FILE" ]; then
      # Revoke the session presence token server-side (best effort), then drop
      # both credentials from the file.
      bun --no-env-file -e "
        const fs = require('fs');
        const config = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf-8'));
        const token = config.presenceToken;
        const server = (config.builddServer || 'https://buildd.dev').replace(/\/+$/, '');
        const done = () => {
          delete config.apiKey;
          delete config.presenceToken;
          fs.writeFileSync('$CONFIG_FILE', JSON.stringify(config, null, 2), { mode: 0o600 });
        };
        if (typeof token === 'string' && token.startsWith('bldp_')) {
          fetch(server + '/api/auth/presence-token', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) })
            .catch(() => {}).finally(done);
        } else done();
      "
      echo "Logged out. API key and session presence token removed from $CONFIG_FILE"
    else
      echo "Not logged in (no config file found)"
    fi
    exit 0
    ;;

  status)
    CONFIG_FILE="$HOME/.buildd/config.json"
    if [ -f "$CONFIG_FILE" ]; then
      bun --no-env-file -e "
        const fs = require('fs');
        const config = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf-8'));
        if (config.apiKey) {
          const key = config.apiKey;
          console.log('Status: logged in');
          console.log('API key: ' + key.slice(0, 10) + '...' + key.slice(-4));
          console.log('Server:  ' + (config.builddServer || 'https://buildd.dev'));
        } else {
          console.log('Status: not logged in');
          console.log('Run \"buildd login\" to authenticate.');
        }
      "
    else
      echo "Status: not logged in"
      echo "Run \"buildd login\" to authenticate."
    fi
    exit 0
    ;;

  service)
    [ "$CLIENT_ONLY" = "1" ] && client_only_runner
    shift
    exec bun --no-env-file run --preload "$BUILDD_PRELOAD" "$HOME/.buildd/apps/runner/src/service.ts" "$@"
    ;;
esac

[ "$CLIENT_ONLY" = "1" ] && client_only_runner

# Run with restart loop (exit code 75 = update applied, restart)
while true; do
  bun --no-env-file run --preload "$BUILDD_PRELOAD" "$HOME/.buildd/apps/runner/src/index.ts" "$@"
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -ne 75 ]; then exit $EXIT_CODE; fi
  echo "Restarting after update..."
  sleep 1
done
LAUNCHER

chmod +x "$BIN_DIR/buildd"

# Add to PATH if needed
SHELL_RC=""
case "$SHELL" in
  */zsh) SHELL_RC="$HOME/.zshrc" ;;
  */bash) SHELL_RC="$HOME/.bashrc" ;;
esac

if [ -n "$SHELL_RC" ] && ! grep -q '.local/bin' "$SHELL_RC" 2>/dev/null; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_RC"
  echo -e "${YELLOW}Added ~/.local/bin to PATH in $SHELL_RC${NC}"
fi

# --- next steps: begin ---
# What to do after the installer. Kept in two functions between these markers so
# apps/runner/__tests__/unit/install-next-steps.test.ts can run them as-is.
#
# The runner is headless unless started with --debug (or PORT set): nothing
# listens on localhost:8766, and with no API key it idles. So the next step is
# always `buildd login`, unless a login already exists.

# Where the saved login came from, or nothing when there is none.
buildd_login_source() {
  if [ -n "${BUILDD_API_KEY:-}" ]; then
    echo "BUILDD_API_KEY"
  elif [ -f "$HOME/.buildd/config.json" ] && grep -Eq '"apiKey"[[:space:]]*:[[:space:]]*"[^"]+"' "$HOME/.buildd/config.json"; then
    echo "~/.buildd/config.json"
  fi
}

# print_next_steps <login source, or ""> <1 if the background service is installed>
print_next_steps() {
  local login_source="$1" service="$2"
  echo ""
  if [ -n "$login_source" ]; then
    echo -e "${GREEN}Already logged in (${login_source}), so skip 'buildd login'.${NC}"
    echo ""
  elif [ "$service" = "1" ]; then
    echo -e "${YELLOW}The background service is installed, but it has no account yet, so it will not pick up work.${NC}"
    echo ""
  fi
  echo "Next:"
  echo '  exec $SHELL              reload your shell so buildd is on your PATH'
  if [ -z "$login_source" ]; then
    echo "  buildd login             connect this machine to your buildd account"
    echo "                           (no browser on this machine? buildd login --device)"
  fi
  if [ "$service" = "1" ] && [ -n "$login_source" ]; then
    echo "  buildd service status    the runner is already running in the background"
  elif [ "$service" = "1" ]; then
    echo "  buildd service install   restart the background service with your account"
  else
    echo "  buildd                   start the runner in this terminal"
    echo "                           (or buildd service install to keep it running in the background)"
  fi
  echo ""
  echo "Config is stored in ~/.buildd/config.json"
}
# --- next steps: end ---

# Client mode ends here: the rest (zstd, mergiraf, the service) is the runner's.
if [ "$CLIENT_MODE" = "1" ]; then
  finish_client_install
  exit 0
fi

if ! zstd_provision; then
  zstd_warn
fi

# Install mergiraf: structural merge driver for language-aware conflict resolution.
# Pinned release with SHA256 verification. Best-effort: missing binary just means
# the merge-drivers.test.ts mergiraf tests will skip, same as today.
mergiraf_provision() {
  if command -v mergiraf >/dev/null 2>&1; then
    return 0
  fi
  MERGIRAF_VERSION="0.20.0"
  case "$(uname -s)" in
    Linux)
      case "$(uname -m)" in
        x86_64)
          MERGIRAF_TARGET="x86_64-unknown-linux-gnu"
          MERGIRAF_SHA256="4341127da8d1da29eced669fbacc1e5d6e530115098de0b82cc9dc551a1acf37"
          ;;
        aarch64|arm64)
          MERGIRAF_TARGET="aarch64-unknown-linux-gnu"
          MERGIRAF_SHA256="1bb78ef3612f3eb92bdfb803131259a3d6761b93d00d4bdba905edebf913e96b"
          ;;
        *)
          return 1
          ;;
      esac
      TMPDIR_MERGIRAF="$(mktemp -d)"
      if curl -fsSL "https://codeberg.org/mergiraf/mergiraf/releases/download/v${MERGIRAF_VERSION}/mergiraf_${MERGIRAF_TARGET}.tar.gz" -o "${TMPDIR_MERGIRAF}/mergiraf.tar.gz" 2>/dev/null; then
        if echo "${MERGIRAF_SHA256}  ${TMPDIR_MERGIRAF}/mergiraf.tar.gz" | sha256sum -c 2>/dev/null >/dev/null; then
          if tar -xzf "${TMPDIR_MERGIRAF}/mergiraf.tar.gz" -C "${TMPDIR_MERGIRAF}" 2>/dev/null; then
            if [ -f "${TMPDIR_MERGIRAF}/mergiraf" ]; then
              mkdir -p "$HOME/.local/bin"
              install -m 0755 "${TMPDIR_MERGIRAF}/mergiraf" "$HOME/.local/bin/mergiraf"
              rm -rf "$TMPDIR_MERGIRAF"
              return 0
            fi
          fi
        fi
      fi
      rm -rf "$TMPDIR_MERGIRAF"
      ;;
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install -q mergiraf
        return $?
      fi
      ;;
  esac
  return 1
}

if ! mergiraf_provision; then
  echo -e "${YELLOW}Warning: mergiraf not installed — merge-drivers.test.ts mergiraf tests will skip without it.${NC}"
  echo -e "${YELLOW}  Install manually: https://mergiraf.org/installation.html${NC}"
fi

echo ""
echo -e "${GREEN}Installation complete!${NC}"

LOGIN_SOURCE="$(buildd_login_source)"

# Offer to register the launcher loop as a background service (launchd on
# macOS, systemd --user on Linux) so it survives closing the terminal and
# reboots — see apps/runner/README.md "Running as a service". --service
# registers non-interactively (for scripted installs); otherwise, ask when
# there's a real terminal to ask on and a login to run it with: a service
# started with no account idles until it is reinstalled after `buildd login`.
# `curl | bash` makes fd 0 the script itself, so the prompt reads from
# /dev/tty directly rather than stdin.
INSTALL_SERVICE=0
if [ "$WANT_SERVICE" = "1" ]; then
  INSTALL_SERVICE=1
elif [ -n "$LOGIN_SOURCE" ] && [ -t 1 ] && [ -r /dev/tty ]; then
  echo ""
  printf "%s" "Run buildd in the background so it survives closing this terminal and reboots? [Y/n] "
  read -r SERVICE_ANSWER < /dev/tty || SERVICE_ANSWER=""
  case "$SERVICE_ANSWER" in
    [nN]*) INSTALL_SERVICE=0 ;;
    *) INSTALL_SERVICE=1 ;;
  esac
fi

SERVICE_INSTALLED=0
if [ "$INSTALL_SERVICE" = "1" ]; then
  if "$BIN_DIR/buildd" service install; then
    SERVICE_INSTALLED=1
  else
    echo -e "${YELLOW}Could not install the background service — run 'buildd service install' to retry, or 'buildd' to run it in the foreground.${NC}"
  fi
fi

print_next_steps "$LOGIN_SOURCE" "$SERVICE_INSTALLED"
