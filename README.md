# buildd

**Distributed AI dev team orchestration.** Task broker that coordinates agents across laptops, Coder workspaces, GitHub Actions, and dedicated VMs.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    buildd Server (hosted)                   │
│                    - UI, DB, task management                │
│                    - SSE aggregation                        │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ REST API + SSE
          ┌───────────────────┼───────────────────┐
          │                   │                   │
   ┌──────┴─────┐      ┌──────┴─────┐      ┌──────┴─────┐
   │ buildd-agent│     │ buildd-agent│     │ buildd-agent│
   │  (Go binary)│     │  (Go binary)│     │  (Go binary)│
   │             │     │             │     │             │
   │ Your laptop │     │ Coder WS    │     │ GH Action   │
   └─────────────┘     └─────────────┘     └─────────────┘
```

**buildd = Task broker** that doesn't care what's executing:
- **User agents**: Run on your laptop when you're AFK
- **Service accounts**: Always-on VMs for background work
- **GitHub Actions**: Ephemeral runners for deterministic tasks
- **Coder workspaces**: Team members in their dev environments

## Account Types

### User Accounts
Personal accounts for developers. Run agents on your local machine.
- **Use case**: Pick up tasks while you're away
- **Limits**: 3 concurrent workers, $50/day
- **Example**: Max's laptop claiming weekend tasks

### Service Accounts
Dedicated always-on agents for production workloads.
- **Use case**: Background work, high-priority tasks
- **Limits**: Configurable (e.g., 10 workers, $500/day)
- **Example**: `prod-worker` VM running 24/7

### GitHub Action Accounts
Ephemeral agents triggered by CI/CD.
- **Use case**: Deterministic work (tests, deploys, migrations)
- **Limits**: Per-run limits
- **Example**: `gh-ci` bot handling PR tasks

## Quick Start

### 1. Start the Server

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
# Edit .env with your Neon + Anthropic keys

# Generate and run migrations
pnpm db:generate
pnpm db:migrate

# Start server + web UI
pnpm dev
```

Server runs at `http://localhost:3000`

### 2. Create an Account

```bash
# Create a user account
curl -X POST http://localhost:3000/api/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "type": "user",
    "name": "Max Local Agent",
    "maxConcurrentWorkers": 3,
    "maxCostPerDay": 50
  }'

# Response includes your API key:
# { "id": "acc-123", "apiKey": "buildd_xxxxx", ... }
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

```bash
cd packages/agent
go build -o buildd-agent

export BUILDD_SERVER=http://localhost:3000
export BUILDD_API_KEY=buildd_xxxxx
export ANTHROPIC_API_KEY=sk-ant-xxxxx

./buildd-agent --workspace=ws-456 --max-tasks=3
```

Agent will poll for tasks and execute them locally.

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
