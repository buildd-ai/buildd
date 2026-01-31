# buildd-agent

Lightweight agent that connects to buildd server and executes tasks locally.

## Installation

```bash
cd packages/agent
go build -o buildd-agent
```

## Usage

### Local Development

```bash
export BUILDD_SERVER=http://localhost:3000
export BUILDD_API_KEY=buildd_xxxxx
export ANTHROPIC_API_KEY=sk-ant-xxxxx

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

### GitHub Action

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

      - name: Setup Claude
        run: curl -fsSL https://claude.ai/install.sh | bash

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

## Configuration

| Flag | Environment Variable | Default | Description |
|------|---------------------|---------|-------------|
| `--server` | `BUILDD_SERVER` | `http://localhost:3000` | buildd server URL |
| `--api-key` | `BUILDD_API_KEY` | - | Account API key (required) |
| `--workspace` | - | - | Workspace ID to claim from |
| `--max-tasks` | - | `3` | Max concurrent tasks |

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
