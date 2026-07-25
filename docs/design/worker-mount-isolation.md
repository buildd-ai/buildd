# bwrap Bind-Allowlist Worker Isolation

**Status:** Proposed
**Related:**
- `apps/runner/src/workers.ts` — `startSession()`, `isBwrapSupported()`, `sandboxConfig`, `cleanEnv`
- `apps/runner/src/env-scan.ts:54` — `checkBwrapSupport()` probe
- `apps/runner/src/error-trace-scanner.ts` — `bwrap_namespace_denied` pattern, `scanToolResult()`
- `apps/runner/src/read-jail.ts` — `buildReadJailDeniedPrefixes()` (application-layer complement)
- `apps/runner/src/claude-auth.ts` — per-worker `CLAUDE_CONFIG_DIR` materialization
- `apps/runner/src/isolation-paths.ts` — `isolatedClaudeConfigDirPath()`, `stableCodexHomeIsolatedPath()`
- `apps/runner/__tests__/unit/bwrap-runtime-recovery.test.ts`

---

## Problem

The runner passes a `sandbox` config to the Claude Code SDK, which uses bwrap internally for Bash subprocess isolation. That sandbox is built without knowledge of buildd-specific paths: per-worker worktrees, shared `.git` object stores, package caches, and agent credentials. The result is one of:

- Agents fail Bash commands with ENOENT/EACCES on paths that are structurally required (e.g. `bun install` can't reach `~/.bun/install/cache`, `git log` can't reach `.git/objects`).
- Operators disable the sandbox entirely (`BUILDD_DISABLE_SANDBOX=1`) to avoid the failures, giving up all isolation benefits.

Neither outcome is acceptable. The sandbox must know the exact bind table a buildd worker session needs.

---

## Current State

`isBwrapSupported()` (`workers.ts:71`) probes bwrap once per process and forces `sandbox: { enabled: false }` when user namespaces are unavailable. When bwrap is present, `sandboxConfig` is taken from `gitConfig.sandbox` if enabled — an opaque passthrough to the SDK. The runner never constructs a mount table: it delegates entirely to the SDK's built-in defaults.

`buildReadJailDeniedPrefixes()` (`read-jail.ts:24`) enforces a soft application-layer read block on sibling worktrees, `~/.buildd`, and per-worker credential dirs via a PreToolUse hook, but this only covers Read/Glob/Grep tool calls, not Bash.

---

## Proposal

**Crux:** compose a per-task bwrap mount table in `startSession()` and pass it to the SDK's `sandbox.extraMounts` (or equivalent) so the sandbox view is exactly the set of paths the worker legitimately needs — no more, no less.

If the SDK does not expose `extraMounts`, the runner wraps the `claude` subprocess itself with an outer bwrap invocation using the same table. Either way the mount table is built once, per-task, in the same code path that assembles `cleanEnv`.

### 1. Bind Table

All paths are resolved at task spawn time with absolute paths.

| Path | Mode | Why |
|------|------|-----|
| Worker worktree (`sessionCwd`) | **rw** | Agent edits, compiles, runs tests here |
| Parent clone `.git/` (`repoPath + '/.git'`) | **ro** | git log/diff/show need object store; objects are immutable, writes go to the worktree ref |
| `/usr`, `/bin`, `/lib`, `/lib64`, `/usr/local` | ro | System toolchain (cc, sh, env, etc.) |
| `$BUN_INSTALL` (default `~/.bun`) | ro | Bun CLI; cache subdir promoted to rw below |
| Bun package cache (`~/.bun/install/cache`) | **rw** | `bun install` populates here; shared across workers for speed |
| npm package cache (`~/.npm`) | **rw** | `npm install` fallback; workers may mix npm and bun |
| `/proc`, `/dev`, `/dev/shm`, `/sys` | proc/dev/tmpfs | Required by kernel ABI and shared-memory allocation |
| `/tmp` (tmpfs) | **rw** (tmpfs) | Compiler intermediaries, socket files; tmpfs = no cross-worker leakage |
| `/etc/ssl`, `/etc/resolv.conf`, `/etc/nsswitch.conf` | ro | TLS roots and DNS resolution |
| Active credential dir (one of the two below) | see below | Auth to Anthropic / OpenAI |
| → `claudeConfigDir` (when `worker.claudeAccessToken` is set) | **rw** | Per-worker `CLAUDE_CONFIG_DIR`; SDK may rewrite the token on refresh |
| → `~/.claude/.credentials.json`, `~/.claude/settings.json` | **ro** | Local-credential fallback; no refresh_token path in sandbox |
| Codex home (`cleanEnv.CODEX_HOME`) | **rw** | Per-worker `CODEX_HOME` holds `auth.json` + `sessions/` (Codex backend only) |
| `.mcp.json` in worktree | — | Already covered by the worktree rw bind; no extra mount needed |
| `BUILDD_MOUNT_ALLOWLIST_EXTRA` entries | caller-specified | Operator escape hatch for runner-specific paths (e.g. custom toolchains) |

**git push credential injection:** env token (`GITHUB_TOKEN` / `GH_TOKEN` already in `cleanEnv`). No credential-helper bind is required; env token is simpler, already implemented, and avoids binding `~/.gitconfig` or a helper binary.

**Per-worker clone vs ro-bind:** A per-worker clone of a typical repo (50-200 MB, 0.5-30 s with `--depth=1` depending on network) would increase worktree setup time by 10–60 × compared to the current `git worktree add` (< 1 s, shared object store, < 2 MB disk per worktree). Decision: **ro-bind the parent `.git/`**. Workers only read objects; new commits are written to the worktree's own packed-refs inside the parent `.git/worktrees/<id>/` subtree, which is also covered by the ro bind. This is safe for concurrent workers because object writes are always append-only.

### 2. Explicitly Absent from the View

| What | Why excluded |
|------|-------------|
| Sibling worktrees (`repoPath/.buildd-worktrees/`) | Other tenants' working trees |
| Runner home (`~/.buildd/`) | Runner coordination key, worker-state files |
| Other workers' credential dirs (`/tmp/claude-cfg-*` not owned by this worker, `/tmp/buildd-codex-homes/<other-worker-id>/`) | Credential isolation between concurrent workers |
| `apps/runner/` source tree and `node_modules/` | Runner internals; agents have no legitimate need |
| Other workers' Codex homes under `isolationRoot` | Scoped credential isolation |
| `~/.claude/` subtree when `claudeConfigDir` is active | No dual-mount; per-worker dir is the sole auth source |
| Other LLM provider credentials (`~/.config/gcloud/`, `~/.aws/`) | Not the active backend for this task |

### 3. Spawn Integration

**Where the bwrap argv is built:** `workers.ts:startSession()`, immediately after `cleanEnv` is fully assembled (after credential injection, role env, provision gate) and before `createBackend()`. The call site is ~line 2085 (between the `cleanEnv` assembly and the `queryOptions` block).

```typescript
// Compose mount allowlist for this worker session
const mountAllowlist = buildWorkerMountAllowlist({
  worktreePath: sessionCwd,
  repoPath,
  claudeConfigDir,         // set when worker.claudeAccessToken is set
  codexHome: cleanEnv.CODEX_HOME,
  isCodexTask,
  extraMounts: process.env.BUILDD_MOUNT_ALLOWLIST_EXTRA,
});
// Then pass to sandbox config or outer bwrap wrapper
```

**`BUILDD_MOUNT_ALLOWLIST_EXTRA` format:** colon-separated `<absolute-path>:<mode>` pairs. Mode is `ro` or `rw`. Multiple entries separated by `,`.

```
BUILDD_MOUNT_ALLOWLIST_EXTRA=/opt/custom-toolchain:ro,/shared/cache:rw
```

Parsing rejects relative paths and unknown modes. Unknown entries are skipped with a warning, never fatal.

**`BUILDD_DISABLE_SANDBOX=1`** — unchanged. When set, mount allowlist assembly is skipped and no bwrap wrapper is created. Existing `isBwrapSupported()` logic is unaffected.

### 4. Failure Taxonomy: `sandbox_mount_gap`

New exit cause alongside `bwrap_namespace_denied`.

**Detection:** `scanToolResult()` already matches every tool result line. Add pattern:

```typescript
{ slug: 'sandbox_mount_gap', re: /(?:ENOENT|EACCES|No such file or directory|Permission denied).*\/(?:home|opt|tmp|proc)/ }
```

Narrow to fire only when `isBwrapSupported() && sandboxConfig?.enabled` (i.e. the sandbox is actually active), preventing false positives from normal ENOENT errors when sandbox is disabled.

**Properties:**
- `retryable: true` — the failure is a configuration gap, not agent reasoning; the operator can add the missing path to `BUILDD_MOUNT_ALLOWLIST_EXTRA` and retry.
- **Does not consume code-retry attempts.** Code retries (the ralph loop counter) track agent reasoning failures. A mount gap is a runner misconfiguration. Exit immediately with `sandbox_mount_gap` cause; the orchestrator creates a new task with `parentTaskId` pointing back, inheriting the context.
- **Interaction with `bwrap_namespace_denied`:** Disjoint. `bwrap_namespace_denied` fires when bwrap itself can't start (user namespaces blocked); at that point no sandbox is running so no mount gaps can occur. If both slugs appear, the namespace failure wins — the runner flips `_bwrapSupported = false` and aborts, which already supersedes any gap handling.

### 5. Rollout

| Phase | Trigger | Default |
|-------|---------|---------|
| 1 — Per-runner opt-in | `BUILDD_SANDBOX_MOUNT_ALLOWLIST=1` | off |
| 2 — Default-on | Zero `sandbox_mount_gap` traces across opted-in runners for 7+ days in production | still off, promoted on evidence |
| 3 — Default-on | Flip default; `BUILDD_DISABLE_SANDBOX=1` remains kill switch | on |

Operators on phase 1 see all `sandbox_mount_gap` errors surfaced in the error-trace UI; they extend via `BUILDD_MOUNT_ALLOWLIST_EXTRA` as needed. Phase 3 does not ship until the mount table has proven stable.

---

## Probe Test Design

Acceptance: two canary checks must fail; one real build-test-push sequence must pass.

```
# Canary 1: read outside allowlist (runner coordination key)
cat ~/.buildd/config.json
# expected: EACCES or ENOENT (not the file content)

# Canary 2: sibling worktree read
ls <repoPath>/.buildd-worktrees/<sibling-branch>/
# expected: ENOENT

# Real workflow: must succeed in the worker's own worktree
bun install && bun test && git add -A && git commit -m "test" && git push origin HEAD
```

Canary checks run as a PreToolUse hook before the actual agent task starts, driven by a test-only task descriptor with `sandboxProbeMode: true`. Both must return a non-zero exit or error string; the probe fails if either returns file content or a directory listing.

---

## Open Questions

**Q: Does the Claude Code SDK expose `extraMounts` today?** Unknown — the SDK's `sandbox` type is not fully documented. If it doesn't, the outer-bwrap-wrapper path (wrapping the entire `claude` subprocess) is the fallback. The mount table design is the same; only the injection mechanism differs. Leaning toward waiting for SDK exposure rather than shipping the wrapper (which adds process management complexity).

**Q: Bun cache location under isolation root?** `$BUN_INSTALL/install/cache` resolves to `~/.bun/install/cache` by default but can be overridden by `BUN_INSTALL`. The mount table must resolve from `cleanEnv.BUN_INSTALL` if set, not a hardcoded home path.

---

## Non-Goals

- Full network isolation (separate bwrap `--unshare-net`) — changes egress policy; out of scope here.
- Landlock LSM as a replacement for bwrap — complementary approach, separate design.
- Extending the read-jail hook coverage to Bash commands — that requires hooking the bash wrapper; separate design.
- Per-workspace custom mount tables via the dashboard UI — operator env var is sufficient for now.
