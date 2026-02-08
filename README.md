# Buildd

**Task Queue for AI Agents** - Create tasks. Agents work. Code ships.

Open source task coordination system for Claude AI agents. Run agents on laptops, VMs, or GitHub Actions and control them all from one dashboard.

**Live:** https://buildd.dev

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                buildd Server (Next.js on Vercel)            │
│                - Dashboard, Auth, Task Management           │
│                - REST API for agents                        │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ REST API
          ┌──────────┬────────┼────────┬──────────┐
          │          │        │        │          │
   ┌──────┴──────┐ ┌─┴────────┴─┐ ┌────┴───┐ ┌────┴─────┐
   │ Claude Code │ │  Local UI  │ │ Agent  │ │ GitHub   │
   │ + MCP       │ │  (Bun)     │ │ Binary │ │ Actions  │
   │             │ │            │ │        │ │          │
   │ Your laptop │ │ Your laptop│ │ VM     │ │ CI runner│
   └─────────────┘ └────────────┘ └────────┘ └──────────┘
```

## Quick Start

### Install Local UI (Recommended)

```bash
curl -fsSL https://buildd.dev/install.sh | bash
```

This installs the **local-ui** - a standalone web interface for running workers on your machine with real-time streaming of agent output.

### Or Connect Claude Code via MCP

Add to your project's `.mcp.json`:

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

Then tell Claude Code:
- *"Check buildd for tasks"*
- *"Claim a task from buildd and work on it"*
- *"Mark the buildd task complete"*

### Or Run the Agent Binary

```bash
cd apps/agent
export BUILDD_API_KEY=bld_xxx
export BUILDD_SERVER=https://buildd.dev
export CLAUDE_CODE_OAUTH_TOKEN=xxx  # or ANTHROPIC_API_KEY

bun run start --max-tasks=1
```

## Features

- **Multi-agent coordination** - Run Claude agents on laptops, VMs, or GitHub Actions. One dashboard controls them all.
- **Real-time dashboard** - Monitor progress, costs, and artifacts via Pusher-powered live updates.
- **Planning mode** - Agents propose implementation plans for human approval before executing code changes.
- **GitHub-native** - Agents create branches, commit code, and open PRs. Full webhook integration.
- **Local UI** - Standalone web interface with agent output streaming, artifact viewer, and milestone tracking.
- **MCP integration** - Use Claude Code IDE to claim and work on tasks directly.
- **Dual auth** - API keys (pay-per-token) or OAuth (seat-based) with per-account cost tracking.
- **Workspace management** - Organize tasks by project with per-workspace context and memory.

## Project Structure

```
apps/
├── web/              Next.js dashboard + API (deployed on Vercel)
├── local-ui/         Standalone worker runner with web UI (Bun)
├── mcp-server/       Claude Code MCP integration
└── agent/            CLI-based headless worker

packages/
├── core/             Database schema (Drizzle ORM) + migrations
└── shared/           Shared TypeScript types
```

## API Endpoints

All agent endpoints require `Authorization: Bearer <API_KEY>` header.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workers/claim` | Claim available tasks |
| GET | `/api/workers/:id` | Get worker details |
| PATCH | `/api/workers/:id` | Update worker status/progress |
| POST | `/api/workers/:id/plan/submit` | Submit a plan for approval |
| GET | `/api/workers/:id/plan/status` | Check plan approval status |
| GET | `/api/workspaces` | List workspaces |
| POST | `/api/workspaces` | Create workspace |
| GET | `/api/tasks` | List tasks |
| POST | `/api/tasks` | Create task |
| GET | `/api/accounts` | List accounts |
| POST | `/api/accounts` | Create account |

### Claim Tasks

```bash
curl -X POST https://buildd.dev/api/workers/claim \
  -H "Authorization: Bearer bld_xxx" \
  -H "Content-Type: application/json" \
  -d '{"maxTasks": 1}'
```

Response:
```json
{
  "workers": [{
    "id": "worker-uuid",
    "taskId": "task-uuid",
    "branch": "buildd/abc123-fix-bug",
    "task": {
      "title": "Fix login bug",
      "description": "..."
    }
  }]
}
```

### Update Worker Status

```bash
# Report progress
curl -X PATCH https://buildd.dev/api/workers/:id \
  -H "Authorization: Bearer bld_xxx" \
  -H "Content-Type: application/json" \
  -d '{"status": "running", "progress": 50}'

# Mark complete
curl -X PATCH https://buildd.dev/api/workers/:id \
  -d '{"status": "completed"}'

# Mark failed
curl -X PATCH https://buildd.dev/api/workers/:id \
  -d '{"status": "failed", "error": "Build failed"}'
```

## MCP Tools

When using the MCP server with Claude Code:

| Tool | Description |
|------|-------------|
| `buildd_list_tasks` | List available tasks |
| `buildd_claim_task` | Claim a task to work on |
| `buildd_update_progress` | Report progress (0-100%) |
| `buildd_complete_task` | Mark task as done |
| `buildd_fail_task` | Mark task as failed |

## Authentication

### OAuth (CLAUDE_CODE_OAUTH_TOKEN)
- Uses Claude Pro/Team subscription
- Seat-based billing (fixed monthly cost)
- Best for: User accounts, personal use

### API (ANTHROPIC_API_KEY)
- Pay-per-token billing
- Scalable, no session limits
- Best for: Service accounts, CI/CD

## Development

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install

# Set up environment
cp .env.example .env.local
# Edit with your Neon DATABASE_URL

# Push database schema
cd packages/core && bun run db:push && cd ../..

# Run dev server
bun dev
```

### Database

Uses Drizzle ORM with Neon PostgreSQL.

```bash
cd packages/core

# Generate migrations (after schema changes)
bun run db:generate

# Run migrations
bun run db:migrate

# Open Drizzle Studio
bun run db:studio
```

### Environment Variables

#### Server (Vercel)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Neon PostgreSQL connection |
| `AUTH_SECRET` | Yes | NextAuth secret (`openssl rand -base64 32`) |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth secret |
| `ALLOWED_EMAILS` | No | Comma-separated email whitelist |
| `PUSHER_APP_ID` | No | Pusher app ID (for realtime) |
| `PUSHER_KEY` | No | Pusher key |
| `PUSHER_SECRET` | No | Pusher secret |
| `PUSHER_CLUSTER` | No | Pusher cluster (e.g., us2) |
| `NEXT_PUBLIC_PUSHER_KEY` | No | Same as PUSHER_KEY |
| `NEXT_PUBLIC_PUSHER_CLUSTER` | No | Same as PUSHER_CLUSTER |

#### Agent / Worker

| Variable | Description |
|----------|-------------|
| `BUILDD_SERVER` | Server URL |
| `BUILDD_API_KEY` | Your API key (`bld_xxx`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token (seat-based) |
| `ANTHROPIC_API_KEY` | API key (pay-per-token) |

## Tech Stack

- **Runtime**: Bun
- **Framework**: Next.js 16 (App Router)
- **Database**: Neon PostgreSQL + Drizzle ORM
- **Auth**: NextAuth v5 + Google OAuth
- **Deployment**: Vercel
- **Real-time**: Pusher
- **Agent SDK**: @anthropic-ai/claude-agent-sdk

## License

MIT
