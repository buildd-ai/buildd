# Buildd Testing Strategy

## Testing Layers

### 1. Unit Tests (`apps/runner/__tests__/unit/*.test.ts`)
**Purpose**: Test individual functions/classes in isolation
**Runtime**: Fast (<1s per suite)
**Dependencies**: None (mocked)

#### Existing Coverage:
- ✅ Loop detection (5 identical calls, 8 similar bash commands)
- ✅ Utils, workspace, permissions

#### Recommended Additions:

**Error Handling (`error-handling.test.ts`)**
```typescript
- Abort scenarios (loop detection, user abort, timeout)
- Network failures (API unreachable, 500 errors, timeouts)
- Invalid server responses (malformed JSON, missing fields)
- Memory save failures (API errors, validation errors)
```

**Worker State Transitions (`worker-state.test.ts`)**
```typescript
- idle → claiming → working → done
- idle → claiming → working → error
- working → stale (no activity) → working (activity resumed)
- waiting_input → working (after user input)
- Edge cases: abort during claim, network failure during sync
```

**Tool Call Tracking (`tool-tracking.test.ts`)**
```typescript
- Tool call history management (200 max, FIFO)
- Git stats extraction (commits, branches, files changed)
- File extraction from tool calls (Read, Edit, Write paths)
- Milestone generation (task started, commits, completion)
```

**Config Validation (`config.test.ts`)**
```typescript
- Valid config parsing (~/.buildd/config.json)
- Missing apiKey handling
- Invalid server URLs
- Workspace filtering (canClaim, canCreate permissions)
```

**Heartbeat Logic (`heartbeat.test.ts`)**
```typescript
- Heartbeat interval timing (every 30s)
- Stale worker detection (>2 min without heartbeat)
- Capacity calculation (maxConcurrent - active)
- Workspace ID updates on config change
```

---

### 2. Integration Tests (`apps/web/tests/integration/*.test.ts`)
**Purpose**: Test components working together (runner + API server)
**Runtime**: Medium (10-30s per test)
**Dependencies**: Live API server, test database

#### Existing Coverage:
- ✅ Task lifecycle (full create → claim → execute → complete flow)
- ✅ Worker state machine (status transitions, waiting_input handling)
- ✅ Concurrency control (capacity limits, race conditions)

#### Recommended Additions:

**API Authentication (`api-auth.test.ts`)**
```typescript
- API key auth (valid key, invalid key, missing key)
- Session auth (valid session, expired session)
- Dual auth routes (workers/active supports both)
- Rate limiting (too many requests)
```

**Worker Lifecycle (`worker-lifecycle.test.ts`)**
```typescript
- Create task → Claim → Execute → Complete
- Create task → Claim → Error (loop detection)
- Create task → Claim → Abort (user initiated)
- Create task → Claim → Timeout (max turns exceeded)
- Multiple workers claiming same task (race condition)
```

**Concurrency Control (`concurrency.test.ts`)**
```typescript
- Account maxConcurrentWorkers limit enforced
- Worker cannot claim if at capacity
- Worker releases capacity on completion/error
- Multiple runner instances share capacity
```

**Status Sync & Pusher Events (`realtime.test.ts`)**
```typescript
- Worker status changes trigger Pusher events
- Dashboard receives updates in real-time
- Task assignment broadcasts to workers
- Worker output/milestone updates propagate
```

**Memory System (`memory.test.ts`)**
```typescript
- Save memories via memory service (discovery, decision, gotcha, etc.)
- Search memories by type, keywords, files
- Memory CRUD operations via proxy routes
- Project scoping (workspace → project mapping)
```

**Error Recovery (`error-recovery.test.ts`)**
```typescript
- Network failure during execution → retry → success
- Server 500 during worker sync → queued → sent on reconnect
- Memory save fails → task still completes
- Worker crashes → task marked as failed → can be reassigned
```

**Git Integration (`git-integration.test.ts`)**
```typescript
- Worker creates commits
- Branch creation/cleanup
- Git stats collection (lines added/removed, files)
- Merge conflict handling
- PR creation (if enabled)
```

---

### 3. E2E Tests (`tests/e2e/*.test.ts`)
**Purpose**: Full user flow tests (browser + API + worker)
**Runtime**: Slow (1-3 min per test)
**Dependencies**: Full stack (browser, server, runner, DB)

#### Existing Coverage:
- ✅ Server + Local-UI full flow (task creation → completion)

#### Recommended Additions:

**Dashboard UI Flows (`dashboard-ui.test.ts`)**
```typescript
- Login → Create workspace → Create task → Monitor worker
- Task detail page shows realtime updates
- Worker list shows active/stale status
- Memory panel displays discoveries
- Filtering/searching tasks and memories
```

**Multi-User Scenarios (`multi-user.test.ts`)**
```typescript
- User A creates task → User B's worker claims it (shared workspace)
- User A saves memory → User B sees it in search
- User A's worker at capacity → User B's worker claims task
```

**Mobile/Responsive (`responsive.test.ts`)**
```typescript
- Dashboard renders correctly on mobile
- Task creation form works on tablet
- Worker monitoring accessible on small screens
```

---

## Test Organization & Naming

### Current State:
- **Unit tests**: `apps/runner/__tests__/unit/*.test.ts` ✅
- **Integration tests**: `apps/web/tests/integration/*.test.ts` ✅
- **E2E tests**: `tests/e2e/*.test.ts` ✅

### Should they merge?
**No** - they serve different purposes:

| Type | Speed | Scope | CI/CD Usage |
|------|-------|-------|-------------|
| Unit | Fast | Single function/class | Every commit |
| Integration | Medium | Multiple services | Every PR |
| E2E | Slow | Full stack + browser | Pre-deploy only |

### Run Commands:
```bash
# Unit tests (runner only)
bun test apps/runner/__tests__/unit/

# Integration tests (requires live server)
bun run test:integration

# E2E tests (requires full stack)
bun run test:e2e

# All tests
bun test
```

---

## Integration vs E2E - What's the Difference?

### Integration Tests (`apps/web/tests/integration/*.test.ts`)
**All in one directory, all run the same way**
- **What**: Test interactions between services (API + worker, API + DB, API + Pusher)
- **How**: HTTP requests to live API, no browser required
- **Examples**:
  - `task-lifecycle.test.ts` - Full task lifecycle (create → claim → execute → complete)
  - `worker-state-machine.test.ts` - Worker status transitions (waiting_input handling)
  - `concurrency.test.ts` - Capacity limits, race conditions
  - `memory.test.ts` - Memory CRUD via proxy routes (TODO)
- **Run**: `bun run test:integration` (all files in the directory)
- **Requirements**: API key, live server

**Note**: "Dogfood" just means we're using buildd to test buildd - it's still an integration test!

### E2E Tests (`tests/e2e/*.test.ts`)
- **What**: Full user journeys including browser UI
- **How**: Browser automation (Playwright/Puppeteer) + API + worker
- **Examples**:
  - `dashboard-ui.test.ts` - Login → create task → monitor worker in browser
  - `server-worker-flow.test.ts` - Full stack with runner startup
- **Run**: `bun run test:e2e`
- **Requirements**: Browser, API key, live server, runner

**Relationship**: Integration tests validate the API/worker layer. E2E tests validate the browser UI layer on top of that.

---

## CI/CD Strategy

```yaml
# .github/workflows/build.yml
unit-tests:
  - Run on every commit
  - Fast feedback (<30s)
  - Block merge if failing

integration-tests:
  - Run on PR creation/update
  - Medium feedback (1-2 min)
  - Block merge if failing
  - Requires test DB and API server

e2e-tests:
  - Run before production deploy
  - Slow feedback (5-10 min)
  - Can deploy with warnings if non-critical failures
  - Requires full stack (browser, server, worker)
```

---

## Test Data & Fixtures

### Seed Scripts:
```bash
bun run seed:waiting-input     # Task with worker in waiting_input state
bun run seed:error-worker      # Worker in error state (loop detected)
bun run seed:completed-tasks   # 10 completed tasks with memories
bun run seed:multi-user        # Tasks across multiple workspaces in various states
bun run seed:concurrent        # Account at maxConcurrent limit with active workers
bun run seed:reset             # Cleans up seeded data (handles all seed types)
```

### Test Fixtures:
```typescript
// apps/runner/__tests__/fixtures/
- valid-config.json
- invalid-config.json
- sample-tasks.json
- sample-workers.json
- sample-memories.json
```

---

## Coverage Goals

| Layer | Coverage Target | Current | Gap |
|-------|----------------|---------|-----|
| Unit | 80% | ~40% | 🔴 High |
| Integration | 70% | ~30% | 🔴 High |
| E2E | 50% (critical paths) | ~20% | 🟡 Medium |

### Priority Areas:
1. 🔴 **Error handling** (abort, network failures, validation)
2. 🔴 **Worker state transitions** (all status changes)
3. 🟡 **Concurrency control** (race conditions, capacity limits)
4. 🟡 **Realtime sync** (Pusher events, dashboard updates)

---

## Next Steps

1. **Add unit tests** for error handling and worker state transitions
2. **Add integration tests** for concurrency and error recovery
3. **Document test patterns** in `.agent/testing-patterns.md`
4. **Set up CI/CD pipeline** to run tests on every PR
5. **Add coverage reporting** with `bun test --coverage`
