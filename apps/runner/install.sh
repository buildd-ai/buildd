#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}Installing buildd runner...${NC}"

# Check for bun
if ! command -v bun &> /dev/null; then
  echo -e "${YELLOW}Bun not found. Installing...${NC}"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Install directory
INSTALL_DIR="$HOME/.buildd"
BIN_DIR="$HOME/.local/bin"

# Clone or update using sparse checkout (only apps/runner)
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing installation..."
  cd "$INSTALL_DIR"

  # Update sparse checkout config (in case it changed)
  cat > .git/info/sparse-checkout << 'SPARSE'
apps/runner/
packages/shared/
package.json
SPARSE

  # Fetch and apply updates (nuke and re-clone if fetch fails — handles corrupted sparse checkouts)
  if git fetch origin main; then
    git checkout -- bun.lock 2>/dev/null || true  # Discard local lockfile changes
    git read-tree -mu HEAD  # Re-apply sparse checkout to get new paths
    git reset --hard origin/main
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
  git remote add origin https://github.com/buildd-ai/buildd.git
  git config core.sparseCheckout true

  # Checkout runner app, shared package, and root package.json (for workspaces)
  cat > .git/info/sparse-checkout << 'SPARSE'
apps/runner/
packages/shared/
package.json
SPARSE

  # Fetch and checkout
  git fetch --depth 1 origin main
  git checkout main
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
    "packages/shared"
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
echo -e "${GREEN}Installing headless Chromium (Playwright)...${NC}"
if bunx playwright install --with-deps chromium 2>&1; then
  echo -e "${GREEN}Headless Chromium installed successfully${NC}"
else
  echo -e "${YELLOW}--with-deps failed (may need root for system libs). Trying without...${NC}"
  if bunx playwright install chromium 2>&1; then
    echo -e "${GREEN}Headless Chromium installed (install system deps manually if launch fails)${NC}"
    echo -e "${YELLOW}  Ubuntu/Debian: sudo apt-get install -y libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2${NC}"
  else
    echo -e "${YELLOW}Warning: Headless Chromium could not be installed.${NC}"
    echo -e "${YELLOW}  Browser capability will not be advertised. To fix:${NC}"
    echo -e "${YELLOW}  bunx playwright install --with-deps chromium${NC}"
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
    exec bun run "$HOME/.buildd/apps/runner/src/skill.ts" "$@"
    ;;

  login)
    shift
    exec bun run "$HOME/.buildd/apps/runner/src/login.ts" "$@"
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
esac

# Run with restart loop (exit code 75 = update applied, restart)
while true; do
  bun run "$HOME/.buildd/apps/runner/src/index.ts" "$@"
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
# This mirrors the layer in docker/worker/Dockerfile, but that Dockerfile is only
# used when the worker image is explicitly rebuilt (and never pushed). Running
# install.sh is what actually provisions binaries on Coder workspaces, so this
# block is the real upgrade path for the fleet — keep the version and the linux
# checksums identical to the Dockerfile ARGs (enforced by
# apps/runner/__tests__/unit/cbm-version-pin.test.ts).
CBM_VERSION="0.10.8"
CBM_BINARY_PATH="/opt/buildd/bin/codebase-memory-mcp"

# One checksum per published archive we may download, from the release checksums.txt.
CBM_SHA256_LINUX_AMD64="e5cba4cad6ca8254a85f45041fc8a831908d7d5cb64f98fc3f8eb70a58671793"
CBM_SHA256_LINUX_ARM64="e2804a20f5a6fc392af361525a232703e351b7d1aacb81b88eef806eec5959fa"
CBM_SHA256_DARWIN_AMD64="2b193085410af3801634a522f4b17dcd6699695e015a068393c87817c1d260d4"
CBM_SHA256_DARWIN_ARM64="9bd840dfb3ec7eaef4f310382057adaa5b0e904df883104d03ffcf39836afd07"

# Compare the installed version against the pin. A bare presence check would make
# every future version bump a silent no-op on workspaces that already have CBM.
CBM_INSTALLED_VERSION=""
if [ -x "$CBM_BINARY_PATH" ]; then
  CBM_INSTALLED_VERSION=$("$CBM_BINARY_PATH" --version 2>/dev/null | head -1 | awk '{print $NF}')
fi

if [ "$CBM_INSTALLED_VERSION" = "$CBM_VERSION" ]; then
  echo -e "${GREEN}codebase-memory-mcp already at v${CBM_VERSION}${NC}"
else
  if [ -n "$CBM_INSTALLED_VERSION" ]; then
    echo -e "${GREEN}Upgrading codebase-memory-mcp v${CBM_INSTALLED_VERSION} -> v${CBM_VERSION}...${NC}"
  else
    echo -e "${GREEN}Installing codebase-memory-mcp v${CBM_VERSION}...${NC}"
  fi

  case "$(uname -s)" in
    Linux)  CBM_OS="linux" ;;
    Darwin) CBM_OS="darwin" ;;
    *)      CBM_OS="" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  CBM_ARCH="amd64" ;;
    aarch64|arm64) CBM_ARCH="arm64" ;;
    *)             CBM_ARCH="" ;;
  esac

  if [ -z "$CBM_OS" ] || [ -z "$CBM_ARCH" ]; then
    echo -e "${YELLOW}Warning: unsupported platform $(uname -s)/$(uname -m) — skipping CBM install.${NC}"
    echo -e "${YELLOW}  Install manually: https://github.com/DeusData/codebase-memory-mcp/releases/tag/v${CBM_VERSION}${NC}"
  else
    eval "CBM_SHA256=\$CBM_SHA256_$(echo "${CBM_OS}_${CBM_ARCH}" | tr '[:lower:]' '[:upper:]')"
    CBM_TMP=$(mktemp -d)
    curl -fsSL \
      "https://github.com/DeusData/codebase-memory-mcp/releases/download/v${CBM_VERSION}/codebase-memory-mcp-${CBM_OS}-${CBM_ARCH}.tar.gz" \
      -o "$CBM_TMP/cbm.tar.gz"

    # macOS has shasum, not sha256sum.
    if command -v sha256sum >/dev/null 2>&1; then
      echo "${CBM_SHA256}  $CBM_TMP/cbm.tar.gz" | sha256sum -c
    else
      echo "${CBM_SHA256}  $CBM_TMP/cbm.tar.gz" | shasum -a 256 -c
    fi

    # Extract only the binary — the archive also ships its own install.sh, which
    # rewrites ~/.claude.json and must never run here.
    tar -xzf "$CBM_TMP/cbm.tar.gz" -C "$CBM_TMP" codebase-memory-mcp

    # A daemon from the old build holds the cache root and rejects mismatched
    # build fingerprints (0.10.x+). Stop it before swapping the binary.
    if [ -n "$CBM_INSTALLED_VERSION" ]; then
      "$CBM_BINARY_PATH" daemon stop >/dev/null 2>&1 || true
    fi

    sudo mkdir -p /opt/buildd/bin
    sudo install -m 0755 "$CBM_TMP/codebase-memory-mcp" "$CBM_BINARY_PATH"
    rm -rf "$CBM_TMP"
    CBM_VER=$("$CBM_BINARY_PATH" --version 2>&1 | head -1 || echo "installed")
    echo -e "${GREEN}codebase-memory-mcp installed: ${CBM_VER}${NC}"
  fi
fi

echo ""
echo -e "${GREEN}Installation complete!${NC}"
echo ""
echo "Run buildd to start:"
echo "  buildd"
echo ""
echo "Then open http://localhost:8766 to connect your account."
echo ""
echo "Config is stored in ~/.buildd/config.json"
echo ""

# Reload PATH for current session
export PATH="$BIN_DIR:$PATH"
echo -e "${YELLOW}Run 'source $SHELL_RC' or open a new terminal to use 'buildd' command${NC}"
