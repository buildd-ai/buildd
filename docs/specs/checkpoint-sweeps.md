---
title: Checkpoint Sweeps and Edit-Claim Enforcement
status: active
owner: max
last_verified: 2026-10-01
summary: Runners MUST sweep worktree changes against the resolved PR base at checkpoints and offer them for exclusive acquisition; under enforcement a confirmed collision MUST deny or defer.
domain: runners
surfaces: [apps/runner/src/path-claim-enforcement.ts, apps/runner/src/path-collision-defer.ts, apps/runner/src/hook-factory.ts, apps/web/src/lib/path-collision-deferral.ts]
related: [path-claim-ownership, worker-sandbox-isolation]
keywords: [pathClaimEnforcement, enforce, advisory, PreToolUse, checkpoint, sweep, untracked, Bash writes, codex, deferred]
verified_by: [apps/runner/__tests__/unit/path-claim-enforcement.test.ts, apps/runner/__tests__/unit/path-claim-hook.test.ts, apps/runner/__tests__/unit/path-collision-defer.test.ts, apps/runner/__tests__/unit/worker-sync-path-sweep.test.ts]
supersedes: []
---
# Checkpoint Sweeps and Edit-Claim Enforcement

**Capability statement**: At sync, pre-push and completion a runner MUST
collect every changed path in the task's worktree (committed since the PR base,
staged, unstaged and untracked) and offer it to exclusive acquisition. Sweeps
are always on. Denial and collision deferral apply only when the workspace sets
`pathClaimEnforcement` to `enforce`; any other value is advisory.

**Invariants**:

- Tool paths are normalized relative to the worktree (`normalizeWorktreePath`).
  Home-relative, parent-escaping, absolute-outside and symlink-escaping paths
  are never claimed, and are denied in enforce mode.
- In enforce mode a confirmed live holder denies Edit, Write and MultiEdit and
  names the blocking task and path.
- The hook is bounded by `PATH_CLAIM_HOOK_DEADLINE_MS`. A timeout, network
  error or server error allows the edit, queues the path (at most
  `MAX_PENDING_PATHS`) and records degraded enforcement. A denied path is never
  cleared as acquired.
- `sweepWorktreeChanges` unions committed changes since the merge base with
  the PR base (both sides of renames, deletes, new files) with NUL-delimited
  status output including untracked files, minus `RUNTIME_EXCLUSIONS`.
- `resolvePrBaseRef` never falls back to trunk: a mission task whose base
  cannot be named sweeps no committed changes and reports the base unresolved.
- On a collision in enforce mode the runner stops further edits and ship
  commands, writes a checkpoint commit (with a fallback identity when none is
  configured), reports a deferral and ends the session. The server requeues the
  task without charging a retry. No agent waits for a lease.
- A backend without a pre-write seam is told at session start that only
  checkpoint enforcement applies (`describeEnforcement`).

**Acceptance criteria**:

- AC-1: GIVEN enforce mode and a path held by another live task WHEN the agent
  edits it THEN the edit is denied and the message names the holder.
- AC-2: GIVEN the coordination service does not answer within the hook
  deadline WHEN the agent edits a path THEN the edit proceeds and the path is
  queued, not dropped.
- AC-3: GIVEN an untracked file written by a shell command WHEN a checkpoint
  sweep runs THEN the file is in the swept set.
- AC-4: GIVEN a mission task whose PR base cannot be resolved WHEN a sweep
  runs THEN no trunk-history file is offered for lease.
- AC-5: GIVEN enforce mode and a swept path held by another task WHEN the
  checkpoint runs THEN the session ends with a deferral and a checkpoint commit.
- AC-6: GIVEN advisory mode WHEN the same collision is found THEN the edit is
  not denied.

**Code surface**:

- `apps/runner/src/path-claim-enforcement.ts`: `resolvePathClaimMode`,
  `backendEnforcement`, `describeEnforcement`, `normalizeWorktreePath`,
  `sweepWorktreeChanges`, `resolvePrBaseRef`, `refreshBaseRef`.
- `apps/runner/src/path-collision-defer.ts`: `runCheckpointSweep`,
  `writeCollisionCheckpoint`, `deferOnPathCollision`.
- `apps/runner/src/hook-factory.ts`: `PATH_CLAIM_HOOK_DEADLINE_MS`,
  `denyPreToolUse`.
- Server: `apps/web/src/lib/path-collision-deferral.ts`
  (`parsePathCollision`, `recordPathCollisionDeferral`), reached through
  `/api/workers/[id]`; the mode is validated at `/api/workspaces/[id]`.

**Out of scope**: filesystem-level interception (arbitrary shell or Codex
writes are detected after they happen, not denied before); keeping an agent
alive waiting for a lease.
