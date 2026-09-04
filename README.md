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

That's it. `buildd login` saves your API key and auto-configures the remote MCP server in `~/.claude.json`, so Claude Code can use buildd tools immediately.

For headless/SSH environments: `buildd login --device`

## How It Works

```
        ┌──────────────────────────────────────────────┐
        │       buildd server (Next.js on Vercel)      │
        │   dashboard · auth · task + mission state    │
        │            REST API · MCP server             │
        └──────────────────────────────────────────────┘
                             ▲
                             │ claim / report over REST
             ┌───────────────┼───────────────┐
             │               │               │
    ┌────────┴───────┐ ┌─────┴──────┐ ┌──────┴───────┐
    │  Claude Code   │ │ buildd CLI │ │    GitHub    │
    │    + MCP       │ │   runner   │ │   Actions    │
    │  your laptop   │ │  laptop/VM │ │  CI runner   │
    └────────────────┘ └────────────┘ └──────────────┘
```

Buildd separates **coordination** from **execution**. The server owns tasks, auth,
and state; it never runs an agent. Workers run wherever you want — your laptop, a
VM, CI — claim work over the REST API, and report back.

That split is deliberate: agent runs take minutes to hours, which no serverless
request budget survives. It also means buildd works *with* whatever agent you
already use rather than replacing it.

## Features

- **Missions** — Group related work under a goal. Missions track progress across many
  tasks, generate them on a schedule, and hold a cost budget that pauses spawning
  when spent.
- **Roles** — Agent personas with their own model, tool allowlist, MCP servers, and
  delegation rules. Ships with organizer, builder, researcher, writer, analyst, and
  reviewer; tasks route to a role and only a worker offering that role can claim them.
- **Scheduled Tasks** — Set a cron and agents run automatically: nightly test suites,
  daily PR reviews, weekly dependency audits. RSS and HTTP triggers too.
- **Knowledge & Memory** — Agents record gotchas, patterns, and decisions as they work.
  Retrieval injects the relevant ones into future prompts automatically, over an entity
  graph built from your PRs and code rather than a flat note list.
- **Multiple Backends** — Claude and Codex, with model tiers and automatic failover when
  a provider is rate-limited, out of budget, or its credentials go bad.
- **MCP Connectors** — Mount MCP servers per role, with credentials resolved at claim
  time and never stored by the worker. Least-privilege by default: no role opts in, no
  server mounts.
- **Planning Mode** — Agents propose implementation plans for human approval before
  writing code.
- **GitHub-Native** — Agents create branches, commit, and open PRs. Webhooks reconcile
  PR state and can create tasks automatically.
- **Sandboxed Execution** — Workers run under a filesystem sandbox with an explicit
  mount allowlist, so an agent cannot read outside the workspace it was given.
- **Teams** — Invite collaborators, manage access (owner/admin/member), share workspaces
  and connectors across teams.
- **Real-Time Control** — Monitor progress, send instructions to running agents mid-task,
  and approve plans live.
- **MCP Integration** — Use Claude Code to create, claim, and work tasks directly.
  Auto-configured on login.

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

- [Getting Started](https://docs.buildd.dev/docs/getting-started/runner) — Run your first worker
- [Missions](https://docs.buildd.dev/docs/features/missions) — Goals that organize and generate tasks
- [Skills](https://docs.buildd.dev/docs/features/skills) — Reusable agent instructions
- [Schedules](https://docs.buildd.dev/docs/features/schedules) — Cron and trigger-based automation
- [Memory](https://docs.buildd.dev/docs/features/memory) — Workspace knowledge base
- [Codex Backend](https://docs.buildd.dev/docs/getting-started/codex-backend) — Running on Codex instead of Claude
- [MCP Server](https://docs.buildd.dev/docs/integrations/mcp-server) — Drive buildd from Claude Code
- [Teams](https://docs.buildd.dev/docs/features/teams) — Collaboration and access control
- [Planning Mode](https://docs.buildd.dev/docs/features/planning-mode) — Human-in-the-loop approval
- [GitHub Integration](https://docs.buildd.dev/docs/features/github) — Webhooks and PR management
- [Task Access](https://docs.buildd.dev/docs/concepts/task-access) — Auth model and scoping
- [Self-Hosting](https://docs.buildd.dev/docs/deployment/self-hosting) — Deploy your own instance

## Project Structure

```
apps/
├── web/              Next.js dashboard + REST API + MCP server (Vercel)
└── runner/           Standalone worker runner, CLI and local web UI (Bun)

packages/
├── core/             Schema + migrations (Drizzle), knowledge store, model routing
├── shared/           Shared TypeScript types
└── openclaw-skill/   Packaged agent skill
```

## Contributing

```bash
bun install            # Install dependencies
cp .env.example .env.local  # Configure environment
bun dev                # Start dev server
```

See the [self-hosting guide](https://docs.buildd.dev/docs/deployment/self-hosting) for full setup including database and environment variables.

## License

[Apache License 2.0](LICENSE) — Copyright 2026 Max Jacubowsky.
