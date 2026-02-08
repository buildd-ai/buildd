# buildd MCP Server

Connect Claude Code directly to buildd for task management.

## Setup

1. **Get an API key** from the buildd dashboard: https://buildd.dev/accounts

2. **Add to your project's `.mcp.json`**:

```json
{
  "mcpServers": {
    "buildd": {
      "command": "bun",
      "args": ["run", "/path/to/buildd/apps/mcp-server/src/index.ts"],
      "env": {
        "BUILDD_SERVER": "https://buildd.dev",
        "BUILDD_API_KEY": "bld_your_api_key_here"
      }
    }
  }
}
```

3. **Enable MCP servers** in `~/.claude/settings.json`:

```json
{
  "enableAllProjectMcpServers": true
}
```

4. **Restart Claude Code** to load the MCP server

## Available Tools

| Tool | Description |
|------|-------------|
| `buildd_list_tasks` | List available tasks |
| `buildd_claim_task` | Claim a task to work on |
| `buildd_update_progress` | Report progress (0-100%) |
| `buildd_complete_task` | Mark task as done |
| `buildd_fail_task` | Mark task as failed |

## Usage

Just ask Claude Code:

- *"Check buildd for available tasks"*
- *"Claim a task from buildd and work on it"*
- *"Update buildd progress to 50%"*
- *"Mark the buildd task as complete"*

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BUILDD_SERVER` | API server URL (default: https://buildd.dev) |
| `BUILDD_API_KEY` | Your API key from the dashboard |
