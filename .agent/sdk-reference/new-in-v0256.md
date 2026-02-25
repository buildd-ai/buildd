# New in v0.2.50–v0.2.56 (CLI v2.1.50–v2.1.56)

> Part of `.agent/claude-agent-sdk.md` docs. See index file for table of contents.

## 38. `task_progress` Events (SDK v0.2.51)

Real-time background agent progress reporting with cumulative usage metrics, tool counts, and duration.

```typescript
type SDKTaskProgressEvent = {
  type: 'system';
  subtype: 'task_progress';
  task_id: string;
  usage: NonNullableUsage;     // Cumulative token usage
  tool_use_count: number;       // Total tool calls so far
  duration_ms: number;          // Elapsed time
};

// Usage in stream:
for await (const msg of queryInstance) {
  if (msg.type === 'system' && msg.subtype === 'task_progress') {
    updateDashboard(msg.task_id, msg.usage, msg.tool_use_count, msg.duration_ms);
  }
}
```

**Buildd use case**: Surface real-time subagent progress in dashboard — show token consumption, tool activity, and elapsed time for background agents without waiting for completion.

---

## 39. `listSessions()` (SDK v0.2.53)

Discover and list past sessions with light metadata:

```typescript
import { listSessions } from "@anthropic-ai/claude-agent-sdk";

const sessions = await listSessions();
// Returns session metadata: IDs, timestamps, working directories, etc.
```

**Buildd use case**: Enable session browsing in local-ui or dashboard. Could power a "recent sessions" view for workers, or allow resuming abandoned worker sessions.

---

## 40. Account Metadata Environment Variables (CLI v2.1.51)

Three new env vars for SDK callers to provide account info synchronously:

```typescript
options: {
  env: {
    CLAUDE_CODE_ACCOUNT_UUID: accountId,
    CLAUDE_CODE_USER_EMAIL: userEmail,
    CLAUDE_CODE_ORGANIZATION_UUID: orgId,
  }
}
```

Eliminates a race condition where early telemetry events lacked account metadata. Previously, account info was resolved asynchronously and could be missing from initial events.

**Buildd use case**: Pass workspace account info to workers for reliable telemetry correlation from the first event.

---

## v2.1.50–v2.1.56 Performance & Stability Improvements

### Critical Memory Leak Fixes (CLI v2.1.50)

Multiple memory leaks fixed — critical for long-running Buildd workers:

- **Agent teams memory leak**: Completed teammate tasks were never garbage collected from session state
- **Completed task state leak**: Task state objects never removed from AppState
- **LSP diagnostic leak**: Diagnostic data never cleaned up after delivery
- **File history leak**: Unbounded file history snapshots
- **CircularBuffer leak**: Cleared items retained in backing array
- **ChildProcess/AbortController leak**: References retained after shell command cleanup
- **TaskOutput leak**: Recent lines retained after cleanup
- **UUID tracking leak (SDK v0.2.51)**: Message UUID tracking never evicted old entries, causing unbounded memory growth

### Performance Improvements

- **Headless startup perf (v2.1.50)**: Deferred Yoga WASM and UI component imports for `-p` flag — benefits all Buildd workers
- **BashTool no-login-shell (v2.1.51)**: Skips `-l` flag by default when shell snapshot available, improving command execution speed
- **Tool result threshold (v2.1.51)**: Lowered from 100K to 50K chars for disk persistence — reduces context window usage

### Other Notable Changes

- **`WorktreeCreate`/`WorktreeRemove` hook events (v2.1.50)**: Custom VCS setup/teardown when worktree isolation creates/removes worktrees
- **Declarative `isolation: worktree` (v2.1.50)**: Agent definitions support `isolation: worktree` for declarative git worktree isolation (previously only via `Task` tool parameter)
- **`claude agents` CLI command (v2.1.50)**: List all configured agents from the CLI
- **`claude remote-control` (v2.1.51)**: External builds can serve local environment — potential for remote worker patterns
- **Custom npm registries for plugins (v2.1.51)**: Specific version pinning when installing plugins from npm
- **Managed settings via OS policies (v2.1.51)**: macOS plist and Windows Registry support
- **Opus 4.6 fast mode 1M context (v2.1.50)**: Fast mode now includes full 1M context window
- **`CLAUDE_CODE_DISABLE_1M_CONTEXT` (v2.1.50)**: Env var to disable 1M context support

### SDK Bug Fixes (v0.2.51)

- Fixed SDK crashing with `ReferenceError` when used inside compiled Bun binaries (`bun build --compile`)
- Fixed local slash command output not being returned to SDK clients
- Fixed `session.close()` in v2 session API killing subprocess before persisting session data (broke `resumeSession()`)
