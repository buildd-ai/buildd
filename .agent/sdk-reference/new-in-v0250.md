# New in v0.2.50 (CLI v2.1.50–2.1.56)

> Part of `.agent/claude-agent-sdk.md` docs. See index file for table of contents.

## 38. WorktreeCreate & WorktreeRemove Hook Events

New hook events fire when git worktrees are created or removed. Enables lifecycle tracking for isolated subagent runs.

```typescript
type WorktreeCreateHookInput = BaseHookInput & {
  hook_event_name: 'WorktreeCreate';
  worktree_path: string;
  branch_name: string;
};

type WorktreeRemoveHookInput = BaseHookInput & {
  hook_event_name: 'WorktreeRemove';
  worktree_path: string;
};
```

**Buildd use case**: Track worktree creation/cleanup for subagent isolation. Log worktree lifecycle events in worker observations. Detect abandoned worktrees from crashed workers.

---

## 39. `claude remote-control` Subcommand

New CLI subcommand enables external builds to serve a local environment to Claude. Allows any user to expose their local dev environment for Claude to interact with.

```bash
claude remote-control
```

**Buildd use case**: Workers could use remote-control to expose a persistent local environment across multiple task executions, avoiding cold-start overhead. Could enable "attached environment" mode where a runner keeps a dev server running between tasks.

---

## 40. Memory Leak Fixes (v2.1.50)

Major batch of memory leak fixes critical for long-running Buildd workers:

- **LSP diagnostics** — No longer accumulates unbounded diagnostic data
- **TaskOutput** — Completed task output properly garbage collected
- **CircularBuffer** — Fixed buffer growth in long sessions
- **File history snapshots** — No longer retains all historical file states
- **Completed task state** — Subagent task state properly cleaned up
- **Shell ChildProcess/AbortController** — References properly released after command completion

**Buildd impact**: Workers running long or complex tasks should see significantly reduced RSS growth. Previous WASM memory fix (v2.1.49) combined with these fixes substantially improves worker stability.

---

## 41. Opus 4.6 Fast Mode with 1M Context

Opus 4.6 in fast mode now includes the full 1M context window. Previously, fast mode had a reduced context window.

**Buildd use case**: Workers using Opus 4.6 in fast mode can now handle the same large-context tasks as standard mode. Update model capability metadata if displaying context limits.

---

## 42. SDK Caller Identity Env Vars

New environment variables available to SDK callers for identifying the authenticated account:

```typescript
// Available in worker process environment:
CLAUDE_CODE_ACCOUNT_UUID    // Account UUID of the authenticated user
CLAUDE_CODE_USER_EMAIL      // Email of the authenticated user
CLAUDE_CODE_ORGANIZATION_UUID  // Organization UUID (if applicable)
```

**Buildd use case**: Workers can read these env vars to correlate SDK sessions with Buildd accounts without needing separate auth. Useful for audit logging and multi-tenant worker pools.

---

## 43. Custom Plugin Registries & Version Pinning

Plugins now support custom npm registries and specific version pinning:

- Custom npm registry URLs for private/enterprise plugins
- Specific version pinning (e.g., `plugin@1.2.3`) instead of always latest
- Default git timeout increased from 30s to 120s for plugin marketplace
- `CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS` env var for custom timeout

**Buildd use case**: Enterprise customers can host approved plugins in private registries. Version pinning ensures reproducible worker environments across deployments.

---

## 44. Tool Result Persistence Threshold Lowered

Tool results larger than 50K characters are now persisted to disk (was 100K threshold). BashTool also skips login shell (`-l` flag) by default when shell snapshot is available.

**Buildd impact**: More aggressive disk persistence means less memory pressure for workers generating large outputs. Login shell skip reduces per-command overhead.

---

## 45. `CLAUDE_CODE_DISABLE_1M_CONTEXT` Env Var

New env var to explicitly disable 1M context window usage:

```typescript
options: {
  env: {
    CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
  }
}
```

**Buildd use case**: Add as workspace config option for users who want to reduce costs or avoid beta features. Especially useful for budget-constrained API key users.

---

## v2.1.50–56 Stability Improvements

### v2.1.50
- **Headless mode startup perf** — Improved performance for `-p` flag (benefits all Buildd workers)
- **`CLAUDE_CODE_SIMPLE` mode** — Now also disables MCP tools, attachments, hooks, and CLAUDE.md loading
- **Session data loss fix** — Sessions no longer lost on SSH disconnect
- **Symlinked directory fix** — Resumed sessions now visible with symlinked working directories
- **Linux glibc fix** — Native modules now load on glibc < 2.30 (e.g., RHEL 8)

### v2.1.51
- **Security: statusLine/fileSuggestion hooks** — Fixed potential injection vectors
- **Security: HTTP hook env var interpolation** — Env vars in HTTP hook URLs now properly sanitized
- **HTTP hooks sandboxed** — HTTP hooks routed through sandbox network proxy when sandboxing is enabled
- **Duplicate `control_response` fix** — Fixed duplicate messages causing API 400 errors
- **Slash command autocomplete fix** — No longer crashes with non-string SKILL.md descriptions
- **`claude agents` CLI command** — Lists all configured agents (useful for debugging)

### v2.1.52–56
- Bug fixes for Windows compatibility (BashTool EINVAL, WASM crashes, panic on corrupted values)
- VS Code extension stability fixes
- UI flicker fix for user input submission
- Bulk agent kill (ctrl+f) now sends single aggregate notification
- Graceful shutdown fix for Remote Control stale sessions
- `--worktree` flag fix for first launch
