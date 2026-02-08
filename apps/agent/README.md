# buildd-agent

Lightweight Bun-based agent that connects to buildd server and executes tasks locally.

## Installation

```bash
# Development (runs TypeScript directly)
bun install
bun run start

# Production (compile to standalone binary)
bun run build
./dist/buildd-agent
```

## Authentication

### Recommended: `buildd login`

The simplest way to authenticate is via the CLI login flow. This saves your API key to `~/.buildd/config.json`, which the agent reads automatically:

```bash
# One-time setup (from any machine with buildd installed)
buildd login

# Then just run the agent — no env vars needed
bun run start --max-tasks=3
```

For headless environments (SSH, VMs), use the device code flow:

```bash
buildd login --device
```

### Alternative: Environment Variables

You can also set credentials explicitly via env vars (useful for CI/CD, Docker):

```bash
export BUILDD_API_KEY=bld_xxxxx        # Required: buildd account key
export BUILDD_SERVER=https://buildd.dev # Optional: defaults to config.json or buildd.dev
```

### Claude Authentication (for running tasks)

The agent also needs Claude credentials to execute code:

#### OAuth (Seat-Based) - Recommended for Users

```bash
claude auth
export CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.config/claude/auth.json | jq -r .token)
bun run start --max-tasks=3
```

#### API (Pay-Per-Token) - Recommended for Production

```bash
export ANTHROPIC_API_KEY=sk-ant-xxxxx
bun run start --max-tasks=10
```

## Usage

### Development

```bash
# Run directly with Bun (hot reload)
bun --watch src/index.ts --server=http://localhost:3000 --api-key=xxx

# Or via package.json script
bun run dev
```

### Production Build

```bash
# Compile to standalone binary (50-80MB, no runtime needed)
bun run build

# Run binary
./dist/buildd-agent --server=https://api.buildd.dev --api-key=xxx
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BUILDD_SERVER` | No | Server URL (default: config.json or https://buildd.dev) |
| `BUILDD_API_KEY` | No* | Account API key (*reads from `~/.buildd/config.json` if not set) |
| `CLAUDE_CODE_OAUTH_TOKEN` | One of | OAuth token for seat-based auth |
| `ANTHROPIC_API_KEY` | these | API key for pay-per-token auth |

### Command Line Options

```bash
buildd-agent [options]

Options:
  --server <url>       buildd server URL (default: $BUILDD_SERVER or config.json or https://buildd.dev)
  --api-key <key>      Account API key (default: $BUILDD_API_KEY or config.json)
  --workspace <id>     Workspace ID to claim tasks from (optional filter)
  --max-tasks <n>      Maximum concurrent tasks (default: 3)
```

## How It Works

1. Agent connects to buildd server with API key
2. Polls `/api/workers/claim` every 10 seconds
3. Server returns available tasks based on:
   - Account permissions
   - Account type (user/service/action)
   - Runner preference (task.runnerPreference)
   - Concurrent worker limits
4. Agent executes tasks using:
   - **OAuth**: `claude` CLI (if CLAUDE_CODE_OAUTH_TOKEN set)
   - **API**: Claude Agent SDK (if ANTHROPIC_API_KEY set)
5. Agent reports progress back to server
6. On completion, agent claims more tasks

## Deployment

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
ExecStart=/opt/buildd/buildd-agent --max-tasks=5
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Docker

```dockerfile
FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install
COPY src ./src
RUN bun run build

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/dist/buildd-agent /usr/local/bin/
ENTRYPOINT ["buildd-agent"]
```

### GitHub Actions

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
      - name: Install Bun
        uses: oven-sh/setup-bun@v1

      - name: Install buildd-agent
        run: |
          curl -fsSL https://buildd.dev/install-agent.sh | bash

      - name: Run agent
        env:
          BUILDD_SERVER: ${{ secrets.BUILDD_SERVER }}
          BUILDD_API_KEY: ${{ secrets.BUILDD_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: buildd-agent --max-tasks=1
```

## Why Bun?

- **Native TypeScript** - No build step in development
- **Single binary** - `bun build --compile` creates standalone executable
- **Fast startup** - 10x faster than Node.js
- **Claude Code alignment** - Claude CLI also uses Bun
- **Compatible** - Works with npm packages

## Development Tips

```bash
# Watch mode (auto-restart on changes)
bun --watch src/index.ts

# Debug output
DEBUG=* bun run start

# Test against local server
bun run start --server=http://localhost:3000

# Test OAuth auth
claude auth  # First authenticate
export CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.config/claude/auth.json | jq -r .token)
bun run start

# Test API auth
export ANTHROPIC_API_KEY=sk-ant-xxxxx
bun run start
```

## Build Output

```bash
$ bun run build
# Outputs: dist/buildd-agent (standalone binary)
# Size: ~50-80MB
# No Bun/Node runtime needed
# Works on any Linux/macOS machine
```

## Troubleshooting

### "No authentication configured"

Set either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`:

```bash
# For OAuth
claude auth
export CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.config/claude/auth.json | jq -r .token)

# For API
export ANTHROPIC_API_KEY=sk-ant-xxxxx
```

### "Invalid API key"

Check that `BUILDD_API_KEY` matches an account in the database:

```sql
SELECT id, name, api_key FROM accounts;
```

### Agent not claiming tasks

1. Check account has workspace access:
   ```sql
   SELECT * FROM account_workspaces WHERE account_id = 'acc-xxx';
   ```

2. Check for pending tasks:
   ```sql
   SELECT * FROM tasks WHERE status = 'pending';
   ```

3. Check concurrent worker limits:
   ```sql
   SELECT max_concurrent_workers,
          (SELECT COUNT(*) FROM workers WHERE account_id = accounts.id AND status IN ('running', 'starting'))
   FROM accounts WHERE id = 'acc-xxx';
   ```
