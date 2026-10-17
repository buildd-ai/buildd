---
title: Worker Sandbox Isolation
status: active
owner: max
last_verified: 2026-10-15
summary: An opted-in runner MUST confine each agent subprocess to a bwrap namespace mounting only that task's worktree, project .git, toolchain and active-backend credentials, and MUST report every degradation of that boundary.
domain: runners
surfaces: [apps/runner/src/bwrap-mount-allowlist.ts, apps/runner/src/workers.ts, apps/runner/src/env-scan.ts]
related: [credential-isolation, codex-backend-spec, runner-liveness]
keywords: [bwrap, bubblewrap, BUILDD_DISABLE_SANDBOX, BUILDD_SANDBOX_MOUNT_ALLOWLIST, BUILDD_MOUNT_ALLOWLIST_EXTRA, sandbox_mount_gap, bwrap_namespace_denied, unprivileged_userns_clone, tmpfs, mount allowlist]
verified_by: [apps/runner/__tests__/unit/bwrap-mount-allowlist.test.ts, apps/runner/__tests__/unit/bwrap-runtime-recovery.test.ts, apps/runner/__tests__/unit/backends/codex-sandbox-bwrap.test.ts, apps/web/src/app/api/workers/[id]/route.test.ts]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "bwrap-argv"
    type: "symbol"
    name: "buildWorkerBwrapArgv"
    path: "apps/runner/src/bwrap-mount-allowlist.ts"
  - id: "mount-isolation-probe"
    type: "symbol"
    name: "checkBwrapMountIsolationSupport"
    path: "apps/runner/src/env-scan.ts"
  - id: "mount-boundary-tests"
    type: "test_file"
    path: "apps/runner/__tests__/unit/bwrap-mount-allowlist.test.ts"
  - id: "worker-builds-mount-boundary"
    type: "symbol_reachable"
    symbol: "buildWorkerBwrapArgv"
    entry: "apps/runner/src/workers.ts"
    as: "read"
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
the read-jail (the module comment of `apps/runner/src/read-jail.ts`) enforces its denied prefixes
via a `PreToolUse` hook on `Read`/`Glob`/`Grep` only — "Bash shell commands are
not fully intercepted at this layer — use bwrap or Landlock for kernel-level
enforcement". An agent with a shell is outside the application-layer jail by
construction. The mount namespace is the layer that makes the jail's denials
structural: a sibling worktree or another worker's credential dir is unreachable
because it was never mounted, not because a hook said no.

Two facts a reader must carry into the rest of this document:

1. **The boundary is opt-in and off by default.** `isMountAllowlistEnabled()`
   requires `BUILDD_SANDBOX_MOUNT_ALLOWLIST=1`
   (`apps/runner/src/bwrap-mount-allowlist.ts`). A runner that sets nothing
   runs agents with no outer namespace at all. This is phase 1 of the rollout in
   `docs/design/worker-mount-isolation.md` §5; phases 2-3 have not shipped.
2. **The kernel-level denial probes run in CI.** The tests that assert an
   agent *cannot* reach a path outside the table live in
   `apps/runner/src/__tests__/mount-isolation.e2e.ts`, which `bun test` does not
   discover (it is `.e2e.ts`); the `Sandbox isolation probe (bwrap)` job in
   `.github/workflows/build.yml` runs it and fails on a `skipped` banner. Until
   the capability probe bound `/lib` and `/lib64`, that job skipped on every
   run (the loader was missing, so exec failed ENOENT). See
   **Verification gaps**.

---

### 1. What the namespace contains

`buildWorkerBwrapArgv()` (`apps/runner/src/bwrap-mount-allowlist.ts`)
composes one table per task. The table is the whole contract: containment is
defined by absence, so adding a mount is a security change and must be reviewed
as one.

**Invariants**:
- **R-1**: The argv MUST begin with
  `--die-with-parent --new-session --unshare-user --unshare-pid --uid 0 --gid 0
  --tmpfs /` (the first `argv` literal). `--tmpfs /` is what makes the table exhaustive, the
  host root is not inherited, so any path not bound afterwards does not exist
  inside the namespace. `--die-with-parent` is what prevents an agent subprocess
  outliving the worker session that is accountable for it.
- **R-2**: Exactly two paths are mounted writable for the task's own work: the
  session worktree and `<repoPath>/.git` (the first two `builtins` entries). `.git` of the parent
  clone is writable because a linked worktree writes refs, index state and new
  objects into the shared store; per-worker clones were rejected on setup cost
  in `docs/design/worker-mount-isolation.md` §1.
- **R-3**: The system toolchain is read-only. `SYSTEM_RO_BINDS` is
  `/usr`, `/bin`, `/lib`, `/lib64`, `/usr/local`, `/etc/ssl`, `/etc/resolv.conf`,
  `/etc/nsswitch.conf` — TLS roots and DNS resolution, and nothing else from
  `/etc`.
- **R-4**: Exactly one backend credential surface is mounted, chosen by
  `isCodexTask` in `buildWorkerBwrapArgv()`: the per-worker `CODEX_HOME` (rw) for Codex, the
  per-worker `CLAUDE_CONFIG_DIR` (rw) when one was materialized, otherwise
  `~/.claude/.credentials.json` and `~/.claude/settings.json` (ro). The
  non-active backend's credential path MUST NOT appear in the table. The
  resolved Claude Code binary (`executablePath`) is also bound read-only when
  the runner passes one. In production only the Claude branch runs, because
  `shouldWrapWorkerInBwrap()` excludes Codex (R-15).
- **R-5**: Package caches are the only shared-writable host state:
  `$BUN_INSTALL` ro with `$BUN_INSTALL/install/cache` rw, and `~/.npm` rw
  (the `bunInstall` and `.npm` `builtins` entries). Nesting is expressed by order, the rw cache bind is emitted
  after its ro parent, so argv order is load-bearing and MUST NOT be sorted.
- **R-6**: `/proc`, `/dev`, a `/dev/shm` tmpfs, a `/tmp` tmpfs and a read-only
  `/sys` are emitted after the `--dir` list and before every bind.
  Because `/tmp` is a fresh tmpfs, sibling workers' `claude-cfg-*` dirs are
  invisible even though they share a host `/tmp`.
- Retired (formerly WS-7, no id now): the code-graph binary and cache mounts,
  removed with the code graph itself.
- **R-8**: Neither the runner's own source tree, `~/.buildd`, sibling worktrees
  under `<repoPath>/.buildd-worktrees`, nor any other worker's credential dir
  appears in the table. This is the same denied set as
  `buildReadJailDeniedPrefixes()` (`read-jail.ts`), enforced structurally
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
- Retired (formerly AC-4, no id now): the code-graph mount check, retired with
  the former WS-7.
- AC-5: GIVEN `worktreePath = <repo>/.buildd-worktrees/task` WHEN the argv is
  built THEN `<repo>/.buildd-worktrees` appears only as a `--dir` (an empty
  directory in the tmpfs root) and never as a bind — sibling worktrees are not
  reachable through it.

---

### 2. Mount resolution: absent, duplicate, and parent paths

**Invariants**:
- **R-9**: Every candidate mount is filtered by existence on the host, and an
  absent path is dropped with a `Skipping unavailable sandbox mount "<path>"`
  warning (the `present` filter in `buildWorkerBwrapArgv()`). Startup MUST NOT fail. This is the right invariant and
  is deliberate in both directions: a dropped mount can only *narrow* the
  namespace, so it is fail-closed for containment, while hard-failing on, say, a
  runner with no `~/.npm` would take a whole runner offline for a path most tasks
  never touch. The availability cost is paid instead by the detection path in §4:
  a dropped mount that the task actually needed surfaces as a
  `sandbox_mount_gap` trace and a milestone, and the agent's own failing
  commands then reach the normal failure path.
- **R-10**: Mounts are deduped by absolute path (the `deduped` Map in
  `buildWorkerBwrapArgv()`). Insertion order of
  the first occurrence is preserved; the **mode of the last occurrence wins**.
- **R-11**: Every parent directory of every surviving mount is materialized with
  `--dir` before the binds (`parentDirs()`, then the `--dir` loop). A `--dir` grants existence,
  not content: `/repo` and `/home/runner` exist inside the namespace as empty
  directories so their non-mounted children remain unreachable.
- **R-12**: All mount paths are `resolve()`d to absolute form before use
  (every `builtins` entry and `parseExtraMounts()`), so no entry in the emitted table is relative or
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
- **R-13**: `isMountAllowlistEnabled()` returns true only when
  `BUILDD_SANDBOX_MOUNT_ALLOWLIST === '1'` **and**
  `BUILDD_DISABLE_SANDBOX !== '1'`. It is read from `process.env`
  on every call, so the flags take effect without a restart.
- **R-14**: `BUILDD_DISABLE_SANDBOX=1` is the single global kill switch and it
  turns off *everything* namespace-related, at separate reads:
  `isMountAllowlistEnabled()`, the cached capability probes
  (`isBwrapSupported()` and `isMountIsolationBwrapSupported()` in
  `workers.ts`, checked ahead of the cache so a late-set flag still wins), and
  the probe itself (`probeBwrapNamespaces()` in `env-scan.ts`). Its downstream
  effects are the SDK sandbox forced to `{enabled: false}` and
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0` (the `sandboxConfig` and `cleanEnv`
  setup in `WorkerManager.startSession`), plus the Codex sandbox downgrade
  in R-16. Legitimate use is exactly one case: a host whose
  outer runtime denies namespace creation in a way the probe cannot detect, where
  the operator has accepted running agents with no filesystem containment. It is
  not a debugging default, and it is not a fix for a mount gap — the fix for a
  mount gap is `BUILDD_MOUNT_ALLOWLIST_EXTRA` (§5).
- **R-15**: The outer wrapper is applied only when
  `shouldWrapWorkerInBwrap()` is true: not a Codex task,
  `isMountAllowlistEnabled()`, and `isMountIsolationBwrapSupported()`. The
  mount-isolation probe (`checkBwrapMountIsolationSupport()`, user and PID
  namespaces) is separate from the inner-sandbox probe (`checkBwrapSupport()`,
  user, PID and network), because the outer argv never unshares the network.
  `isBwrapSupported()` is warmed at boot in the `WorkerManager` constructor
  before any task starts. Both probes cache their result per process, so the
  answer cannot change mid-task except by the degradation path in §4.
- **R-16**: Codex tasks receive no outer namespace. Their containment is the
  Codex CLI's own `sandboxMode`, and `bwrapSupported: false` downgrades
  `workspace-write` to `danger-full-access` with a warning
  (`mapSandboxMode()` in `backends/codex-backend.ts`). The mapping itself is
  owned by `docs/specs/codex-backend-spec.md` (its sandbox mode rule); what this spec asserts is
  the consequence — on a namespace-denied host a Codex task runs with *no* write
  isolation, and that is a visible warning, not a failure.
- **R-17**: An opted-in runner advertises the `sandbox:mount-allowlist`
  capability in its env keys (`scanEnvironment()` in `env-scan.ts`,
  `CAPABILITY_SANDBOX_MOUNT_ALLOWLIST` in `packages/shared/src/types.ts`) only
  when the two flags of R-13 hold AND `checkBwrapMountIsolationSupport()`
  passes, so the capability means the boundary is enforced, not just requested.

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
- **R-18**: `createBwrapSpawn()` watches the child's stderr for
  `bwrap: No permissions to create a new namespace` /
  `bwrap: Creating new namespace failed` and fires `onNamespaceDenied` at most
  once per child. The same pattern is a first-class error trace,
  `bwrap_namespace_denied` (`error-trace-scanner.ts`), so the denial is
  also detected when it surfaces through a tool result (the error-trace
  handling of tool results in `workers.ts`, which flips only the inner-sandbox
  cache).
- **R-19**: On namespace denial the runner flips the cached probes to false,
  sets `worker.bwrapRetryPending`, aborts the session, and restarts it **without
  the sandbox** rather than marking the task failed (the `onNamespaceDenied`
  callback passed to `createBwrapSpawn()`, and the `bwrapRetryPending` branch of
  the `startSession` catch block). The restart preserves the worktree (the
  `bwrapRetryAfterCleanup` path skips worktree cleanup) and uses a fresh
  `invocationSessionId`. The cache flip is the loop guard: the flag is only
  set while a cache is not yet false, so a second bwrap abort cannot occur in
  the same process. This trades containment for task completion, once per runner
  process, and the trade is visible in the `bwrap_retry: restarting without
  sandbox` milestone and in the heartbeat's `sandboxEnabled` field
  (sent by the `WorkerManager` heartbeat, typed in
  `apps/web/src/lib/runner-heartbeats-shared.ts`).
- **R-20**: A `sandbox_mount_gap` trace MUST NOT flip the capability cache.
  The sandbox is working; only the table is short. Today the runner only
  annotates: it logs the suspected path and records a
  `sandbox_mount_gap_suspected: <path>` milestone, and the session keeps
  running. It does not set `worker.sandboxMountGap` or abort. The abort was
  turned off because the detector matched file content as readily as real
  denials; it comes back once the tightened scanner has a track record (see
  the comment above the `sandbox_mount_gap` branch in `workers.ts`).
- **R-21**: When a terminal update carries `sandboxMountGap: true` (the runner
  sends it on an aborted session if the flag is set; nothing sets
  it while R-20 is annotate-only), the control plane classifies
  `exitCause = 'sandbox_mount_gap'` (`worker-exit-taxonomy.ts`), resets the task
  to `pending`, and exempts it from the code-retry cap (the
  `isSandboxMountGap` handling in `apps/web/src/app/api/workers/[id]/route.ts`).
  Precedence:
  a task in a `budget_exhausted` mission is NOT re-queued, because a pending task
  in an exhausted mission is invisible to the claim loop.
- **R-22**: `sandbox_mount_gap` detection is deliberately narrow, ENOENT/EACCES
  against `.npmrc`, `.gitconfig`, `/snap/`, `/opt/` (`isMountGapCandidate()`
  in `error-trace-scanner.ts`), and only when the SDK marked the tool result an
  error and a path can be extracted in a real error shape
  (`extractMountGapPath()`). A false positive on ordinary in-repo ENOENT
  would re-queue tasks that deserve to fail, so misses are preferred to
  misfires.

**Acceptance criteria**:
- AC-13 (failure): GIVEN a running worker whose tool output contains
  `bwrap: No permissions to create a new namespace` WHEN the trace scanner runs
  THEN `worker.bwrapRetryPending` is set, the session is aborted, and
  `updateWorker` is NOT called with `status: 'failed'`.
- AC-14: GIVEN the session restarted by AC-13 THEN its invocation session id
  differs from the aborted one and the worktree still exists.
- AC-15: GIVEN a worker whose errored tool output contains
  `ENOENT: no such file or directory, open '/home/u/.npmrc'` WHEN the scanner
  runs THEN a `sandbox_mount_gap` trace is emitted, a
  `sandbox_mount_gap_suspected` milestone is recorded, the session is not
  aborted, and the cached bwrap support value is unchanged.
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
`parseExtraMounts()` (`bwrap-mount-allowlist.ts`).

**Invariants**:
- **R-23**: A relative path, or an entry whose trailing `:`-segment is neither
  `ro` nor `rw`, is skipped with a warning naming the entry. Malformed input MUST
  NOT be fatal and MUST NOT silently become a mount.
- **R-24**: The mode defaults to `ro` when omitted. Only a trailing `:ro` /
  `:rw` is read as a mode, so absolute paths containing colons survive parsing.
- **R-25**: Extra mounts are additive only. `buildWorkerBwrapArgv()` assembles
  the built-in binds first and rejects, with a warning, any operator entry
  whose path equals a built-in, whatever mode it names. An extra entry cannot
  change a built-in bind's mode (see **Verification gaps** item 4).

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
- Table + argv builder: `apps/runner/src/bwrap-mount-allowlist.ts`:
  `SYSTEM_RO_BINDS`, `isMountAllowlistEnabled()`, `shouldWrapWorkerInBwrap()`,
  `parseExtraMounts()`, `parentDirs()`, `buildWorkerBwrapArgv()`,
  `createBwrapSpawn()`
- Call site + lifecycle: `apps/runner/src/workers.ts`: `isBwrapSupported()`,
  `isMountIsolationBwrapSupported()`, `getBwrapProbeAt()`, the boot probe in
  the `WorkerManager` constructor, the heartbeat's `sandboxEnabled`, and in
  `startSession`: SDK sandbox and env-scrub forcing, argv assembly,
  `spawnClaudeCodeProcess` wiring, the `bwrapRetryPending` restart, the
  `sandboxMountGap` field on the abort PATCH; the tool-result error-trace
  handling for runtime denial and gap annotation
- Capability probes: `apps/runner/src/env-scan.ts`: `probeBwrapNamespaces()`,
  `checkBwrapSupport()`, `checkBwrapMountIsolationSupport()`, capability
  advertisement in `scanEnvironment()`; operator check:
  `apps/runner/src/doctor.ts`: `checkBwrap()`
- Detection patterns: `apps/runner/src/error-trace-scanner.ts`
  (`bwrap_namespace_denied`, `sandbox_mount_gap`, `extractMountGapPath()`,
  `isMountGapCandidate()`)
- Application-layer complement: `apps/runner/src/read-jail.ts`:
  `buildReadJailDeniedPrefixes()`
- Codex interaction: `apps/runner/src/backends/codex-backend.ts`:
  `mapSandboxMode()`; `apps/runner/src/backends/types.ts`: `bwrapSupported`
- Worker flags: `apps/runner/src/types.ts`: `sandboxMountGap`,
  `bwrapRetryPending`
- Control plane: `apps/web/src/app/api/workers/[id]/route.ts`:
  `isSandboxMountGap` classification and re-queue with budget precedence
  (`sandboxGapMissionExhausted`); `apps/web/src/lib/worker-exit-taxonomy.ts`;
  `apps/web/src/lib/runner-heartbeats-shared.ts`: `sandboxEnabled`,
  `sandboxProbeAt`, `deriveSandboxPosture()`
- Capability constant: `packages/shared/src/types.ts`:
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
- **The Codex `sandboxMode` mapping** (`read-only` vs `workspace-write`):
  `docs/specs/codex-backend-spec.md`. This spec covers only the
  `bwrapSupported=false` downgrade as an observable consequence.
- **The Claude Code SDK's own inner bwrap sandbox** (`gitConfig.sandbox`) beyond
  the fact that the runner force-disables it when namespaces are unavailable.
  Its internal mount table is not ours.
- **Landlock LSM** as a replacement or complement.
- **Per-workspace mount tables from the dashboard.** Mount configuration is
  operator-scoped env only.

---

## Verification gaps

Unguarded claims and known drift. Each is a real hole, listed so a regression in
it is recognisable rather than discovered.

1. **FIXED** — **No CI test proved any denial.** The namespace tests in
   `apps/runner/src/__tests__/mount-isolation.e2e.ts` (sibling worktree, runner
   coordination key, the non-active backend's credential dir) were collected by
   no glob, and once a CI job ran them they skipped every time: the capability
   probe bound only `/usr`, so on a merged-usr host the ELF loader was missing
   and exec failed ENOENT, which read as "namespaces denied". The probe now
   binds the loader dirs and the CI job fails on a skip. The same job runs the
   Quality Scout probe sandbox suite (`scout-sandbox.e2e.ts`). R-8 is still
   asserted by absence from a snapshot, not by a failed read.
2. **FIXED** — The wrapper is never exercised for Codex, but the code pretends otherwise.**
   `buildWorkerBwrapArgv()` has a full Codex branch (R-4) with its own snapshot
   test, yet `startSession` in `workers.ts` gated the wrapper on `!isCodexTask`. No production
   path passes a Codex config to the builder. Either the Codex branch is dead
   code or the gate is an unfinished rollout; the snapshot makes it look shipped.

   Closed here: the gate is a tested predicate (`shouldWrapWorkerInBwrap`) and nothing is built for Codex. Its snapshot pinned argv nobody used; replaced with assertions on the split the acceptance probe depends on.

3. **FIXED** — The capability probe is stricter than the wrapper it gates.**
   `checkBwrapSupport()` requires `--unshare-user --unshare-pid --unshare-net`
   to succeed because it mirrors Claude Code's *inner*
   sandbox. The outer wrapper never unshares the network. A host that permits
   user and PID namespaces but denies network namespaces therefore reports
   `bwrapSupported: false` and gives up a mount boundary that would have worked.
   No test covers this combination.

   Closed here: probes are per consumer. The strict user+pid+net probe still gates the inner sandbox and env scrubbing; a user+pid probe gates mount isolation, which is what the outer argv actually needs.

4. **FIXED**: `BUILDD_MOUNT_ALLOWLIST_EXTRA` can widen the base table (R-25).** Dedupe is
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

5. **The rw `.git` bind (R-2) is a real residual exposure.** The parent clone's
   `.git` must be writable for commit and push, which means the agent's writable
   view includes git's own configuration and hook directory — content that the
   runner later executes *outside* the namespace during ordinary git operations.
   Nothing in the runner validates `.git/hooks` or `.git/config` between
   sessions. Accepted deliberately (per-worker clones were rejected on cost), but
   it is the narrowest remaining path from inside the sandbox to host execution
   and it deserves a hook-integrity check.
6. **FIXED** — The health surface reports the wrong thing.** `sandboxEnabled` on the
   heartbeat is `isBwrapSupported()` — kernel capability — not whether the mount
   allowlist is active. Since R-13 is default-off, a runner can display
   "sandbox ok" while running agents with no outer namespace at all. Similarly
   `checkBwrap()` in `doctor.ts` returns status **ok** with "bwrap not
   installed — sandboxing disabled (expected)". That doctor message is still
   true today. Nothing in CI asserts these two surfaces
   agree with `isMountAllowlistEnabled()`.

   Closed here: the `sandbox:mount-allowlist` capability is advertised only when the opt-in is set AND the probe passes, and a derived posture drives the badge. Green now means enforced; bwrap-present-allowlist-off renders `mounts unrestricted` as a warning. Still open by choice: the Health problems panel does not COUNT a degraded runner, because with the allowlist default-off that would flag every runner today.

7. **No host prerequisite is installed or checked at install time.**
   `apps/runner/install.sh` never mentions bubblewrap; the only mentions in the
   repo are the probe, the e2e suite, and the design doc. A fresh runner is
   unsandboxed by default and nothing during installation says so.
8. **The degradation in R-19 is untested as a security event.** Tests cover that the
   retry happens and that the task is not failed
   (`bwrap-runtime-recovery.test.ts`); nothing asserts that the resulting
   unsandboxed run is recorded anywhere an operator would notice beyond a log
   line and a milestone.
9. **The warning path in R-9 is asserted only indirectly.** The unit tests exercise
   `pathExists` returning false for one file; no test asserts the warning text
   or that a dropped *required* mount (for example a credential dir) is what
   later produces `sandbox_mount_gap`.
10. **Mount-gap recovery is off.** R-20 is annotate-only, so a real mount gap
   no longer re-queues the task; it fails through the normal path when the
   agent's own commands keep failing. R-21 and AC-16/AC-17 describe the control
   plane's handling, which stays wired but is not reached while the runner
   never sets `sandboxMountGap`.

---

## Renumbered

- WS-n to R-n for every n (WS-1 to R-1 ... WS-25 to R-25), so the invariants
  parse as gradable requirements.
- WS-7 and AC-4 (both retired with the code graph) no longer carry an id.
