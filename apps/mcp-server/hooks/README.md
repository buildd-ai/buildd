# Buildd Hooks Integration

Enable automatic activity tracking for MCP workers using Claude Code hooks.

## Quick Setup

### 1. Copy hooks config

```bash
mkdir -p ~/.claude
cp buildd-hooks.json ~/.claude/hooks.json
```

Or create manually:

```bash
cat > ~/.claude/hooks.json << 'EOF'
{
  "hooks": {
    "post_tool_use": [{
      "command": "curl -sf -X POST \"${BUILDD_SERVER:-https://buildd-three.vercel.app}/api/workers/${BUILDD_WORKER_ID}/activity\" -H \"Authorization: Bearer $BUILDD_API_KEY\" -H \"Content-Type: application/json\" -d '{\"toolName\": \"'\"$CLAUDE_TOOL_NAME\"'\"}' >/dev/null 2>&1 || true",
      "timeout": 2000
    }]
  }
}
EOF
```

### 2. Set environment variables

When you claim a task via MCP, you'll get export commands:

```bash
export BUILDD_WORKER_ID=<worker-id>
export BUILDD_SERVER=https://buildd-three.vercel.app
export BUILDD_API_KEY=bld_xxx  # Your API key
```

### 3. Start working

Every tool call will automatically report activity to buildd, giving you near-local-ui visibility in the dashboard.

## How it works

```
Claude Code              Buildd Server              Dashboard
    │                         │                         │
    │ [Tool: Edit file.ts]    │                         │
    │ ──────────────────────► │                         │
    │                         │                         │
    │ [Hook: POST /activity]  │                         │
    │ ──────────────────────► │ Update milestones       │
    │                         │ ──────────────────────► │
    │                         │                         │ "Edit file.ts"
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BUILDD_WORKER_ID` | Worker ID from claim_task |
| `BUILDD_SERVER` | Buildd server URL (default: https://buildd-three.vercel.app) |
| `BUILDD_API_KEY` | Your buildd API key |

## Coder Integration

For Coder workspaces, hooks are auto-configured in the template. No manual setup needed.
