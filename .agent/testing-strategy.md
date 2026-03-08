# Buildd Testing Strategy

## Testing Layers

### 1. Unit Tests

**Route handler tests** (`apps/web/src/app/api/**/*.test.ts`) — 37 files
Co-located with route handlers. Mock DB, auth, and external services.

**Runner unit tests** (`apps/runner/__tests__/unit/*.test.ts`) — 24 files
Test individual functions/classes in isolation. Fast (<1s per suite), no dependencies.

**Core package tests** (`packages/core/__tests__/*.test.ts`) — 7 files
DB utilities, MCP tools, secrets, worker-runner logic.

#### Existing Runner Unit Coverage:
- Loop detection, error handling, tool tracking
- Worker manager (lifecycle, messaging, state) — 3 files
- Skills (buildd skills, skill routes, skills engine)
- Agent teams (unit, integration, team tracking hook)
- Utils, workspace, permissions, updater
- Phase detection, history store, outbox
- Eviction race, resume logging, terminate/hydrate

#### Existing Route Test Coverage:
- Tasks: CRUD, cleanup
- Workers: claim, heartbeat, active, instruct
- GitHub: callback, webhook, installations, provision-workflow
- Accounts: CRUD, me endpoint
- Workspaces: CRUD, members
- Skills, schedules, artifacts, and more

---

### 2. Integration Tests (`apps/web/tests/integration/*.test.ts`) — 13 files
**Purpose**: Test components working together (API + worker + DB)
**Runtime**: Medium (10-30s per test)
**Dependencies**: Live API server, test database, API key

#### Existing Coverage:
- `task-lifecycle.test.ts` — Full create → claim → execute → complete flow
- `worker-state-machine.test.ts` — Status transitions, waiting_input handling
- `concurrency.test.ts` — Capacity limits, race conditions
- `api-auth.test.ts` — API key auth, session auth, dual auth
- `artifacts.test.ts` — Artifact CRUD
- `skills.test.ts` — Skills API
- `schedules.test.ts` — Schedule CRUD
- `schedule-triggers.test.ts` — Schedule trigger logic
- `dogfood.test.ts` — Using buildd to test buildd
- `objectives.test.ts` — Objectives API
- `projects.test.ts` — Projects API
- `recipes.test.ts` — Recipes API
- `team-invitations.test.ts` — Team invitation flows

#### Gaps (not yet tested):
- Realtime sync (Pusher events propagation)
- Error recovery (network failures during execution, worker crashes)
- Memory system (CRUD via proxy routes, project scoping)
- Git integration (branch creation, PR creation, stats collection)

---

### 3. E2E Tests (`tests/e2e/*.test.ts`) — 1 file
**Purpose**: Full user flow tests (browser + API + worker)
**Runtime**: Slow (1-3 min per test)
**Dependencies**: Full stack (browser, server, runner, DB)

#### Existing Coverage:
- `server-worker-flow.test.ts` — Full stack with runner startup

#### Gaps (not yet tested):
- Dashboard UI flows (login → create task → monitor)
- Multi-user scenarios (shared workspaces)

---

## Test Organization

| Type | Speed | Scope | CI/CD Usage |
|------|-------|-------|-------------|
| Unit | Fast | Single function/route | Every commit |
| Integration | Medium | Multiple services | Every PR |
| E2E | Slow | Full stack + browser | Pre-deploy only |

### Run Commands:
```bash
# All unit tests (routes + runner + core)
bun test

# Specific route test
bun test apps/web/src/app/api/workers/claim/route.test.ts

# Runner unit tests only
bun test apps/runner/__tests__/unit/

# Integration tests (requires live server + API key)
bun run test:integration

# E2E tests (requires full stack)
bun run test:e2e

# Affected tests only (CI optimization)
bun run test:affected

# Clean up leaked test data
bun run test:cleanup
```

---

## Integration vs E2E

**Integration Tests** — HTTP requests to live API, no browser required. Tests API + worker + DB interactions. Run with `bun run test:integration`.

**E2E Tests** — Browser automation + API + worker. Tests full user journeys. Run with `bun run test:e2e`. E2E helpers auto-start a local-ui subprocess pointed at the test server.

---

## Test Data & Fixtures

### Seed Scripts (`scripts/seed/`):
```bash
bun run seed:waiting-input     # Task with worker in waiting_input state
bun run seed:error-worker      # Worker in error state (loop detected)
bun run seed:completed-tasks   # 10 completed tasks with memories
bun run seed:multi-user        # Tasks across multiple workspaces in various states
bun run seed:concurrent        # Account at maxConcurrent limit with active workers
bun run seed:reset             # Cleans up seeded data (handles all seed types)
```

### UI Fixtures:
Navigate to `http://localhost:3001/app/dev/fixtures?state=<state>` to view worker UI states in isolation (no DB required). States: `waiting-input`, `running`, `completed`, `failed`.

### Test Utilities (`tests/test-utils.ts`):
- `requireTestEnv()` — Validates `BUILDD_TEST_SERVER` env var (no production fallback)
- `createTestApi(server, apiKey)` — JSON helper with automatic retry on 500s
- `createCleanup()` — Tracked cleanup with SIGINT handler

---

## CI/CD Strategy

```yaml
# .github/workflows/build.yml
unit-tests:
  - Run on every commit
  - Fast feedback (<30s)
  - Block merge if failing

# .github/workflows/preview-tests.yml
integration-tests:
  - Run against Vercel preview deploys
  - Medium feedback (1-2 min)
  - Block merge if failing
  - Requires test API key
```

---

## Test Configuration

- **Runner**: Bun test (not Jest/Vitest)
- **Config**: `bunfig.toml` — preloads `tests/setup.ts` (suppresses console output)
- **Env**: `tests/.env.test` (see `tests/.env.test.example`)
- **Imports**: `import { describe, test, expect } from 'bun:test'`
