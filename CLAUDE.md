# Buildd - Agent Instructions

## Quick Reference

- **Monorepo**: Turborepo with `apps/` and `packages/`
- **Stack**: Next.js 16 (app router), Drizzle ORM, Postgres (Neon), Pusher
- **Routing**: `proxy.ts` is the Next.js 16 middleware (replaces `middleware.ts`). Handles install script redirects and subdomain routing. File extensions like `.sh` require proxy-level handling — `next.config` redirects skip them.
- **Key paths**:
  - Web dashboard: `apps/web/src/app/`
  - API routes: `apps/web/src/app/api/`
  - Runner (Bun): `apps/runner/` - standalone worker runner with web UI
  - MCP server (HTTP): `apps/web/src/app/api/mcp/route.ts`
  - DB schema: `packages/core/db/schema.ts`
  - Shared types: `packages/shared/src/types.ts`
  - Worker runner: `packages/core/worker-runner.ts`
- **Codebase graph**: `codebase-memory` MCP is indexed for this repo — load via `ToolSearch` for structural questions (who calls/depends on X, architecture orientation) over grep.

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

**Key tables**: `accounts`, `workspaces`, `tasks`, `workers`, `missions`, `taskSchedules`, `accountWorkspaces`

### Schema Changes (Important!)

When modifying `packages/core/db/schema.ts`:

1. **Generate migration**: `cd packages/core && bun db:generate`
2. **Commit the migration files** in `packages/core/drizzle/`
3. **Push to dev** - CI verifies migrations are up to date
4. **Migrations auto-run on Vercel deploy**

**Manual migration** (if needed): `cd packages/core && bun db:migrate`

CI will **fail** if you change schema.ts without generating/committing migrations.

**Do NOT use `db:push`** in production - it bypasses migration tracking.

## This Repo Is Public

No production data anywhere in it — code, comments, commit messages, PR bodies,
test fixtures, user-facing docs. No row or tenancy counts, no UUIDs, no personal
handles, no private repo names. State evidence qualitatively; exact figures go in
`knowledge-base` (private). Migrations join against real tables — a hardcoded list
of observed values *is* the disclosure. Docs describe the reader's data, not ours.

Enforced by `.github/workflows/no-prod-data.yml`. If something slips through after
merge, fix the PR body and commit a correction — do **not** force-push a shared
branch; GitHub keeps orphaned commits reachable by SHA, so it hides nothing.

The handle/private-repo half of that check reads the repo **secret**
`NO_PROD_DATA_IDENTIFIERS` (an ERE alternation). It must be a secret, not a
variable: Actions echoes variable values into the step's env group and logs here
are world-readable. With the secret absent the check fails rather than passing on
an empty pattern.

## Git Workflow

- **Default branch**: `dev`
- **Production branch**: `main`
- **Flow**: Push to `dev` → CI runs. `dev` does **not** auto-merge to `main` — ship via a release PR.
- **PRs**: Target `dev` for features, `main` for hotfixes only. Use conventional PR titles (e.g., `feat:`, `fix:`, `ci:`, `refactor:`, `docs:`)
- **Release**: `bun run release` (or `release.yml` / `trigger_release` MCP) opens a `Release vX.Y.Z` PR (dev→main); merge tags + deploys. `release:hotfix` = branch→main, patch bump.
- **CI**: `.github/workflows/build.yml` is the only workflow that runs tests (push to `dev`; PRs to `main`/`dev`). Jobs: `build` (lints + type check + unit tests + build), `sandbox-isolation`, `schema-drift`, and `changes` → `integration`.
- **Integration/E2E only run on PRs targeting `main`**, and are skipped when the head branch is `dev` — so they never gate a `dev` PR or a release PR. There is no `preview-tests.yml`.
- **Vercel**: Only deploys from `main` (dev deploys disabled)

Do NOT commit directly to `main` unless it's an emergency hotfix.

### Hotfix vs Normal Release

- **Normal** (`bun run release`): Feature/fix goes to `dev` first, then release PR merges dev→main. Use this when there's no urgency.
- **Hotfix** (`bun run release:hotfix`): Run from a feature branch. Creates PR directly to `main` with a patch bump. Use only for urgent production fixes that can't wait for the normal dev→main cycle. After merging, backport to dev: `git checkout dev && git merge origin/main && git push origin dev`.

## Missions

Missions are high-level goals that organize and generate tasks. Tasks are concrete units of work; missions are containers that track progress across multiple tasks and optionally create them on a schedule.

- **DB table**: `missions` (with `tasks.missionId` FK)
- **API**: `/api/missions` (CRUD + `/[id]/run` for manual trigger)
- **Context builder**: `apps/web/src/lib/mission-context.ts` — injects workspace roles + active workers into planning prompts
- **Status**: Derived from task health via `deriveMissionHealth` in `packages/core/mission-helpers.ts` — NOT stored as a type

## Roles & Teams

Roles are skills with `isRole: true` on the `workspaceSkills` table. They define agent personas with model preferences, tool access, and delegation rules.

- **Key fields**: `model`, `allowedTools`, `canDelegateTo`, `color`, `background`, `maxTurns`, `mcpServers`, `requiredEnvVars`
- **Default roles**: **Organizer**, **Builder**, and **Researcher** — seeded on workspace creation (`apps/web/src/lib/default-roles.ts`)
- **Task routing**: `tasks.roleSlug` → claim route filters by runner's `availableSkills`
- **Config packaging**: `apps/web/src/lib/role-config.ts` bundles CLAUDE.md + .mcp.json + env mapping → R2
- **API**: `GET /api/roles`, skill CRUD at `/api/workspaces/[id]/skills`
- **Team page**: `apps/web/src/app/app/(protected)/team/page.tsx`

## Issues & Friction

When you encounter pain points, blockers, or broken tooling while working a task, report them — don't silently work around them.

**What to report:** API actions that return unexpected errors (404, 401, 409), MCP tool limitations that forced a detour, missing actions that would have made the task easier, confusing behaviour that cost time.

**How to report:** Create a task in the same workspace with title `[friction] <short description>` and description explaining what broke, what you expected, and what you actually had to do instead. Use `create_task` (MCP or API). Low priority is fine; this is background signal, not a blocker.

If the friction arose from a traced error (one that appears in `get_error_traces`), call `get_error_traces` first to get the pattern slug, then include it in the `create_task` call:
```
context: { frictionSignature: '<slug>', frictionExcerpt: '<first line of excerpt>' }
```
If the friction is a **worker failure** (your worker or a prior one died), call `get_failure_analytics` with `error: '<your error text>'` first. It answers whether the failure is already a known pattern (with count and first/last seen) and returns a ready-to-use `frictionSignature` for the same `context` bag above — so a recurring platform failure appends to one report instead of filing the 30th duplicate. Call it with no `error` for a window overview (`window: 24h|7d|30d`).
The server deduplicates friction tasks by `(frictionSignature, workspace)` — if an open task already carries the same signature, your report is appended to it and no new task is created. You receive the existing task ID back so your completion flow stays coherent.

**Why:** These reports feed directly into platform improvements (like the `get_task` / `send_agent_message` actions added after observing the create→observe→confirm loop was broken). Friction that goes unreported stays broken.

## Credentials (agent backends)

**All agent-backend credentials (Claude API key / OAuth token, Codex auth.json, future backends) live in the single `secrets` table** with team/account/workspace scoping. A team-wide row (`accountId`/`workspaceId` NULL) is shared by all workspaces — one secret covers everything.

**Do NOT create a per-integration credential table** (e.g. `codex_credentials`, `anthropic_credentials`). Add a new `purpose` to `secrets` instead. Multi-field credentials are stored as an encrypted JSON blob in `encryptedValue`; expiring/refreshing tokens use the `tokenExpiresAt` / `lastRefreshedAt` columns and the optimistic-lock refresh pattern.

See `docs/credentials-architecture.md` for the full spec, scoping precedence, and the new-backend checklist.

## When Modifying

- **Schema changes** → run `bun db:generate` and commit migration files (see Database section)
- **API changes** → update types in `packages/shared`
- **Worker status changes** → trigger Pusher events (check `lib/pusher.ts`)
- **Account limits** differ by `authType` - see claim route
- **Do NOT use `db.transaction()`** with interactive logic — neon-http driver doesn't support it. Use atomic `UPDATE...WHERE` with `.returning()` for optimistic locking instead.

## Testing

### Test-Driven Development (TDD)

**Tests first, code second.** Bug fixes need a failing regression test before the fix. Features need tests for happy path + key edge cases. Docs/config-only changes are exempt.

**Where to put tests:**
- **Route handler tests**: Co-located as `route.test.ts` next to `route.ts` (e.g., `apps/web/src/app/api/workers/[id]/instruct/route.test.ts`)
- **Unit tests**: `apps/runner/__tests__/unit/*.test.ts`
- **Core package tests**: `packages/core/__tests__/*.test.ts`
- **Integration tests**: `apps/web/tests/integration/*.test.ts` (require live server + API key)
- **E2E tests**: `tests/e2e/*.test.ts` (require full stack)

**Running tests:**
```bash
bun run test                                # All unit tests (routes + runner + core)
bun run scripts/run-unit-tests.ts <file>    # Specific file(s)
bun run test:integration                    # Integration tests (live server)
bun run test:e2e                            # E2E tests (full stack)
```

**`bun run test`, not `bun test`.** `bun test` is Bun's own runner and ignores
the package script entirely — it loads every matched file into ONE process,
which is exactly what the suite is built to avoid: `mock.module` replaces a
module globally for the process and is never undone, so one file's stub deletes
another file's imports and the failures you get depend on load order. (Until
recently `bun test` was also actively misleading: an e2e file called
`process.exit(0)` at module scope when `BUILDD_TEST_SERVER` was unset, so the
whole run aborted and reported success having run almost nothing.)

`bun run test` runs `scripts/run-unit-tests.ts`, which spawns **one process per
test file**. See `docs/testing.md` → "Running Unit Tests — Always Isolated".

A file is only collected if it matches `UNIT_TEST_ROOTS` in that script and ends
in `.test.ts(x)`. `scripts/collector-coverage.test.ts` fails if any tracked test
file is neither collected nor listed there as a deliberate exclusion — add new
test directories to the roots, not to the exclusion list, unless something else
genuinely runs them.

**On failure:** `bun run test` ends with a digest of every failing file and test name, and writes full per-file output to `.test-report.log` (gitignored). Grep that log instead of re-running the suite:
```bash
grep -A30 -F 'apps/web/src/lib/foo.test.ts' .test-report.log
```

**Smoke tests** (`*-smoke.test.ts`): Lightweight guards that always run in CI. Cover CRUD + auth + endpoint existence for a feature. Full suites (e.g., `missions.test.ts`) run on-demand or when affected code changes.

See `docs/testing.md` and `docs/testing-strategy.md` for full details.

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

### Worker Sandbox: No Prod DB, Browser Needs `install-deps`
Worker sandboxes never get a production `DATABASE_URL` — that's a deliberate security
boundary (no DB-credential purpose in the `secrets` table), not a bug; use seed scripts above
for real-shaped data instead. A headless browser works via `npx playwright install-deps
chromium` — just never type the literal word `sudo` in a Bash command, it's blocked outright
by the harness safety policy even though the underlying escalation works. See
`docs/testing.md` → "Worker Sandbox Constraints".

### UI Fixtures
View worker UI states in isolation: `http://localhost:3001/app/dev/fixtures?state=waiting-input`

### data-testid Conventions
Key components have `data-testid` attributes for E2E testing:
- `task-header-status` - Task detail page status badge
- `sidebar-task-item` - Sidebar task links (includes `data-status`)
- `worker-needs-input-banner` - "Needs Input" banner

See `docs/testing.md` for details.

## Related Repos

| Repo | Purpose | Domain |
|------|---------|--------|
| [buildd-ai/buildd-docs](https://github.com/buildd-ai/buildd-docs) | Product documentation (Fumadocs) | `docs.buildd.dev` |

This repo (`apps/web`) serves the dashboard and API at `buildd.dev`.

## Preview URLs

- **Production**: `https://buildd.dev`
- **Dev (stable)**: `https://buildd-git-dev-maxs-projects-45386f31.vercel.app`
- **PR previews**: `https://buildd-git-<branch-slug>-maxs-projects-45386f31.vercel.app`

## CI Workflows — Intentionally NOT Agent Roles

Some workflows exist as GitHub Actions only and must NOT be registered as routable agent roles:

- **Visual QA** (`.github/workflows/visual-qa.yml`): Playwright screenshot capture + Claude judgment on release PRs. CI-only by design (PR #1029). Any `visual-qa` row in `workspace_skills` is stray — migration `0064_remove_visual_qa_role.sql` removes it.

## Skills

Every **git-tracked** skill under `.claude/skills/` is listed here, and nothing
that is not tracked is listed — `scripts/skills-listed.test.ts` enforces both
directions against `git ls-files`, not the filesystem, so a skill you keep
locally does not fail the suite for everyone else.

**`.claude/` is gitignored** (`.gitignore:14`). Two consequences:

- A new skill needs `git add -f .claude/skills/<slug>/SKILL.md`. A plain
  `git add -A` skips it silently and you get a commit that lists a skill it does
  not ship.
- A checkout can hold extra skills that are not in the repo. They work, they are
  simply not shared — so they do not belong in this list. Register one on the
  platform (`buildd` action=register_skill) if other workers should get it.

- **Agent workflow**: `.claude/skills/buildd-workflow/` — Task lifecycle guide (claim → work → ship). Use `/buildd-workflow` when starting a task.
- **Schema change**: `.claude/skills/schema-change/` — Ship a Drizzle migration without losing a column or a release. Migration index collisions happen several times a day with concurrent sessions and git does **not** conflict on the `.sql` files; read this before pushing anything that touches `packages/core/drizzle/`.
- **Spec sync**: `.claude/skills/spec-sync/` — Keep `docs/SPEC.md` the source of truth and reconcile the doc/site repos against it.
- **UI designer**: `.claude/skills/ui_designer/` — Brand moodboard and design tokens
- **Buildd MCP consumer**: `.claude/skills/buildd-mcp-consumer/` — The consumer-facing counterpart to `buildd-workflow`, for any workspace's workers (not buildd's own contributor loop): task lifecycle, blocked-vs-question, friction dedupe, artifact/knowledge discipline, and the `direct`/`mission-branch` PR-base distinction. This is what the MCP server's trimmed `instructions` block and the `buildd://workspace/skills` resource both point to — see `apps/web/src/app/api/mcp/route.ts`.

## Specs & Docs Layout

Keep the `docs/` namespace clean — each folder means exactly one thing:

- **`docs/SPEC.md`** — canonical product/architecture spec (single source of truth). Code is truth → SPEC.md is its written form → doc/site repos are outputs.
- **`docs/specs/*.md`** — living per-capability **contracts**, format defined by `docs/specs/SPEC-FORMAT.md`. Every file carries lifecycle frontmatter (`title / status / owner / last_verified`). Retire by setting `status: superseded` + `superseded_by`, not by deleting.
- **`docs/design/*.md`** — design proposals (pre-implementation), format defined by `docs/design/DESIGN-FORMAT.md`.
- **`docs/plans/*.md`** — ephemeral rollout plans; move to `docs/plans/archive/` once shipped.
- **`docs/reports/*.md`** — generated audit/drift outputs; rebuildable, may be stale. Never a source of truth.

**After touching any `docs/specs/` file**, run `bun run specs:check` — it validates frontmatter + code-surface paths, guards against duplicate active specs, and regenerates `docs/specs/INDEX.md`. CI (`specs:lint`) and a pre-commit hook (`.githooks/pre-commit`, auto-registered on `bun install`) enforce this; a stale INDEX or missing frontmatter fails the build.

## Docs

- **Testing guides**: `docs/testing.md` and `docs/testing-strategy.md`
- **Internal knowledge base** (architecture, SDK research, plans): `buildd-ai/knowledge-base` repo (private)
- **Product documentation**: Check the `buildd-docs` sibling repo for user-facing docs on features like skills, schedules, deployment, etc.