# New in v0.2.50–v0.2.52 (CLI v2.1.50–v2.1.52)

> Part of `.agent/claude-agent-sdk.md` docs. See index file for table of contents.

## 38. WorktreeCreate/WorktreeRemove Hook Events (v0.2.50)

Two new hook events for custom VCS setup/teardown when agent worktree isolation creates or removes worktrees:

```typescript
type HookEvent =
  // ... existing 13 events ...
  | 'WorktreeCreate'   // Fires when a worktree is created for agent isolation
  | 'WorktreeRemove';  // Fires when a worktree is removed after agent completes
```

Enables custom initialization (install deps, seed data) when subagents get isolated worktrees, and cleanup when they finish.

**Buildd use case**: Run workspace-specific setup (e.g., `bun install`, env file copy) when skills-as-subagents get worktree isolation. Clean up temp files on removal.

---

## 39. Declarative Worktree Isolation in Agent Definitions (v0.2.50)

`isolation: "worktree"` is now supported directly in agent YAML definitions (not just SDK options):

```yaml
---
name: deploy
description: Handles deployment
tools: [Read, Bash, Edit, Write]
isolation: worktree
background: true
---
```

This complements feature 34 (SDK-level worktree isolation) by allowing agents defined in `.claude/agents/` to declare isolation declaratively.

---

## 40. Memory Leak Fixes for Long Sessions (v0.2.50)

Multiple critical memory leak fixes targeting long-running sessions:

- **Agent teams**: Completed teammate tasks now garbage collected from session state
- **LSP diagnostics**: Diagnostic data cleaned up after delivery (was unbounded)
- **File history snapshots**: Capped to prevent unbounded growth
- **CircularBuffer**: Cleared items no longer retained in backing array
- **Shell commands**: ChildProcess and AbortController references freed after cleanup
- **TaskOutput**: Recent lines freed after cleanup
- **Completed task state**: Objects removed from AppState after completion
- **Internal caches**: Cleared after compaction
- **Large tool results**: Cleared after processing

**Impact**: Critical for Buildd workers running multi-hour sessions with many tool executions and subagent tasks.

---

## 41. `CLAUDE_CODE_DISABLE_1M_CONTEXT` Environment Variable (v0.2.50)

```typescript
options: {
  env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' }
}
```

Disables 1M context window support. Useful when running on providers that don't support extended context, or to reduce costs for tasks that don't need large context.

---

## 42. Opus 4.6 Fast Mode 1M Context (v0.2.50)

Opus 4.6 in fast mode now includes the full 1M context window (previously limited). This means workers using fast mode with Opus get the same context capacity as standard mode.

---

## 43. `claude agents` CLI Command (v0.2.50)

```bash
claude agents  # Lists all configured agents (from .claude/agents/ and SDK)
```

Useful for debugging and verifying agent configurations in worker environments.

---

## 44. Headless Mode Startup Performance (v0.2.50)

Improved startup performance for headless mode (`-p` flag) by deferring Yoga WASM and UI component imports. Benefits all Buildd workers which run in headless mode.

---

## 45. Session Data Loss Fix on SSH Disconnect (v0.2.50)

Fixed session data loss on SSH disconnect by flushing session data before hooks and analytics in the graceful shutdown sequence. Also fixed resumed sessions being invisible when the working directory involved symlinks.

**Impact**: Prevents data loss for remote Buildd workers running over SSH connections.

---

## 46. `claude remote-control` Subcommand (v0.2.51)

New subcommand enabling local environment serving for external builds:

```bash
claude remote-control  # Serve local environment for all users
```

Enables a pattern where Claude Code runs locally but is controlled externally. Could complement Buildd's worker model by allowing remote orchestration of local environments.

---

## 47. Account Identity Environment Variables (v0.2.51)

Three new environment variables for SDK callers to provide account info synchronously:

```typescript
options: {
  env: {
    CLAUDE_CODE_ACCOUNT_UUID: accountId,
    CLAUDE_CODE_USER_EMAIL: userEmail,
    CLAUDE_CODE_ORGANIZATION_UUID: orgId,
  }
}
```

Eliminates a race condition where early telemetry events lacked account metadata. SDK callers should pass these when account info is available.

**Buildd use case**: Pass workspace account details to worker sessions for proper telemetry attribution.

---

## 48. Tool Result Disk Persistence Threshold (v0.2.51)

Tool results larger than 50K characters are now persisted to disk (previously 100K). Reduces context window usage and improves conversation longevity for workers executing tools with large output.

---

## 49. HTTP Hook Sandbox Enforcement (v0.2.51)

HTTP hooks are now routed through the sandbox network proxy when sandboxing is enabled, enforcing the domain allowlist. HTTP hooks are not supported for SessionStart/Setup events.

**Security**: Prevents hooks from making unauthorized network requests in sandboxed environments.

---

## 50. Security Fixes (v0.2.51)

- **Hook trust check**: `statusLine` and `fileSuggestion` hook commands now require workspace trust acceptance in interactive mode
- **HTTP hook env vars**: Environment variable interpolation in HTTP hook headers now requires an explicit `allowedEnvVars` list in the hook configuration (prevents arbitrary env var leakage)
- **Duplicate control_response**: Fixed duplicate messages from WebSocket reconnects causing API 400 errors

---

## 51. BashTool Login Shell Optimization (v0.2.51)

BashTool now skips the login shell (`-l` flag) by default when a shell snapshot is available, improving command execution performance. Previously required setting `CLAUDE_CODE_BASH_NO_LOGIN=true`.

---

## 52. Plugin Marketplace Improvements (v0.2.51)

- Default git timeout increased from 30s to 120s; configurable via `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS`
- Support for custom npm registries and specific version pinning when installing plugins

---

## v2.1.52 (Feb 24, 2026)

- VS Code Windows crash fix only (`command 'claude-vscode.editor.openLast' not found`). No SDK-relevant changes.
