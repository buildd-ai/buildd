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
WANT_SERVICE=0
for arg in "$@"; do
  [ "$arg" = "--service" ] && WANT_SERVICE=1
done

echo -e "${GREEN}Installing buildd runner...${NC}"

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

# The plain Bun runtime has no `react-server` condition, so `server-only` throws
# at module load for anything that transitively imports the DB layer. Bun reads
# bunfig.toml from the cwd only, so the launcher passes the preload explicitly
# rather than depending on where `buildd` is run from.

# Clone or update using sparse checkout (only apps/runner)
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing installation..."
  cd "$INSTALL_DIR"

  # Update sparse checkout config (in case it changed)
  write_sparse_checkout

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

  write_sparse_checkout

  # Fetch and checkout: a branch gets a local branch tracking it, a SHA is detached.
  git fetch --depth 1 origin "$BUILDD_REF"
  if git rev-parse -q --verify "refs/remotes/origin/$BUILDD_REF" >/dev/null; then
    git checkout -B "$BUILDD_REF" "origin/$BUILDD_REF"
  else
    git checkout --detach FETCH_HEAD
  fi
fi

# Rewrite root package.json to only reference the sparse-checkout workspaces
# (the repo's package.json has "apps/*" and "packages/*" which includes workspaces
# that don't exist in the sparse checkout, causing bun install to hang)
cat > "$INSTALL_DIR/package.json" << 'PKGJSON'
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
  'start-runner.sh'
do
  grep -qxF "$pattern" "$EXCLUDE_FILE" 2>/dev/null || echo "$pattern" >> "$EXCLUDE_FILE"
done

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
    echo -e "${GREEN}Headless Chromium installed (install system deps manually if launch fails)${NC}"
    echo -e "${YELLOW}  Ubuntu/Debian: sudo apt-get install -y libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2${NC}"
  else
    echo -e "${YELLOW}Warning: Headless Chromium could not be installed.${NC}"
    echo -e "${YELLOW}  Browser capability will not be advertised. To fix:${NC}"
    echo -e "${YELLOW}  cd $INSTALL_DIR/apps/runner && bun run browser:install --with-deps${NC}"
  fi
fi

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
# =============================================================================

# Ensure bun is on PATH (non-interactive shells like Docker CMD, nohup, systemd
# don't source .bashrc, so bun may not be found after auto-update restart)
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# Stubs `server-only` for the plain Bun runtime. Passed explicitly because Bun
# reads bunfig.toml from the cwd only, and `buildd` runs from anywhere.
BUILDD_PRELOAD="$HOME/.buildd/scripts/stub-server-only.ts"

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
      BUILDD_KEY=$(bun -e "const c=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8'));console.log(c.apiKey||'')" 2>/dev/null)
      BUILDD_SERVER=$(bun -e "const c=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8'));console.log(c.builddServer||'https://buildd.dev')" 2>/dev/null)
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
        bun -e "
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
    if [ "${2:-}" = "--global" ]; then
      # Global MCP registration: writes to ~/.claude.json
      CLAUDE_JSON="$HOME/.claude.json"

      # Read API key from config
      CONFIG_FILE="$HOME/.buildd/config.json"
      BUILDD_KEY=""
      BUILDD_SERVER="https://buildd.dev"
      if [ -f "$CONFIG_FILE" ]; then
        BUILDD_KEY=$(bun -e "const c=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8'));console.log(c.apiKey||'')" 2>/dev/null)
        BUILDD_SERVER=$(bun -e "const c=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8'));console.log(c.builddServer||'https://buildd.dev')" 2>/dev/null)
      fi
      if [ -z "$BUILDD_KEY" ]; then
        echo "Error: not logged in. Run 'buildd login' first." >&2
        exit 1
      fi

      if [ -f "$CLAUDE_JSON" ]; then
        # Merge into existing config
        bun -e "
          const fs = require('fs');
          const config = JSON.parse(fs.readFileSync('$CLAUDE_JSON', 'utf-8'));
          if (!config.mcpServers) config.mcpServers = {};
          config.mcpServers.buildd = {
            type: 'http',
            url: '${BUILDD_SERVER}/api/mcp',
            headers: { Authorization: 'Bearer ${BUILDD_KEY}' }
          };
          fs.writeFileSync('$CLAUDE_JSON', JSON.stringify(config, null, 2) + '\n');
        "
      else
        cat > "$CLAUDE_JSON" << GLOBALEOF
{
  "mcpServers": {
    "buildd": {
      "type": "http",
      "url": "${BUILDD_SERVER}/api/mcp",
      "headers": {
        "Authorization": "Bearer ${BUILDD_KEY}"
      }
    }
  }
}
GLOBALEOF
      fi

      echo "Registered buildd MCP server globally in ~/.claude.json"
      echo "Buildd will be available in every Claude Code session."
      exit 0
    else
      echo "Usage: buildd install --global"
      echo ""
      echo "Registers the buildd MCP server globally for Claude Code."
      exit 1
    fi
    ;;

  skill)
    shift
    exec bun run --preload "$BUILDD_PRELOAD" "$HOME/.buildd/apps/runner/src/skill.ts" "$@"
    ;;

  login)
    shift
    exec bun run --preload "$BUILDD_PRELOAD" "$HOME/.buildd/apps/runner/src/login.ts" "$@"
    ;;

  logout)
    CONFIG_FILE="$HOME/.buildd/config.json"
    if [ -f "$CONFIG_FILE" ]; then
      bun -e "
        const fs = require('fs');
        const config = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf-8'));
        delete config.apiKey;
        fs.writeFileSync('$CONFIG_FILE', JSON.stringify(config, null, 2));
      "
      echo "Logged out. API key removed from $CONFIG_FILE"
    else
      echo "Not logged in (no config file found)"
    fi
    exit 0
    ;;

  status)
    CONFIG_FILE="$HOME/.buildd/config.json"
    if [ -f "$CONFIG_FILE" ]; then
      bun -e "
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
    shift
    exec bun run --preload "$BUILDD_PRELOAD" "$HOME/.buildd/apps/runner/src/service.ts" "$@"
    ;;
esac

# Run with restart loop (exit code 75 = update applied, restart)
while true; do
  bun run --preload "$BUILDD_PRELOAD" "$HOME/.buildd/apps/runner/src/index.ts" "$@"
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

# Install codebase-memory-mcp binary.
#
# This mirrors the layer in docker/worker/Dockerfile, but that Dockerfile is built
# in CI and never pushed — running install.sh is what actually provisions binaries
# on Coder workspaces, so this is the real upgrade path for the fleet. Keep the
# version and the linux checksums identical to the Dockerfile ARGs (enforced by
# apps/runner/__tests__/unit/cbm-version-pin.test.ts, and checked against the
# upstream release by scripts/verify-cbm-pin.sh in CI).
#
# A bump needs no remembered side conditions. The one property worth keeping —
# the graph tools' own descriptions telling the agent to use them instead of
# grep, which an upstream token-reduction pass deleted — is asserted against the
# pinned build by scripts/verify-cbm-grep-steering.ts in worker-image.yml, so a
# version that dropped it fails CI instead of degrading tool routing quietly.
#
# Every step is explicitly guarded rather than relying on `set -e`: this function
# is called from an `if !` test, and POSIX/bash ignore errexit inside a condition,
# including within a subshell that has its own `set -e`. Depending on errexit here
# silently disabled the checksum gate and installed an unverified binary.
CBM_VERSION="0.10.8"
CBM_BINARY_PATH="/opt/buildd/bin/codebase-memory-mcp"

# One checksum per published archive we may download, from the release checksums.txt.
CBM_SHA256_LINUX_AMD64="e5cba4cad6ca8254a85f45041fc8a831908d7d5cb64f98fc3f8eb70a58671793"
CBM_SHA256_LINUX_ARM64="e2804a20f5a6fc392af361525a232703e351b7d1aacb81b88eef806eec5959fa"
CBM_SHA256_DARWIN_AMD64="2b193085410af3801634a522f4b17dcd6699695e015a068393c87817c1d260d4"
CBM_SHA256_DARWIN_ARM64="9bd840dfb3ec7eaef4f310382057adaa5b0e904df883104d03ffcf39836afd07"

cbm_verify_archive() { # <expected-sha> <file>
  # macOS has shasum, not sha256sum.
  if command -v sha256sum >/dev/null 2>&1; then
    echo "$1  $2" | sha256sum -c
  else
    echo "$1  $2" | shasum -a 256 -c
  fi
}

cbm_provision() {
  # Compare the installed version against the pin. A bare presence check would
  # make every future version bump a silent no-op on workspaces that already
  # have CBM.
  local installed=""
  if [ -x "$CBM_BINARY_PATH" ]; then
    installed=$("$CBM_BINARY_PATH" --version 2>/dev/null | head -1 | awk '{print $NF}')
  fi

  if [ "$installed" = "$CBM_VERSION" ]; then
    echo -e "${GREEN}codebase-memory-mcp already at v${CBM_VERSION}${NC}"
    return 0
  fi
  if [ -n "$installed" ]; then
    echo -e "${GREEN}Upgrading codebase-memory-mcp v${installed} -> v${CBM_VERSION}...${NC}"
  else
    echo -e "${GREEN}Installing codebase-memory-mcp v${CBM_VERSION}...${NC}"
  fi

  local os arch
  case "$(uname -s)" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *)      os="" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)             arch="" ;;
  esac
  if [ -z "$os" ] || [ -z "$arch" ]; then
    echo -e "${YELLOW}Unsupported platform $(uname -s)/$(uname -m) — skipping CBM install.${NC}"
    echo -e "${YELLOW}  Install manually: https://github.com/DeusData/codebase-memory-mcp/releases/tag/v${CBM_VERSION}${NC}"
    return 0
  fi

  # /opt/buildd/bin is outside HOME. Use it directly when writable (root, or a
  # prepared image); otherwise sudo only after saying so, and never a password
  # prompt nobody can answer. Skipping is fine: workers run without the graph.
  local cbm_dir
  cbm_dir=$(dirname "$CBM_BINARY_PATH")
  CBM_SUDO=""
  if [ "$(id -u)" -ne 0 ] && ! { mkdir -p "$cbm_dir" 2>/dev/null && [ -w "$cbm_dir" ]; }; then
    if [ "${BUILDD_NO_SUDO:-}" = "1" ] || ! command -v sudo >/dev/null 2>&1; then
      echo -e "${YELLOW}Skipping codebase-memory-mcp: ${cbm_dir} is not writable and sudo is unavailable or disabled (BUILDD_NO_SUDO=1).${NC}"
      return 0
    fi
    if sudo -n true 2>/dev/null; then
      echo -e "${YELLOW}Using sudo (passwordless) to install codebase-memory-mcp into ${cbm_dir}. Set BUILDD_NO_SUDO=1 to skip.${NC}"
    elif [ -t 1 ] && [ -r /dev/tty ]; then
      echo -e "${YELLOW}codebase-memory-mcp (the code graph tool) installs into ${cbm_dir}, which needs sudo and may ask for your password.${NC}"
      local cbm_answer=""
      printf "%s" "Use sudo for it now? The runner works without it. [y/N] "
      read -r cbm_answer < /dev/tty || cbm_answer=""
      case "$cbm_answer" in
        [yY]*) ;;
        *) echo "Skipped codebase-memory-mcp. Re-run the installer to add it later."; return 0 ;;
      esac
    else
      echo -e "${YELLOW}Skipping codebase-memory-mcp: ${cbm_dir} needs sudo, which would prompt for a password with no terminal to answer.${NC}"
      return 0
    fi
    CBM_SUDO="sudo"
  fi

  local sha_var sha tmp
  sha_var="CBM_SHA256_$(echo "${os}_${arch}" | tr '[:lower:]' '[:upper:]')"
  eval "sha=\$$sha_var"
  if [ -z "$sha" ]; then
    echo -e "${YELLOW}No checksum pinned for ${os}/${arch} — refusing to install.${NC}"
    return 1
  fi

  tmp=$(mktemp -d) || return 1

  if ! curl -fsSL \
      "https://github.com/DeusData/codebase-memory-mcp/releases/download/v${CBM_VERSION}/codebase-memory-mcp-${os}-${arch}.tar.gz" \
      -o "$tmp/cbm.tar.gz"; then
    rm -rf "$tmp"; return 1
  fi
  if ! cbm_verify_archive "$sha" "$tmp/cbm.tar.gz"; then
    rm -rf "$tmp"; return 1
  fi
  # Extract only the binary — the archive also ships its own install.sh, which
  # rewrites ~/.claude.json and must never run here.
  if ! tar -xzf "$tmp/cbm.tar.gz" -C "$tmp" codebase-memory-mcp; then
    rm -rf "$tmp"; return 1
  fi

  # Retire a default-env daemon from the old build before the swap. This only
  # reaches a daemon started without CBM_RUNTIME_DIR: worker daemons live under
  # /tmp/cbm-<workerId>/run and are invisible here by design. They are
  # short-lived, and `install -m 0755` unlinks the destination rather than
  # writing through it, so a running worker keeps its own inode.
  if [ -n "$installed" ]; then
    "$CBM_BINARY_PATH" daemon stop >/dev/null 2>&1 || true
  fi

  if ! $CBM_SUDO mkdir -p "$(dirname "$CBM_BINARY_PATH")"; then rm -rf "$tmp"; return 1; fi
  if ! $CBM_SUDO install -m 0755 "$tmp/codebase-memory-mcp" "$CBM_BINARY_PATH"; then
    rm -rf "$tmp"; return 1
  fi
  rm -rf "$tmp"

  local now
  now=$("$CBM_BINARY_PATH" --version 2>/dev/null | head -1 | awk '{print $NF}')
  if [ "$now" != "$CBM_VERSION" ]; then
    echo -e "${YELLOW}Warning: installed CBM reports '${now}', expected '${CBM_VERSION}'.${NC}"
    return 1
  fi
  echo -e "${GREEN}codebase-memory-mcp installed: ${now}${NC}"
  return 0
}

# A failed provision must not fail the installer: a Coder startup script gates on
# install.sh's exit code, and the block is on the hot path now that it upgrades on
# version mismatch instead of skipping whenever any binary is present.
if ! cbm_provision; then
  echo -e "${YELLOW}Warning: codebase-memory-mcp install/upgrade failed — continuing.${NC}"
  echo -e "${YELLOW}  Workers will run without the code graph until this succeeds.${NC}"
fi


echo ""
echo -e "${GREEN}Installation complete!${NC}"
echo ""

# Offer to register the launcher loop as a background service (launchd on
# macOS, systemd --user on Linux) so it survives closing the terminal and
# reboots — see apps/runner/README.md "Running as a service". --service
# registers non-interactively (for scripted installs); otherwise, ask when
# there's a real terminal to ask on. `curl | bash` makes fd 0 the script
# itself, so the prompt reads from /dev/tty directly rather than stdin.
INSTALL_SERVICE=0
if [ "$WANT_SERVICE" = "1" ]; then
  INSTALL_SERVICE=1
elif [ -t 1 ] && [ -r /dev/tty ]; then
  printf "%s" "Run buildd in the background so it survives closing this terminal and reboots? [Y/n] "
  read -r SERVICE_ANSWER < /dev/tty || SERVICE_ANSWER=""
  case "$SERVICE_ANSWER" in
    [nN]*) INSTALL_SERVICE=0 ;;
    *) INSTALL_SERVICE=1 ;;
  esac
fi

if [ "$INSTALL_SERVICE" = "1" ]; then
  "$BIN_DIR/buildd" service install || echo -e "${YELLOW}Could not install the background service — run 'buildd service install' to retry, or 'buildd' to run it in the foreground.${NC}"
else
  echo "Run buildd to start:"
  echo "  buildd"
  echo ""
  echo -e "${YELLOW}Tip: run 'buildd service install' any time to keep it running in the background.${NC}"
fi

echo ""
echo "Then open http://localhost:8766 to connect your account."
echo ""
echo "Config is stored in ~/.buildd/config.json"
echo ""

# Reload PATH for current session
export PATH="$BIN_DIR:$PATH"
echo -e "${YELLOW}Run 'source $SHELL_RC' or open a new terminal to use 'buildd' command${NC}"
