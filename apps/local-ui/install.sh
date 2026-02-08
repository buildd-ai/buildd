#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}Installing buildd local-ui...${NC}"

# Check for bun
if ! command -v bun &> /dev/null; then
  echo -e "${YELLOW}Bun not found. Installing...${NC}"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Install directory
INSTALL_DIR="$HOME/.buildd"
BIN_DIR="$HOME/.local/bin"

# Clone or update using sparse checkout (only apps/local-ui)
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing installation..."
  cd "$INSTALL_DIR"

  # Update sparse checkout config (in case it changed)
  cat > .git/info/sparse-checkout << 'SPARSE'
apps/local-ui/
apps/mcp-server/
packages/shared/
package.json
SPARSE

  # Fetch and apply updates
  git fetch origin dev
  git checkout -- bun.lock 2>/dev/null || true  # Discard local lockfile changes
  git read-tree -mu HEAD  # Re-apply sparse checkout to get new paths
  git reset --hard origin/dev
else
  echo "Cloning buildd (local-ui only)..."

  # Clean install dir if it exists but isn't a git repo
  [ -d "$INSTALL_DIR" ] && rm -rf "$INSTALL_DIR"

  # Initialize sparse checkout
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  git init
  git remote add origin https://github.com/buildd-ai/buildd.git
  git config core.sparseCheckout true

  # Checkout local-ui app, mcp-server, shared package, and root package.json (for workspaces)
  cat > .git/info/sparse-checkout << 'SPARSE'
apps/local-ui/
apps/mcp-server/
packages/shared/
package.json
SPARSE

  # Fetch and checkout
  git fetch --depth 1 origin dev
  git checkout dev
fi

# Install dependencies
cd "$INSTALL_DIR/apps/local-ui"
bun install

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

    # Write .mcp.json
    cat > .mcp.json << MCPEOF
{
  "mcpServers": {
    "buildd": {
      "command": "bun",
      "args": ["run", "$HOME/.buildd/apps/mcp-server/src/index.ts"],
      "env": {
        "BUILDD_WORKSPACE": "$WORKSPACE_ID"
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

      if [ -f "$CLAUDE_JSON" ]; then
        # Merge into existing config
        bun -e "
          const fs = require('fs');
          const config = JSON.parse(fs.readFileSync('$CLAUDE_JSON', 'utf-8'));
          if (!config.mcpServers) config.mcpServers = {};
          config.mcpServers.buildd = {
            command: 'bun',
            args: ['run', '$HOME/.buildd/apps/mcp-server/src/index.ts']
          };
          fs.writeFileSync('$CLAUDE_JSON', JSON.stringify(config, null, 2) + '\n');
        "
      else
        cat > "$CLAUDE_JSON" << GLOBALEOF
{
  "mcpServers": {
    "buildd": {
      "command": "bun",
      "args": ["run", "$HOME/.buildd/apps/mcp-server/src/index.ts"]
    }
  }
}
GLOBALEOF
      fi

      echo "Registered buildd MCP server globally in ~/.claude.json"
      echo "Buildd will be available in every Claude Code session."
      echo "Workspace will be auto-detected from git remote."
      exit 0
    else
      echo "Usage: buildd install --global"
      echo ""
      echo "Registers the buildd MCP server globally for Claude Code."
      exit 1
    fi
    ;;
esac

# Run
exec bun run "$HOME/.buildd/apps/local-ui/src/index.ts" "$@"
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
