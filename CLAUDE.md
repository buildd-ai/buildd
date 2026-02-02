# Buildd - Agent Instructions

## Quick Reference

- **Monorepo**: Turborepo with `apps/` and `packages/`
- **Stack**: Next.js 15 (app router), Drizzle ORM, Postgres (Neon), Pusher
- **Key paths**:
  - Web dashboard: `apps/web/src/app/`
  - API routes: `apps/web/src/app/api/`
  - Local UI (Bun): `apps/local-ui/` - standalone worker runner with web UI
  - MCP server: `apps/mcp-server/` - Claude Code MCP integration
  - DB schema: `packages/core/db/schema.ts`
  - Shared types: `packages/shared/src/types.ts`
  - CLI agent: `apps/agent/`
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
- **PRs**: Target `dev` for features, `main` for hotfixes only
- **CI**: `.github/workflows/build.yml` runs type check + build
- **Vercel**: Only deploys from `main` (dev deploys disabled)

Do NOT commit directly to `main` unless it's an emergency hotfix.

## When Modifying

- **Schema changes** → run `bun db:generate` and commit migration files (see Database section)
- **API changes** → update types in `packages/shared`
- **Worker status changes** → trigger Pusher events (check `lib/pusher.ts`)
- **Account limits** differ by `authType` - see claim route
- Use transactions for multi-step DB operations (currently missing in places)

## Local Docs

See `.agent/` for architecture deep-dives.
i.e .agent/claude-agent-sdk.md