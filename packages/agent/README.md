# buildd-agent

Lightweight agent that connects to buildd server and executes tasks locally.

## Installation

```bash
cd packages/agent
go build -o buildd-agent
```

## Authentication Methods

buildd-agent supports **two authentication methods** for Claude:

### 1. OAuth Token (Seat-Based) - Recommended for Users

Uses your Claude Pro/Team subscription seat. **No per-token costs** - included in your plan.

```bash
# Authenticate with Claude
claude auth

# Run agent with OAuth
export BUILDD_SERVER=http://localhost:3000
export BUILDD_API_KEY=buildd_user_xxxxx
export CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.config/claude/auth.json | jq -r .token)

./buildd-agent --workspace=ws-123 --max-tasks=1
```

**Best for:**
- Personal laptops (user accounts)
- Team member workspaces
- Development/testing

**Limits:**
- Concurrent sessions (typically 1-3 per seat)
- Fair use policy

### 2. API Key (Pay-Per-Token) - Recommended for Production

Uses Anthropic API with per-token billing. Costs tracked and enforced.

```bash
# Run agent with API key
export BUILDD_SERVER=http://localhost:3000
export BUILDD_API_KEY=buildd_svc_xxxxx
export ANTHROPIC_API_KEY=sk-ant-xxxxx

./buildd-agent --workspace=ws-123 --max-tasks=10
```

**Best for:**
- Service accounts (dedicated VMs)
- GitHub Actions (CI/CD)
- Production workloads
- High concurrency needs

**Limits:**
- Cost per day (e.g., $500/day)
- Concurrent workers

## Usage

### Local Development (OAuth)

```bash
# First time: authenticate with Claude
claude auth

# Run agent
export BUILDD_SERVER=http://localhost:3000
export BUILDD_API_KEY=buildd_user_xxxxx
export CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.config/claude/auth.json | jq -r .token)

./buildd-agent --workspace=ws-123 --max-tasks=3
```

### Coder Workspace

Add to your `.coder/startup.sh`:

```bash
#!/bin/bash

# Install buildd-agent
curl -fsSL https://buildd.dev/install-agent.sh | bash

# Start agent in background
buildd-agent --server=$BUILDD_SERVER --api-key=$BUILDD_API_KEY &
```

### GitHub Action (API Authentication)

GitHub Actions should use **API authentication** (pay-per-token) since they're ephemeral runners.

```yaml
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

      - name: Install buildd-agent
        run: |
          curl -fsSL https://buildd.dev/install-agent.sh | bash

      - name: Run buildd agent
        env:
          BUILDD_SERVER: https://api.buildd.dev
          BUILDD_API_KEY: ${{ secrets.BUILDD_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          buildd-agent --max-tasks=1
```

**Note:** No `claude auth` needed - uses ANTHROPIC_API_KEY directly.

## Configuration

### Required

| Flag | Environment Variable | Description |
|------|---------------------|-------------|
| `--server` | `BUILDD_SERVER` | buildd server URL (default: `http://localhost:3000`) |
| `--api-key` | `BUILDD_API_KEY` | buildd account API key (required) |

### Claude Authentication (Choose One)

| Environment Variable | Auth Type | Cost Model | Best For |
|---------------------|-----------|------------|----------|
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth | Seat-based (included in plan) | Users, team members |
| `ANTHROPIC_API_KEY` | API | Pay-per-token | Service accounts, CI/CD |

**The agent will automatically detect which is set and use the appropriate authentication method.**

### Optional

| Flag | Default | Description |
|------|---------|-------------|
| `--workspace` | - | Workspace ID to claim tasks from (optional filter) |
| `--max-tasks` | `3` | Maximum concurrent tasks |

## How It Works

1. Agent connects to buildd server with API key
2. Polls `/api/workers/claim` endpoint every 10 seconds
3. Server returns claimable tasks based on:
   - Account permissions (accountWorkspaces)
   - Account type (user/service/action)
   - Runner preference (task.runnerPreference)
   - Concurrent worker limits
4. Agent creates WorkerRunner for each claimed task
5. WorkerRunner executes Claude locally via SDK
6. Progress reported back to server via SSE/REST
7. On completion, agent claims more tasks

## Task Claiming Flow

```
Agent                    buildd Server               Database
  |                           |                          |
  |--POST /api/workers/claim->|                          |
  |  Authorization: Bearer XX |                          |
  |                           |--Query available tasks-->|
  |                           |<-Return pending tasks----|
  |                           |--Create workers--------->|
  |                           |--Mark tasks as claimed-->|
  |<-Return workers + tasks---|                          |
  |                           |                          |
  |--(Start WorkerRunner)     |                          |
  |                           |                          |
  |--PATCH /api/workers/:id-->|                          |
  |  (progress updates)       |--Update worker status--->|
  |                           |                          |
  |--PATCH /api/workers/:id-->|                          |
  |  (completion)             |--Mark task complete----->|
```

## Production Deployment

### Systemd Service

```ini
[Unit]
Description=buildd agent
After=network.target

[Service]
Type=simple
User=buildd
WorkingDirectory=/opt/buildd
Environment="BUILDD_SERVER=https://api.buildd.dev"
Environment="BUILDD_API_KEY=buildd_xxxxx"
Environment="ANTHROPIC_API_KEY=sk-ant-xxxxx"
ExecStart=/usr/local/bin/buildd-agent --max-tasks=5
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Docker

```dockerfile
FROM golang:1.21 AS builder
WORKDIR /app
COPY . .
RUN go build -o buildd-agent

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/buildd-agent /usr/local/bin/
ENTRYPOINT ["buildd-agent"]
```

```bash
docker run -e BUILDD_SERVER=https://api.buildd.dev \
           -e BUILDD_API_KEY=buildd_xxxxx \
           -e ANTHROPIC_API_KEY=sk-ant-xxxxx \
           buildd-agent --max-tasks=3
```

## Future Enhancements

- [ ] WebSocket connection for real-time task push
- [ ] Git worktree isolation (like CCM)
- [ ] Local artifact caching
- [ ] Capability detection (node version, docker, etc.)
- [ ] Health monitoring and auto-recovery
- [ ] Multi-workspace support
