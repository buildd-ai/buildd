# buildd

Task-driven agent orchestration platform. Assign tasks from your issue tracker, workers execute them in isolated git worktrees, review structured artifacts.

## Quick Start

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
# Edit .env with your credentials

# Generate database migrations
pnpm db:generate

# Run migrations
pnpm db:migrate

# Start development
pnpm dev
```

## Architecture

```
Workspace (project/repo)
    └── Task (from Jira/GitHub/manual)
        └── Worker (Claude agent)
            └── Artifacts (plans, diffs, screenshots)
                └── Comments (feedback)
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
