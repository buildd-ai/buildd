# buildd MCP Server

Connect Claude Code directly to buildd for task management.

## Setup

### Recommended: `buildd login`

The easiest way to set up the MCP server is via the CLI login flow, which auto-configures everything:

```bash
# Install buildd
curl -fsSL https://buildd.dev/install.sh | bash

# Login — this saves your API key AND configures the MCP server in ~/.claude.json
buildd login
```

After login, restart Claude Code and the buildd MCP tools will be available in every session.

### Alternative: Manual Setup

If you prefer manual configuration, or want per-project setup:

**Global** (all Claude Code sessions):

```bash
buildd install --global
```

**Per-project** (single repo):

```bash
cd your-repo
buildd init <workspace-id>
```

**Manual `.mcp.json`**:

```json
{
  "mcpServers": {
    "buildd": {
      "command": "bun",
      "args": ["run", "~/.buildd/apps/mcp-server/src/index.ts"],
      "env": {
        "BUILDD_WORKSPACE": "optional-workspace-id"
      }
    }
  }
}
```

The MCP server reads your API key from `~/.buildd/config.json` automatically. You can override with env vars if needed.

## Available Tools

| Tool | Description |
|------|-------------|
| `buildd_list_tasks` | List available tasks |
| `buildd_claim_task` | Claim a task to work on |
| `buildd_update_progress` | Report progress (0-100%) |
| `buildd_complete_task` | Mark task as done |
| `buildd_fail_task` | Mark task as failed |
| `buildd_create_task` | Create a new task (admin) |
| `buildd_search_memory` | Search workspace observations |
| `buildd_save_memory` | Save an observation |

## Usage

Just ask Claude Code:

- *"Check buildd for available tasks"*
- *"Claim a task from buildd and work on it"*
- *"Update buildd progress to 50%"*
- *"Mark the buildd task as complete"*

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BUILDD_SERVER` | API server URL (default: config.json or https://buildd.dev) |
| `BUILDD_API_KEY` | API key (default: reads from `~/.buildd/config.json`) |
| `BUILDD_WORKSPACE` | Filter to a specific workspace ID |
| `BUILDD_WORKER_ID` | Worker context for subtask creation |
