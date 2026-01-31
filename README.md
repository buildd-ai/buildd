# buildd

**Distributed AI dev team orchestration.** Task broker that coordinates agents across laptops, Coder workspaces, GitHub Actions, and dedicated VMs.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                buildd Server (Next.js on Vercel)            │
│                - UI, DB, task management                    │
│                - Bun runtime for speed                      │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ REST API + SSE
          ┌───────────────────┼───────────────────┐
          │                   │                   │
   ┌──────┴─────┐      ┌──────┴─────┐      ┌──────┴─────┐
   │ buildd-agent│     │ buildd-agent│     │ buildd-agent│
   │ (Bun binary)│     │ (Bun binary)│     │ (Bun binary)│
   │             │     │             │     │             │
   │ Your laptop │     │ Coder WS    │     │ GH Action   │
   └─────────────┘     └─────────────┘     └─────────────┘
```

**Stack:**
- **Server**: Next.js + Bun runtime on Vercel
- **Agent**: Bun CLI (compiles to standalone binary)
- **Database**: Neon (PostgreSQL)
- **Shared**: TypeScript monorepo

## Project Structure

```
buildd/ (Bun monorepo)
├── apps/
│   ├── web/              # Next.js app (Vercel deployment)
│   │   ├── app/          # App Router
│   │   │   ├── api/      # API routes for agents
│   │   │   ├── actions/  # Server Actions for UI
│   │   │   └── page.tsx  # Dashboard
│   │   └── vercel.json   # Bun runtime config
│   │
│   └── agent/            # Bun CLI agent
│       ├── src/
│       │   ├── index.ts  # CLI entry
│       │   ├── agent.ts  # Task claiming
│       │   └── runner.ts # Claude execution
│       └── package.json  # bun build --compile
│
├── packages/
│   ├── shared/           # Shared types
│   └── core/             # Shared business logic
│       ├── db/           # Drizzle schema + client
│       ├── worker-runner.ts
│       └── config.ts
│
└── bun.workspaces        # Monorepo config
```

**Key Benefits:**
- ✅ One runtime (Bun) for everything
- ✅ One lockfile (`bun.lockb`)
- ✅ Shared types & logic (`@buildd/shared`, `@buildd/core`)
- ✅ Fast development (Bun is 10x faster than Node)
- ✅ Agent compiles to binary (`bun build --compile`)
- ✅ Vercel deployment with Bun runtime

**buildd = Task broker** that doesn't care what's executing:
- **User agents**: Run on your laptop when you're AFK
- **Service accounts**: Always-on VMs for background work
- **GitHub Actions**: Ephemeral runners for deterministic tasks
- **Coder workspaces**: Team members in their dev environments

## Account Types

buildd supports **two authentication models** for Claude:

- **OAuth (Seat-Based)**: Uses Claude Pro/Team subscription. Fixed monthly cost, session-limited.
- **API (Pay-Per-Token)**: Uses Anthropic API. Variable cost per token, scalable.

See [AUTH_MODELS.md](./AUTH_MODELS.md) for detailed comparison.

### User Accounts (OAuth Recommended)
Personal accounts for developers. Run agents on your local machine using your Claude Pro seat.
- **Auth**: OAuth (included in subscription)
- **Limits**: 1-3 concurrent sessions
- **Cost**: $0 marginal (included in $20/mo Pro)
- **Example**: Max's laptop claiming weekend tasks

### Service Accounts (API Recommended)
Dedicated always-on agents for production workloads.
- **Auth**: API (pay-per-token)
- **Limits**: Configurable (e.g., 10 workers, $500/day)
- **Cost**: Variable based on usage
- **Example**: `prod-worker` VM running 24/7

### GitHub Action Accounts (API Required)
Ephemeral agents triggered by CI/CD.
- **Auth**: API (ephemeral runners can't use OAuth)
- **Limits**: Per-run cost caps
- **Cost**: Pay per CI run
- **Example**: `gh-ci` bot handling PR tasks

## Quick Start

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Start the Server

```bash
# Install dependencies (all workspaces)
bun install

# Set up environment
cp .env.example .env
# Edit .env with your Neon + Anthropic keys

# Generate and run migrations
cd packages/core
bun run drizzle-kit generate
bun run drizzle-kit migrate
cd ../..

# Start Next.js dev server (with Bun runtime)
bun dev
```

Server runs at `http://localhost:3000`

### 2. Create an Account

**Option A: User Account (OAuth - Seat-Based)**

```bash
# First authenticate with Claude
claude auth

# Create OAuth account
curl -X POST http://localhost:3000/api/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "type": "user",
    "name": "Max Local Agent",
    "authType": "oauth",
    "oauthToken": "'$(cat ~/.config/claude/auth.json | jq -r .token)'",
    "maxConcurrentSessions": 1,
    "maxConcurrentWorkers": 3
  }'

# Response: { "id": "acc-123", "apiKey": "buildd_user_xxxxx", ... }
```

**Option B: Service Account (API - Pay-Per-Token)**

```bash
# Create API account
curl -X POST http://localhost:3000/api/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "type": "service",
    "name": "Prod Worker",
    "authType": "api",
    "anthropicApiKey": "sk-ant-xxxxx",
    "maxCostPerDay": 500,
    "maxConcurrentWorkers": 10
  }'

# Response: { "id": "acc-456", "apiKey": "buildd_service_xxxxx", ... }
```

### 3. Grant Workspace Access

```bash
curl -X POST http://localhost:3000/api/accounts/acc-123/workspaces \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "ws-456",
    "canClaim": true,
    "canCreate": false
  }'
```

### 4. Run an Agent

**Option A: User Agent (OAuth)**

```bash
# Authenticate with Claude
claude auth

# Run agent with Bun
cd apps/agent
export BUILDD_API_KEY=buildd_user_xxxxx
export CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.config/claude/auth.json | jq -r .token)

bun run start --server=http://localhost:3000 --max-tasks=3
```

**Option B: Service Agent (API)**

```bash
cd apps/agent
export BUILDD_API_KEY=buildd_service_xxxxx
export ANTHROPIC_API_KEY=sk-ant-xxxxx

bun run start --server=http://localhost:3000 --max-tasks=10
```

**Build Binary (Production):**

```bash
cd apps/agent
bun run build
# → Outputs to dist/buildd-agent (standalone binary)

./dist/buildd-agent --server=https://api.buildd.dev --api-key=xxx
```

Agent automatically detects authentication method (OAuth vs API) based on environment variables.

## Task Routing

Tasks are automatically routed based on `runnerPreference`:

| Preference | Routes To | Example Use Case |
|------------|-----------|------------------|
| `any` | First available agent | General development tasks |
| `user` | User accounts only | Creative/design decisions |
| `service` | Service accounts only | Critical prod work |
| `action` | GitHub Actions only | Tests, deployments, migrations |

## GitHub Actions Integration

### 1. Create Action Account

```bash
curl -X POST http://localhost:3000/api/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "type": "action",
    "name": "GitHub CI Bot",
    "githubId": "my-org/my-repo"
  }'
```

### 2. Add Workflow

```yaml
# .github/workflows/buildd.yml
name: buildd worker

on:
  repository_dispatch:
    types: [buildd-task]
  workflow_dispatch:

jobs:
  work:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Claude
        run: curl -fsSL https://claude.ai/install.sh | bash

      - name: Install buildd-agent
        run: curl -fsSL https://buildd.dev/install-agent.sh | bash

      - name: Run agent
        env:
          BUILDD_SERVER: ${{ secrets.BUILDD_SERVER }}
          BUILDD_API_KEY: ${{ secrets.BUILDD_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: buildd-agent --max-tasks=1
```

### 3. Trigger from Server

When a task with `runnerPreference: "action"` is created, server can trigger the workflow:

```typescript
// Server automatically dispatches
await octokit.repos.createDispatchEvent({
  owner: 'org',
  repo: 'repo',
  event_type: 'buildd-task',
  client_payload: { task_id: task.id }
});
```

## Data Model

```
accounts → account_workspaces → workspaces
accounts → tasks (claimed_by)
accounts → workers

workspaces → sources → tasks → workers
workers → artifacts → comments
workers → messages → attachments
```

## Stack

- **Backend**: Fastify + TypeScript + Drizzle
- **Database**: Neon (Postgres)
- **Agent**: Claude Agent SDK
- **Frontend**: React + Vite (coming soon)

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/workspaces | List workspaces |
| POST | /api/workspaces | Create workspace |
| GET | /api/tasks | List tasks |
| POST | /api/tasks | Create task |
| GET | /api/workers | List workers |
| POST | /api/workers | Create worker |
| POST | /api/workers/:id/start | Start worker |
| POST | /api/workers/:id/pause | Pause worker |
| GET | /api/events | SSE event stream |

## Worker States

```
idle → starting → running ⟷ waiting_input
                    ↓
         completed | error | paused
```

## License

MIT
