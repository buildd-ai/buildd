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

### Remote (Streamable HTTP)

You can also connect to buildd via the remote HTTP MCP endpoint — no local installation needed:

```json
{
  "mcpServers": {
    "buildd": {
      "type": "streamable-http",
      "url": "https://buildd.dev/api/mcp",
      "headers": {
        "Authorization": "Bearer bld_your_api_key"
      }
    }
  }
}
```

Note: The remote server does not support `filePath` or `repo` params for `register_skill` (no filesystem access). Use the `content` param instead, or use the local stdio server.

## Available Tools

### `buildd` — Task Coordination

Single tool with an `action` parameter. Available actions depend on your account level.

**Worker actions** (all accounts):

| Action | Params | Description |
|--------|--------|-------------|
| `list_tasks` | `offset?` | List pending tasks sorted by priority |
| `claim_task` | `maxTasks?, workspaceId?` | Auto-claim highest-priority pending task |
| `update_progress` | `workerId, progress, message?, plan?` | Report progress (0-100%) or submit a plan |
| `complete_task` | `workerId, summary?, error?` | Mark task done or failed |
| `create_pr` | `workerId, title, head, body?, base?` | Create a GitHub PR tracked on the worker |
| `update_task` | `taskId, title?, description?, priority?` | Update task fields |
| `create_task` | `title, description, workspaceId?, priority?` | Create a new task |
| `create_artifact` | `workerId, type, title, content?, url?` | Create a shareable artifact |
| `list_artifacts` | `workspaceId?, key?, type?` | List artifacts |
| `update_artifact` | `artifactId, title?, content?` | Update an artifact |
| `review_workspace` | `hoursBack?, workspaceId?` | Review recent task quality |
| `emit_event` | `workerId, type, label, metadata?` | Record a custom milestone event |
| `query_events` | `workerId, type?` | Read events from worker timeline |

**Admin actions** (admin-level API key only):

| Action | Params | Description |
|--------|--------|-------------|
| `create_schedule` | `name, cronExpression, title, ...` | Create a recurring schedule |
| `update_schedule` | `scheduleId, cronExpression?, ...` | Update a schedule |
| `list_schedules` | `workspaceId?` | List all schedules |
| `register_skill` | `name?, content?, filePath?, repo?` | Register a skill |

### `buildd_memory` — Workspace Knowledge

| Action | Params | Description |
|--------|--------|-------------|
| `search` | `query?, type?, files?, concepts?, limit?` | Search observations |
| `save` | `type, title, content, files?, concepts?` | Save an observation |
| `update` | `id, title?, content?, type?, files?, concepts?` | Update an observation |
| `delete` | `id` | Delete an observation |

## MCP Resources

The server also exposes read-only resources:

| URI | Description |
|-----|-------------|
| `buildd://tasks/pending` | Pending tasks sorted by priority |
| `buildd://workspace/memory` | Recent workspace observations |
| `buildd://workspace/skills` | Available skills |

## Usage

Just ask Claude Code:

- *"Check buildd for available tasks"*
- *"Claim a task from buildd and work on it"*
- *"Update buildd progress to 50%"*
- *"Mark the buildd task as complete"*
- *"Search buildd memory for auth patterns"*
- *"Save this as a buildd observation"*

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BUILDD_SERVER` | API server URL (default: config.json or https://buildd.dev) |
| `BUILDD_API_KEY` | API key (default: reads from `~/.buildd/config.json`) |
| `BUILDD_WORKSPACE` | Filter to a specific workspace ID |
| `BUILDD_WORKER_ID` | Worker context for subtask creation |
