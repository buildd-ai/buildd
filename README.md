# Buildd

**Task Queue for AI Agents** — Create tasks. Agents work. Code ships.

Create tasks from a dashboard, CLI, or API — or schedule them on a cron. AI agents claim tasks, branch, code, and open PRs automatically. Shared memory means your 10th task avoids the mistakes of your first.

[buildd.dev](https://buildd.dev) · [Docs](https://docs.buildd.dev) · [GitHub](https://github.com/buildd-ai/buildd)

## Quick Start

```bash
# Install the CLI
curl -fsSL https://buildd.dev/install.sh | bash

# Authenticate (opens browser, configures CLI + MCP)
buildd login

# Start the local worker UI
buildd
```

That's it. `buildd login` saves your API key and auto-configures the MCP server in `~/.claude.json`, so Claude Code can use buildd tools immediately.

For headless/SSH environments: `buildd login --device`

## How It Works

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

Buildd separates **coordination** from **execution**. The server manages tasks, auth, and state. Workers run wherever you want — your laptop, a VM, CI — and talk to the server via REST API.

## Features

- **Scheduled Tasks** — Set a cron and agents run automatically: nightly test suites, daily PR reviews, weekly dependency audits. No extra infrastructure needed.
- **Skills** — Reusable instruction templates that standardize agent workflows. Install once, reference in any task. SHA-256 verified.
- **Shared Memory** — Agents record gotchas, patterns, and decisions as they work. Future agents read them automatically.
- **Multi-Agent Coordination** — Run agents on laptops, VMs, or GitHub Actions. One dashboard controls them all.
- **GitHub-Native** — Agents create branches, commit code, and open PRs. Full webhook integration for automatic task creation.
- **Planning Mode** — Agents propose implementation plans for human approval before writing code.
- **Teams** — Invite collaborators, manage roles (owner/admin/member), share workspaces.
- **Real-Time Control** — Monitor progress, send instructions to running agents mid-task, and approve plans live.
- **MCP Integration** — Use Claude Code to claim and work on tasks directly. Auto-configured on login.

## CLI Commands

```bash
buildd                 # Start local worker UI
buildd login           # Authenticate (browser OAuth)
buildd login --device  # Authenticate (headless/SSH)
buildd status          # Show current auth state
buildd logout          # Remove saved API key
buildd init <id>       # Configure MCP for a specific workspace
buildd install --global # Register MCP server globally
```

## Documentation

Full documentation at **[docs.buildd.dev](https://docs.buildd.dev)**

- [Getting Started](https://docs.buildd.dev/docs/getting-started/local-ui) — Local UI setup
- [Skills](https://docs.buildd.dev/docs/features/skills) — Reusable agent instructions
- [Schedules](https://docs.buildd.dev/docs/features/schedules) — Cron-based task automation
- [Memory](https://docs.buildd.dev/docs/features/memory) — Workspace knowledge base
- [Teams](https://docs.buildd.dev/docs/features/teams) — Collaboration and access control
- [Planning Mode](https://docs.buildd.dev/docs/features/planning-mode) — Human-in-the-loop approval
- [GitHub Integration](https://docs.buildd.dev/docs/features/github) — Webhooks and PR management
- [API Reference](https://docs.buildd.dev/docs/concepts/task-access) — Endpoints and auth
- [Self-Hosting](https://docs.buildd.dev/docs/deployment/self-hosting) — Deploy your own instance

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

## Contributing

```bash
bun install            # Install dependencies
cp .env.example .env.local  # Configure environment
bun dev                # Start dev server
```

See the [self-hosting guide](https://docs.buildd.dev/docs/deployment/self-hosting) for full setup including database and environment variables.

## License

MIT
