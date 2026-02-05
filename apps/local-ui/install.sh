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
packages/shared/
package.json
SPARSE

  # Fetch and apply updates
  git fetch origin dev
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

  # Checkout local-ui app, shared package, and root package.json (for workspaces)
  cat > .git/info/sparse-checkout << 'SPARSE'
apps/local-ui/
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
#   BUILDD_SERVER   - Server URL (default: https://app.buildd.dev)
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
