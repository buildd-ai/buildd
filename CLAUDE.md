# Buildd - Agent Instructions

## Quick Reference

- **Monorepo**: Turborepo with `apps/` and `packages/`
- **Stack**: Next.js 16 (app router), Drizzle ORM, Postgres (Neon), Pusher
- **Routing**: `proxy.ts` handles subdomain routing (Next.js 16 feature)
- **Key paths**:
  - Web dashboard: `apps/web/src/app/`
  - API routes: `apps/web/src/app/api/`
  - Runner (Bun): `apps/runner/` - standalone worker runner with web UI
  - MCP server (HTTP): `apps/web/src/app/api/mcp/route.ts`
  - DB schema: `packages/core/db/schema.ts`
  - Shared types: `packages/shared/src/types.ts`
  - Worker runner: `packages/core/worker-runner.ts`

## Architecture

Buildd is a **task coordination system** for AI agents:

1. Tasks created via dashboard or API
2. Workers (external) claim tasks via `POST /api/workers/claim`
3. Workers execute and report via `PATCH /api/workers/[id]`
4. Results displayed in realtime dashboard

**Critical**: API is coordination-only. Workers run externally - Vercel can't handle multi-minute Claude executions.

## Auth Model

Dual auth with different billing strategies:
- **API key** (`bld_xxx`): Pay-per-token, cost-limited
- **OAuth token**: Seat-based, session-limited

Check `authType` field to know which limits apply.

## Database

Postgres via Neon + Drizzle ORM.

**Key tables**: `accounts`, `workspaces`, `tasks`, `workers`, `accountWorkspaces`

### Schema Changes (Important!)

When modifying `packages/core/db/schema.ts`:

1. **Generate migration**: `cd packages/core && bun db:generate`
2. **Commit the migration files** in `packages/core/drizzle/`
3. **Push to dev** - CI verifies migrations are up to date
4. **Migrations auto-run on Vercel deploy**

**Manual migration** (if needed): `cd packages/core && bun db:migrate`

CI will **fail** if you change schema.ts without generating/committing migrations.

**Do NOT use `db:push`** in production - it bypasses migration tracking.

## Git Workflow

- **Default branch**: `dev`
- **Production branch**: `main`
- **Flow**: Push to `dev` → CI runs → auto-merges to `main` → Vercel deploys
- **PRs**: Target `dev` for features, `main` for hotfixes only. Use conventional PR titles (e.g., `feat:`, `fix:`, `ci:`, `refactor:`, `docs:`)
- **Release**: `bun run release` (dev→main), `bun run release:hotfix` (branch→main, patch bump)
- **CI**: `.github/workflows/build.yml` runs type check + build; `.github/workflows/preview-tests.yml` runs API integration tests against Vercel preview deploys
- **Vercel**: Only deploys from `main` (dev deploys disabled)

Do NOT commit directly to `main` unless it's an emergency hotfix.

### Hotfix vs Normal Release

- **Normal** (`bun run release`): Feature/fix goes to `dev` first, then release PR merges dev→main. Use this when there's no urgency.
- **Hotfix** (`bun run release:hotfix`): Run from a feature branch. Creates PR directly to `main` with a patch bump. Use only for urgent production fixes that can't wait for the normal dev→main cycle. After merging, backport to dev: `git checkout dev && git merge origin/main && git push origin dev`.

## When Modifying

- **Schema changes** → run `bun db:generate` and commit migration files (see Database section)
- **API changes** → update types in `packages/shared`
- **Worker status changes** → trigger Pusher events (check `lib/pusher.ts`)
- **Account limits** differ by `authType` - see claim route
- **Do NOT use `db.transaction()`** with interactive logic — neon-http driver doesn't support it. Use atomic `UPDATE...WHERE` with `.returning()` for optimistic locking instead.

## Testing

### Dev Mode Auth
Use `DEV_USER_EMAIL` to test as a real user locally:
```bash
DEV_USER_EMAIL=your@email.com bun dev
```

### Seed Scripts
Create test data without manual setup:
```bash
bun run seed:waiting-input     # Task with worker in waiting_input state
bun run seed:error-worker      # Worker in error state (loop detected)
bun run seed:completed-tasks   # 10 completed tasks with memories
bun run seed:multi-user        # Tasks across multiple workspaces in various states
bun run seed:concurrent        # Account at maxConcurrent limit with active workers
bun run seed:reset             # Cleans up seeded data (handles all seed types)
```

### UI Fixtures
View worker UI states in isolation: `http://localhost:3001/app/dev/fixtures?state=waiting-input`

### data-testid Conventions
Key components have `data-testid` attributes for E2E testing:
- `task-header-status` - Task detail page status badge
- `sidebar-task-item` - Sidebar task links (includes `data-status`)
- `worker-needs-input-banner` - "Needs Input" banner

See `.agent/testing.md` for details.

## Related Repos

| Repo | Purpose | Domain |
|------|---------|--------|
| [buildd-ai/memory](https://github.com/buildd-ai/memory) | Shared memory service (standalone) | `memory.buildd.dev` |
| [buildd-ai/buildd-docs](https://github.com/buildd-ai/buildd-docs) | Product documentation (Fumadocs) | `docs.buildd.dev` |

This repo (`apps/web`) serves the dashboard and API at `app.buildd.dev`.

## Docs

- **Architecture deep-dives**: `.agent/` directory (e.g., `.agent/claude-agent-sdk.md`)
- **Product documentation**: Check the `buildd-docs` sibling repo for user-facing docs on features like skills, schedules, deployment, etc.