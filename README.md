# buildd

**Distributed AI dev team orchestration.** Task broker that coordinates Claude agents across laptops, Coder workspaces, GitHub Actions, and dedicated VMs.

**Live:** https://buildd-three.vercel.app

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                buildd Server (Next.js on Vercel)            │
│                - Dashboard, Auth, Task Management           │
│                - REST API for agents                        │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ REST API
          ┌───────────────────┼───────────────────┐
          │                   │                   │
   ┌──────┴──────┐     ┌──────┴──────┐     ┌──────┴──────┐
   │ Claude Code │     │ Agent Binary│     │ GitHub      │
   │ + MCP       │     │ (Bun)       │     │ Actions     │
   │             │     │             │     │             │
   │ Your laptop │     │ Coder/VM    │     │ CI runner   │
   └─────────────┘     └─────────────┘     └─────────────┘
```

## Quick Start

### 1. Get an API Key

1. Go to https://buildd-three.vercel.app
2. Sign in with Google
3. Go to **Accounts** → **New Account**
4. Copy your API key (`bld_xxx...`)

### 2. Connect Claude Code (Recommended)

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "buildd": {
      "command": "bun",
      "args": ["run", "/path/to/buildd/apps/mcp-server/src/index.ts"],
      "env": {
        "BUILDD_SERVER": "https://buildd-three.vercel.app",
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

### 3. Or Run the Agent Binary

```bash
cd apps/agent
export BUILDD_API_KEY=bld_xxx
export BUILDD_SERVER=https://buildd-three.vercel.app
export CLAUDE_CODE_OAUTH_TOKEN=xxx  # or ANTHROPIC_API_KEY

bun run start --max-tasks=1
```

## Project Structure

```
buildd/
├── apps/
│   ├── web/                 # Next.js dashboard (Vercel)
│   │   └── src/
│   │       ├── app/         # App Router
│   │       │   ├── (protected)/  # Auth-required pages
│   │       │   │   ├── dashboard/
│   │       │   │   ├── workspaces/
│   │       │   │   ├── tasks/
│   │       │   │   ├── workers/
│   │       │   │   └── accounts/
│   │       │   ├── api/     # REST API
│   │       │   │   ├── auth/[...nextauth]/
│   │       │   │   ├── workspaces/
│   │       │   │   ├── tasks/
│   │       │   │   ├── workers/
│   │       │   │   │   ├── claim/
│   │       │   │   │   └── [id]/
│   │       │   │   └── accounts/
│   │       │   └── auth/    # Sign in/error pages
│   │       ├── auth.ts      # NextAuth config
│   │       └── lib/         # Pusher, auth helpers
│   │
│   ├── agent/               # Standalone agent binary
│   │   └── src/
│   │       ├── index.ts     # CLI entry
│   │       ├── agent.ts     # Task polling
│   │       └── runner.ts    # Claude execution
│   │
│   └── mcp-server/          # MCP server for Claude Code
│       └── src/
│           └── index.ts     # MCP tools
│
└── packages/
    ├── shared/              # Shared TypeScript types
    └── core/                # Database, config
        ├── db/
        │   ├── schema.ts    # Drizzle schema
        │   └── client.ts    # DB connection
        └── drizzle.config.ts
```

## API Endpoints

### Authentication
All agent endpoints require `Authorization: Bearer <API_KEY>` header.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workers/claim` | Claim available tasks |
| GET | `/api/workers/:id` | Get worker details |
| PATCH | `/api/workers/:id` | Update worker status |
| GET | `/api/workspaces` | List workspaces |
| POST | `/api/workspaces` | Create workspace |
| GET | `/api/tasks` | List tasks |
| POST | `/api/tasks` | Create task |
| GET | `/api/accounts` | List accounts |
| POST | `/api/accounts` | Create account |

### Claim Tasks

```bash
curl -X POST https://buildd-three.vercel.app/api/workers/claim \
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
curl -X PATCH https://buildd-three.vercel.app/api/workers/:id \
  -H "Authorization: Bearer bld_xxx" \
  -H "Content-Type: application/json" \
  -d '{"status": "running", "progress": 50}'

# Mark complete
curl -X PATCH https://buildd-three.vercel.app/api/workers/:id \
  -d '{"status": "completed"}'

# Mark failed
curl -X PATCH https://buildd-three.vercel.app/api/workers/:id \
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

## Account Types

| Type | Description | Auth Method |
|------|-------------|-------------|
| `user` | Personal laptop/workstation | OAuth (seat-based) |
| `service` | Always-on server/VM | API (pay-per-token) |
| `action` | GitHub Actions runner | API (pay-per-token) |

## Authentication Methods

### OAuth (CLAUDE_CODE_OAUTH_TOKEN)
- Uses Claude Pro/Team subscription
- Seat-based billing (fixed monthly cost)
- Best for: User accounts, personal use

### API (ANTHROPIC_API_KEY)
- Pay-per-token billing
- Scalable, no session limits
- Best for: Service accounts, CI/CD

## Environment Variables

### Vercel (Required)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Neon PostgreSQL connection |
| `AUTH_SECRET` | NextAuth secret (`openssl rand -base64 32`) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth secret |

### Vercel (Optional)

| Variable | Description |
|----------|-------------|
| `ALLOWED_EMAILS` | Comma-separated email whitelist |
| `PUSHER_APP_ID` | Pusher app ID (for realtime) |
| `PUSHER_KEY` | Pusher key |
| `PUSHER_SECRET` | Pusher secret |
| `PUSHER_CLUSTER` | Pusher cluster (e.g., us2) |
| `NEXT_PUBLIC_PUSHER_KEY` | Same as PUSHER_KEY |
| `NEXT_PUBLIC_PUSHER_CLUSTER` | Same as PUSHER_CLUSTER |

### Agent

| Variable | Description |
|----------|-------------|
| `BUILDD_SERVER` | Server URL |
| `BUILDD_API_KEY` | Your API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token (seat-based) |
| `ANTHROPIC_API_KEY` | API key (pay-per-token) |

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
cd packages/core
bun run db:push

# Run dev server
cd ../..
bun dev
```

## Database

Uses Drizzle ORM with Neon PostgreSQL.

```bash
# Push schema changes
cd packages/core
bun run db:push

# Generate migrations
bun run db:generate

# Open Drizzle Studio
bun run db:studio
```

## Stack

- **Runtime**: Bun
- **Framework**: Next.js 15 (App Router)
- **Database**: Neon PostgreSQL + Drizzle ORM
- **Auth**: NextAuth v5 + Google OAuth
- **Deployment**: Vercel
- **Realtime**: Pusher (optional)
- **Agent**: Claude Code SDK / Claude CLI

## License

MIT
