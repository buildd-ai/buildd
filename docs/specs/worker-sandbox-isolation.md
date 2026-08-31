---
title: Worker Sandbox Isolation
status: active
owner: max
last_verified: 2026-08-30
summary: An opted-in runner MUST confine each agent subprocess to a bwrap namespace mounting only that task's worktree, project .git, toolchain and active-backend credentials, and MUST report every degradation of that boundary.
domain: runners
surfaces: [apps/runner/src/bwrap-mount-allowlist.ts, apps/runner/src/workers.ts, apps/runner/src/env-scan.ts, apps/runner/src/cbm-enforcement.ts]
related: [credential-isolation, codex-backend-spec, codebase-memory-graph, runner-liveness]
keywords: [bwrap, bubblewrap, BUILDD_DISABLE_SANDBOX, BUILDD_SANDBOX_MOUNT_ALLOWLIST, BUILDD_MOUNT_ALLOWLIST_EXTRA, sandbox_mount_gap, bwrap_namespace_denied, unprivileged_userns_clone, tmpfs, mount allowlist]
verified_by: [apps/runner/__tests__/unit/bwrap-mount-allowlist.test.ts, apps/runner/__tests__/unit/bwrap-runtime-recovery.test.ts, apps/runner/__tests__/unit/backends/codex-sandbox-bwrap.test.ts, apps/runner/__tests__/unit/cbm-enforcement.test.ts, apps/web/src/app/api/workers/[id]/route.test.ts]
supersedes: []
---

## Worker Sandbox Isolation

**Capability statement**: When the mount allowlist is active, the runner MUST
spawn the agent process inside a bwrap mount namespace whose visible filesystem
is exactly the table composed by `buildWorkerBwrapArgv()` — the task's own
worktree and project `.git` writable, the toolchain and the active backend's
credential directory only — and MUST surface every case where that boundary is
absent, degraded, or too narrow rather than continuing silently.

---

### 0. Why containment is a separate contract

`docs/specs/credential-isolation.md` decides **which secrets exist** in the agent
process. This spec decides **what the process can reach**. The two are
independent rings, and the second exists because the first has a documented hole:
the read-jail (`apps/runner/src/read-jail.ts:11-13`) enforces its denied prefixes
via a `PreToolUse` hook on `Read`/`Glob`/`Grep` only — "Bash shell commands are
not fully intercepted at this layer — use bwrap or Landlock for kernel-level
enforcement". An agent with a shell is outside the application-layer jail by
construction. The mount namespace is the layer that makes the jail's denials
structural: a sibling worktree or another worker's credential dir is unreachable
because it was never mounted, not because a hook said no.

Two facts a reader must carry into the rest of this document:

1. **The boundary is opt-in and off by default.** `isMountAllowlistEnabled()`
   requires `BUILDD_SANDBOX_MOUNT_ALLOWLIST=1`
   (`apps/runner/src/bwrap-mount-allowlist.ts:45-47`). A runner that sets nothing
   runs agents with no outer namespace at all. This is phase 1 of the rollout in
   `docs/design/worker-mount-isolation.md` §5; phases 2-3 have not shipped.
2. **The kernel-level denial probes have never passed.** The only tests that
   assert an agent *cannot* reach a path outside the table live in
   `apps/runner/src/__tests__/mount-isolation.e2e.ts`, whose recorded verdict is
   BLOCKED (host denied unprivileged namespace creation) and which `bun test`
   does not discover — `scripts/run-unit-tests.ts:42` globs `**/*.test.{ts,tsx}`
   and that file is `.e2e.ts`. Everything asserted in CI is about the argv the
   runner *builds*, not about what the kernel then enforces. See
   **Verification gaps**.

---

### 1. What the namespace contains

`buildWorkerBwrapArgv()` (`apps/runner/src/bwrap-mount-allowlist.ts:86-133`)
composes one table per task. The table is the whole contract: containment is
defined by absence, so adding a mount is a security change and must be reviewed
as one.

**Invariants**:
- **WS-1**: The argv MUST begin with
  `--die-with-parent --new-session --unshare-user --unshare-pid --uid 0 --gid 0
  --tmpfs /` (line 126). `--tmpfs /` is what makes the table exhaustive — the
  host root is not inherited, so any path not bound afterwards does not exist
  inside the namespace. `--die-with-parent` is what prevents an agent subprocess
  outliving the worker session that is accountable for it.
- **WS-2**: Exactly two paths are mounted writable for the task's own work: the
  session worktree and `<repoPath>/.git` (lines 92-96). `.git` of the parent
  clone is writable because a linked worktree writes refs, index state and new
  objects into the shared store; per-worker clones were rejected on setup cost
  in `docs/design/worker-mount-isolation.md` §1.
- **WS-3**: The system toolchain is read-only. `SYSTEM_RO_BINDS` (lines 34-43) is
  `/usr`, `/bin`, `/lib`, `/lib64`, `/usr/local`, `/etc/ssl`, `/etc/resolv.conf`,
  `/etc/nsswitch.conf` — TLS roots and DNS resolution, and nothing else from
  `/etc`.
- **WS-4**: Exactly one backend credential surface is mounted, chosen by
  `isCodexTask` (lines 104-113): the per-worker `CODEX_HOME` (rw) for Codex, the
  per-worker `CLAUDE_CONFIG_DIR` (rw) when one was materialized, otherwise
  `~/.claude/.credentials.json` and `~/.claude/settings.json` (ro). The
  non-active backend's credential path MUST NOT appear in the table.
- **WS-5**: Package caches are the only shared-writable host state:
  `$BUN_INSTALL` ro with `$BUN_INSTALL/install/cache` rw, and `~/.npm` rw
  (lines 98-100). Nesting is expressed by order — the rw cache bind is emitted
  after its ro parent, so argv order is load-bearing and MUST NOT be sorted.
- **WS-6**: `/proc`, `/dev`, a `/dev/shm` tmpfs, a `/tmp` tmpfs and a read-only
  `/sys` are emitted after the `--dir` list and before every bind (line 128).
  Because `/tmp` is a fresh tmpfs, sibling workers' `claude-cfg-*` dirs and
  `/tmp/cbm-*` caches are invisible even though they share a host `/tmp`.
- **WS-7**: When Codebase Memory is enforced for the task, the CBM binary is
  mounted ro at `CBM_BINARY_PATH` (`/opt/buildd/bin/codebase-memory-mcp`) and the
  per-worker cache dir `/tmp/cbm-<workerId>` rw (lines 115-116). The cache dir
  MUST be created by the caller before the argv is built —
  `workers.ts:2324-2328` `mkdirSync`s it — because an absent path is dropped by
  WS-9 and a dropped cache dir means a CBM binary that cannot write.
- **WS-8**: Neither the runner's own source tree, `~/.buildd`, sibling worktrees
  under `<repoPath>/.buildd-worktrees`, nor any other worker's credential dir
  appears in the table. This is the same denied set as
  `buildReadJailDeniedPrefixes()` (`read-jail.ts:24-33`), enforced structurally
  instead of by hook.

**Acceptance criteria**:
- AC-1: GIVEN a Claude task with a managed `claudeConfigDir` WHEN
  `buildWorkerBwrapArgv()` runs THEN the argv contains `--bind <claudeConfigDir>`
  and contains no path under `~/.claude`.
- AC-2: GIVEN `isCodexTask: true` with a `codexHome` WHEN the argv is built THEN
  it contains `--bind <codexHome>` and neither `.credentials.json` nor
  `settings.json` under `$HOME/.claude`.
- AC-3: GIVEN any config WHEN the argv is built THEN element 0..9 are
  `--die-with-parent --new-session --unshare-user --unshare-pid --uid 0 --gid 0
  --tmpfs /` in that order, and `--tmpfs /tmp` precedes every `--bind` /
  `--ro-bind` pair.
- AC-4: GIVEN a config with `cbmBinaryPath` and `cbmCacheDir` WHEN the argv is
  built THEN the binary is `--ro-bind` and the cache dir is `--bind`; GIVEN both
  are absent THEN the string `codebase-memory-mcp` does not occur in the argv.
- AC-5: GIVEN `worktreePath = <repo>/.buildd-worktrees/task` WHEN the argv is
  built THEN `<repo>/.buildd-worktrees` appears only as a `--dir` (an empty
  directory in the tmpfs root) and never as a bind — sibling worktrees are not
  reachable through it.

---

### 2. Mount resolution: absent, duplicate, and parent paths

**Invariants**:
- **WS-9**: Every candidate mount is filtered by existence on the host, and an
  absent path is dropped with a `Skipping unavailable sandbox mount "<path>"`
  warning (lines 118-122). Startup MUST NOT fail. This is the right invariant and
  is deliberate in both directions: a dropped mount can only *narrow* the
  namespace, so it is fail-closed for containment, while hard-failing on, say, a
  runner with no `~/.npm` would take a whole runner offline for a path most tasks
  never touch. The availability cost is paid instead by the detection path in §4
  — a dropped mount that the task actually needed surfaces as
  `sandbox_mount_gap`, aborts that one session, and re-queues that one task.
- **WS-10**: Mounts are deduped by absolute path (line 123). Insertion order of
  the first occurrence is preserved; the **mode of the last occurrence wins**.
- **WS-11**: Every parent directory of every surviving mount is materialized with
  `--dir` before the binds (lines 76-84, 124, 127). A `--dir` grants existence,
  not content: `/repo` and `/home/runner` exist inside the namespace as empty
  directories so their non-mounted children remain unreachable.
- **WS-12**: All mount paths are `resolve()`d to absolute form before use
  (lines 89-116), so no entry in the emitted table is relative or
  `~`-dependent.

**Acceptance criteria**:
- AC-6: GIVEN `pathExists` returns false for `<home>/.claude/settings.json` WHEN
  the argv is built THEN `settings.json` is absent from the argv, the remaining
  mounts are unchanged, and the call returns normally (no throw).
- AC-7: GIVEN a `worktreePath` equal to `repoPath` WHEN the argv is built THEN
  `/repo` is bound exactly once (dedupe collapses the worktree and repo entries).
- AC-8: GIVEN a mount at `/repo/.buildd-worktrees/task` WHEN the argv is built
  THEN `--dir /repo` and `--dir /repo/.buildd-worktrees` are emitted before the
  first `--bind`.

---

### 3. Activation gates and the escape hatch

Three independent conditions must hold for an agent to run inside the outer
namespace, and the wrapper is wired for the Claude backend only.

**Invariants**:
- **WS-13**: `isMountAllowlistEnabled()` returns true only when
  `BUILDD_SANDBOX_MOUNT_ALLOWLIST === '1'` **and**
  `BUILDD_DISABLE_SANDBOX !== '1'` (lines 45-47). It is read from `process.env`
  on every call, so the flags take effect without a restart.
- **WS-14**: `BUILDD_DISABLE_SANDBOX=1` is the single global kill switch and it
  turns off *everything* namespace-related, at three separate reads:
  the mount allowlist (line 46), the cached capability probe
  (`workers.ts:112-115`, checked ahead of the cache so a late-set flag still
  wins), and the probe itself (`env-scan.ts:58`). Its downstream effects are the
  SDK sandbox forced to `{enabled: false}` and
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0` (`workers.ts:2271-2283`), plus the Codex
  sandbox downgrade in WS-16. Legitimate use is exactly one case: a host whose
  outer runtime denies namespace creation in a way the probe cannot detect, where
  the operator has accepted running agents with no filesystem containment. It is
  not a debugging default, and it is not a fix for a mount gap — the fix for a
  mount gap is `BUILDD_MOUNT_ALLOWLIST_EXTRA` (§5).
- **WS-15**: The outer wrapper is applied only when
  `isMountAllowlistEnabled() && isBwrapSupported()` (`workers.ts:2396`) and only
  for non-Codex tasks (`workers.ts:2420`). `isBwrapSupported()` is probed once
  per process, warmed at boot before any task starts (`workers.ts:518-521`), and
  caches its result so the answer cannot change mid-task except by the
  degradation path in §4.
- **WS-16**: Codex tasks receive no outer namespace. Their containment is the
  Codex CLI's own `sandboxMode`, and `bwrapSupported: false` downgrades
  `workspace-write` to `danger-full-access` with a warning
  (`backends/codex-backend.ts:336-348`, called at line 47). The mapping itself is
  owned by `docs/specs/codex-backend-spec.md` INV-20; what this spec asserts is
  the consequence — on a namespace-denied host a Codex task runs with *no* write
  isolation, and that is a visible warning, not a failure.
- **WS-17**: An opted-in runner advertises the `sandbox:mount-allowlist`
  capability in its env keys (`env-scan.ts:286-290`,
  `packages/shared/src/types.ts:1438`), using the same two-flag condition as
  WS-13 so the advertised capability cannot disagree with the runtime gate.

**Acceptance criteria**:
- AC-9: GIVEN `BUILDD_SANDBOX_MOUNT_ALLOWLIST` unset WHEN
  `isMountAllowlistEnabled()` is called THEN it returns false (default-off).
- AC-10 (failure): GIVEN `BUILDD_SANDBOX_MOUNT_ALLOWLIST=1` and
  `BUILDD_DISABLE_SANDBOX=1` WHEN `isMountAllowlistEnabled()` is called THEN it
  returns false — the kill switch overrides the opt-in, and no argv is built.
- AC-11: GIVEN `bwrapSupported: false` and `sandboxMode: 'workspace-write'` WHEN
  the Codex backend maps the sandbox mode THEN it returns `danger-full-access`
  and logs a warning; GIVEN `sandboxMode: 'read-only'` THEN it returns
  `read-only` regardless of `bwrapSupported`.
- AC-12: GIVEN a runner whose `WorkerManager` has been constructed THEN
  `getBwrapProbeAt()` is non-null before the first task starts.

---

### 4. Degradation is always reported

Two distinct failures, deliberately handled differently: the namespace cannot be
created (containment impossible → keep working, lose the boundary) versus the
namespace is too narrow (containment working → stop, widen it, retry).

**Invariants**:
- **WS-18**: `createBwrapSpawn()` watches the child's stderr for
  `bwrap: No permissions to create a new namespace` /
  `bwrap: Creating new namespace failed`
  (`bwrap-mount-allowlist.ts:146-157`) and fires `onNamespaceDenied` at most
  once per child. The same pattern is a first-class error trace,
  `bwrap_namespace_denied` (`error-trace-scanner.ts:47-48`), so the denial is
  also detected when it surfaces through a tool result
  (`workers.ts:4102-4110`).
- **WS-19**: On namespace denial the runner flips the cached probe to false,
  sets `worker.bwrapRetryPending`, aborts the session, and restarts it **without
  the sandbox** rather than marking the task failed
  (`workers.ts:2422-2432`, `3274-3282`, `3536-3537`). The restart preserves the
  worktree (`workers.ts:3366`) and uses a fresh invocation session id
  (`workers.ts:1581-1595`). The cache flip is the loop guard: the flag is only
  set when `_bwrapSupported !== false`, so a second bwrap abort cannot occur in
  the same process. This trades containment for task completion, once per runner
  process, and the trade is visible in the `bwrap_retry: restarting without
  sandbox` milestone and in the heartbeat's `sandboxEnabled` field
  (`workers.ts:677-678`, `apps/web/src/lib/runner-heartbeats-shared.ts:22-25`).
- **WS-20**: A `sandbox_mount_gap` trace MUST NOT flip the capability cache
  (`workers.ts:4114-4133`). The sandbox is working; only the table is short. The
  runner sets `worker.sandboxMountGap`, names the offending path in
  `worker.error` together with the `BUILDD_MOUNT_ALLOWLIST_EXTRA` remedy, and
  aborts that session only.
- **WS-21**: The gap flag is reported to the control plane
  (`workers.ts:3294`), which classifies `exitCause = 'sandbox_mount_gap'`, resets
  the task to `pending`, and exempts it from the code-retry cap
  (`apps/web/src/app/api/workers/[id]/route.ts:647-660`, `928-950`). Precedence:
  a task in a `budget_exhausted` mission is NOT re-queued, because a pending task
  in an exhausted mission is invisible to the claim loop.
- **WS-22**: `sandbox_mount_gap` detection is deliberately narrow — ENOENT/EACCES
  against `.npmrc`, `.gitconfig`, `/snap/`, `/opt/`
  (`error-trace-scanner.ts:49-57`). A false positive on ordinary in-repo ENOENT
  would re-queue tasks that deserve to fail, so misses are preferred to
  misfires.

**Acceptance criteria**:
- AC-13 (failure): GIVEN a running worker whose tool output contains
  `bwrap: No permissions to create a new namespace` WHEN the trace scanner runs
  THEN `worker.bwrapRetryPending` is set, the session is aborted, and
  `updateWorker` is NOT called with `status: 'failed'`.
- AC-14: GIVEN the session restarted by AC-13 THEN its invocation session id
  differs from the aborted one and the worktree still exists.
- AC-15 (failure): GIVEN a worker whose tool output contains
  `ENOENT ... .npmrc` WHEN the scanner runs THEN a `sandbox_mount_gap` trace is
  emitted, the session is aborted with `worker.sandboxMountGap = true`, and the
  cached bwrap support value is unchanged.
- AC-16: GIVEN a terminal worker update with `sandboxMountGap: true` WHEN the
  PATCH handler runs THEN `worker.exitCause = 'sandbox_mount_gap'` and the task
  is reset to `pending`, and that worker does not count toward the retry cap.
- AC-17: GIVEN the same update for a task whose mission is `budget_exhausted`
  THEN the task is NOT reset to pending and the failure surfaces normally.
- AC-18: GIVEN tool output containing an ENOENT for a path inside the worktree
  WHEN the scanner runs THEN no `sandbox_mount_gap` trace is emitted.

---

### 5. Operator-supplied mounts

`BUILDD_MOUNT_ALLOWLIST_EXTRA` is the documented remedy for a mount gap:
comma-separated `<absolute-path>[:ro|:rw]` entries, parsed by
`parseExtraMounts()` (`bwrap-mount-allowlist.ts:49-74`).

**Invariants**:
- **WS-23**: A relative path, or an entry whose trailing `:`-segment is neither
  `ro` nor `rw`, is skipped with a warning naming the entry. Malformed input MUST
  NOT be fatal and MUST NOT silently become a mount.
- **WS-24**: The mode defaults to `ro` when omitted. Only a trailing `:ro` /
  `:rw` is read as a mode, so absolute paths containing colons survive parsing.
- **WS-25**: Extra mounts are appended after the base table and before the CBM
  mounts (line 114), so by WS-10 an extra entry naming a path already in the
  table replaces that path's mode. Widening a system bind to `rw` this way is
  possible and unguarded — see **Verification gaps**.

**Acceptance criteria**:
- AC-19: GIVEN `BUILDD_MOUNT_ALLOWLIST_EXTRA=/opt/tools:ro,/shared/cache:rw,/data`
  WHEN parsed THEN the result is exactly
  `[{/opt/tools, ro}, {/shared/cache, rw}, {/data, ro}]`.
- AC-20 (failure): GIVEN `relative:ro,/valid:execute,/ok:rw` WHEN parsed THEN
  only `{/ok, rw}` is returned and exactly two warnings are emitted.
- AC-21: GIVEN `/mnt/cache:segment:rw` WHEN parsed THEN the path is
  `/mnt/cache:segment` with mode `rw`.

---

**Code surface**:
- Table + argv builder: `apps/runner/src/bwrap-mount-allowlist.ts` —
  `SYSTEM_RO_BINDS` (34-43), `isMountAllowlistEnabled()` (45-47),
  `parseExtraMounts()` (49-74), `parentDirs()` (76-84),
  `buildWorkerBwrapArgv()` (86-133), `createBwrapSpawn()` (135-159),
  `CBM_BINARY_PATH` (14)
- Call site + lifecycle: `apps/runner/src/workers.ts` — `isBwrapSupported()`
  (105-123), boot probe (518-521), heartbeat report (677-678), SDK sandbox +
  env-scrub forcing (2271-2283), argv assembly (2396-2410),
  `spawnClaudeCodeProcess` wiring (2420-2432), `bwrapSupported` handoff to the
  backend (2809), retry-on-denial (3274-3282, 3536-3537), gap flag on the PATCH
  (3294), worktree preservation (3366), runtime denial + gap detection
  (4102-4133)
- Capability probe: `apps/runner/src/env-scan.ts` — `checkBwrapSupport()`
  (54-91), capability advertisement (286-290); operator check:
  `apps/runner/src/doctor.ts` — `checkBwrap()` (304-319)
- Detection patterns: `apps/runner/src/error-trace-scanner.ts` (47-57)
- CBM mount inputs: `apps/runner/src/cbm-enforcement.ts` —
  `buildCbmActivation()` (68-81)
- Application-layer complement: `apps/runner/src/read-jail.ts` —
  `buildReadJailDeniedPrefixes()` (24-33)
- Codex interaction: `apps/runner/src/backends/codex-backend.ts` —
  `mapSandboxMode()` (336-348); `apps/runner/src/backends/types.ts` —
  `bwrapSupported` (34-40)
- Worker flags: `apps/runner/src/types.ts` — `sandboxMountGap`,
  `bwrapRetryPending` (197-198)
- Control plane: `apps/web/src/app/api/workers/[id]/route.ts` — gap
  classification (647-660) and re-queue with budget precedence (928-950);
  `apps/web/src/lib/runner-heartbeats-shared.ts` — `sandboxEnabled`,
  `sandboxProbeAt` (22-25)
- Capability constant: `packages/shared/src/types.ts:1438` —
  `CAPABILITY_SANDBOX_MOUNT_ALLOWLIST`
- Design origin: `docs/design/worker-mount-isolation.md` (bind table, rollout
  phases, probe design)

**Out of scope**:
- **Network egress.** The argv passes no `--unshare-net` (and no `--unshare-ipc`
  / `--unshare-uts` / `--unshare-cgroup`); the agent shares the host network
  namespace. Explicit non-goal in `docs/design/worker-mount-isolation.md`.
- **Which credentials exist in the process.** `cleanEnv` composition, MCP bearer
  injection and the `Read`/`Bash` denylists belong to
  `docs/specs/credential-isolation.md`.
- **The Codex `sandboxMode` mapping** (`read-only` vs `workspace-write`) —
  `docs/specs/codex-backend-spec.md` INV-20. This spec covers only the
  `bwrapSupported=false` downgrade as an observable consequence.
- **The Claude Code SDK's own inner bwrap sandbox** (`gitConfig.sandbox`) beyond
  the fact that the runner force-disables it when namespaces are unavailable.
  Its internal mount table is not ours.
- **Landlock LSM** as a replacement or complement.
- **Per-workspace mount tables from the dashboard.** Mount configuration is
  operator-scoped env only.
- **CBM tool policy** (`CBM_BLOCKED_TOOLS`, indexing behaviour) — only the two
  CBM mounts are in scope here.

---

## Verification gaps

Unguarded claims and known drift. Each is a real hole, listed so a regression in
it is recognisable rather than discovered.

1. **No CI test proves any denial.** Every invariant in §1 is verified as *argv
   text* (snapshot in
   `apps/runner/__tests__/unit/__snapshots__/bwrap-mount-allowlist.test.ts.snap`).
   The only tests that spawn a real namespace and assert a blocked path —
   sibling worktree, runner coordination key, the non-active backend's
   credential dir — are in `apps/runner/src/__tests__/mount-isolation.e2e.ts`,
   which is not matched by the `**/*.test.{ts,tsx}` discovery glob and whose
   last recorded run was BLOCKED on a host that denies namespace creation
   (13 of 24 checks skipped). WS-8 in particular is asserted by absence from a
   snapshot, not by a failed read.
2. **FIXED** — The wrapper is never exercised for Codex, but the code pretends otherwise.**
   `buildWorkerBwrapArgv()` has a full Codex branch (WS-4) with its own snapshot
   test, yet `workers.ts:2420` gates the wrapper on `!isCodexTask`. No production
   path passes a Codex config to the builder. Either the Codex branch is dead
   code or the gate is an unfinished rollout; the snapshot makes it look shipped.

   Closed here: the gate is a tested predicate (`shouldWrapWorkerInBwrap`) and nothing is built for Codex. Its snapshot pinned argv nobody used; replaced with assertions on the split the acceptance probe depends on.

3. **FIXED** — The capability probe is stricter than the wrapper it gates.**
   `checkBwrapSupport()` requires `--unshare-user --unshare-pid --unshare-net`
   to succeed (`env-scan.ts:83`) because it mirrors Claude Code's *inner*
   sandbox. The outer wrapper never unshares the network. A host that permits
   user and PID namespaces but denies network namespaces therefore reports
   `bwrapSupported: false` and gives up a mount boundary that would have worked.
   No test covers this combination.

   Closed here: probes are per consumer. The strict user+pid+net probe still gates the inner sandbox and env scrubbing; a user+pid probe gates mount isolation, which is what the outer argv actually needs.

4. **FIXED** — `BUILDD_MOUNT_ALLOWLIST_EXTRA` can widen the base table (WS-25).** Dedupe is
   last-writer-wins on mode, and `parseExtraMounts()` applies no denylist — the
   read-jail's denied prefixes are not consulted. Two classes of weakness follow,
   both operator-triggered and both currently untested: an `rw` entry covering a
   path outside the worktree (for example a home or repo parent) puts the
   runner's own source and coordination state inside the agent's writable view,
   and an entry naming an existing system bind can convert it from `ro` to `rw`.
   A guard that refuses extra mounts intersecting
   `buildReadJailDeniedPrefixes()` and refuses to downgrade a `SYSTEM_RO_BINDS`
   entry would close this; neither exists.

   Closed here: built-ins are assembled first and an operator entry colliding with one is rejected with a warning, whatever mode it names — it can no longer downgrade a system bind to rw.

5. **The rw `.git` bind (WS-2) is a real residual exposure.** The parent clone's
   `.git` must be writable for commit and push, which means the agent's writable
   view includes git's own configuration and hook directory — content that the
   runner later executes *outside* the namespace during ordinary git operations.
   Nothing in the runner validates `.git/hooks` or `.git/config` between
   sessions. Accepted deliberately (per-worker clones were rejected on cost), but
   it is the narrowest remaining path from inside the sandbox to host execution
   and it deserves a hook-integrity check.
6. **FIXED** — The health surface reports the wrong thing.** `sandboxEnabled` on the
   heartbeat is `isBwrapSupported()` — kernel capability — not whether the mount
   allowlist is active. Since WS-13 is default-off, a runner can display
   "sandbox ok" while running agents with no outer namespace at all. Similarly
   `doctor.ts:307-309` returns status **ok** with "bwrap not installed —
   sandboxing disabled (expected)". Nothing in CI asserts these two surfaces
   agree with `isMountAllowlistEnabled()`.

   Closed here: the `sandbox:mount-allowlist` capability is advertised only when the opt-in is set AND the probe passes, and a derived posture drives the badge. Green now means enforced; bwrap-present-allowlist-off renders `mounts unrestricted` as a warning. Still open by choice: the Health problems panel does not COUNT a degraded runner, because with the allowlist default-off that would flag every runner today.

7. **No host prerequisite is installed or checked at install time.**
   `apps/runner/install.sh` never mentions bubblewrap; the only mentions in the
   repo are the probe, the e2e suite, and the design doc. A fresh runner is
   unsandboxed by default and nothing during installation says so.
8. **WS-19's degradation is untested as a security event.** Tests cover that the
   retry happens and that the task is not failed
   (`bwrap-runtime-recovery.test.ts`); nothing asserts that the resulting
   unsandboxed run is recorded anywhere an operator would notice beyond a log
   line and a milestone.
9. **WS-9's warning path is asserted only indirectly.** The unit tests exercise
   `pathExists` returning false for one file; no test asserts the warning text
   or that a dropped *required* mount (for example the CBM cache dir) is what
   later produces `sandbox_mount_gap`.
