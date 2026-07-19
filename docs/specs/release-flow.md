---
title: Release Flow
status: active
owner: max
last_verified: 2026-07-18
supersedes: []
---
# Release Flow

**Capability statement**: The buildd release system MUST resolve a workspace's
declared release strategy, execute it via the appropriate dispatcher (GitHub
workflow dispatch, branch merge, or script), verify the resulting deploy, and
record the outcome — leaving `main` (or the configured `prodBranch`) always in a
deployable state.

---

## Strategy Resolution

**Invariants**:
- A workspace with no `releaseConfig` or `releaseConfig.enabled = false` MUST
  resolve to `not_configured` / `disabled` and never attempt a release.
- Strategy defaults to `branch_merge` when `releaseConfig.strategy` is absent
  (legacy workspaces).
- `workflow_dispatch` requires both `workflowFile` and `ref` — missing either
  MUST produce `reason: 'invalid'` from `resolveReleaseStrategy`.
- `branch_merge` requires `prodBranch` — missing it MUST produce
  `reason: 'invalid'`.
- `script` strategy requires `command` — missing it MUST produce
  `reason: 'invalid'`.
- Per-call overrides (`ref`, `workflowFile`, `inputs`) refine the workspace
  config; they MUST NOT introduce a strategy of their own.

**Acceptance criteria**:
- AC-1: GIVEN a workspace with `releaseConfig.enabled = false` WHEN
  `resolveReleaseStrategy` is called THEN it returns
  `{ ok: false, reason: 'disabled' }`.
- AC-2: GIVEN `strategy: 'workflow_dispatch'` with no `workflowFile` WHEN
  `resolveReleaseStrategy` is called THEN it returns
  `{ ok: false, reason: 'invalid' }`.
- AC-3: GIVEN `strategy: 'branch_merge'` with `prodBranch: 'main'` WHEN
  `resolveReleaseStrategy` is called THEN it returns
  `{ ok: true, strategy: { kind: 'branch_merge', prodBranch: 'main' } }`.
- AC-4: GIVEN per-call `overrides.ref = 'hotfix'` on a `workflow_dispatch`
  workspace WHEN `resolveReleaseStrategy` is called THEN the resolved strategy
  carries `ref: 'hotfix'`, not the config's default ref.

**Code surface**:
- Resolver: `packages/core/release-strategy.ts` — `resolveReleaseStrategy()`,
  `effectiveStrategy()`
- Schema types: `packages/core/db/schema.ts` — `WorkspaceReleaseConfig`,
  `ReleaseStrategy`

---

## `workflow_dispatch` path

**Capability statement**: For `workflow_dispatch` workspaces, `trigger_release`
MUST dispatch the repo's GitHub Actions workflow and read back the run ID, status,
and URL.

**Invariants**:
- The dispatch uses the buildd GitHub App installation token (not a personal
  token).
- Dispatching opens the release PR — it does NOT itself deploy. Production ships
  only when that PR passes CI and merges.
- `force: true` folds into `inputs.force = 'true'`; it bypasses the empty-commit
  check, NOT CI.

**Acceptance criteria**:
- AC-5: GIVEN a properly configured `workflow_dispatch` workspace WHEN
  `trigger_release` is called THEN the response includes `runId` or `runsUrl`
  from the GitHub Actions API.
- AC-6: WHEN `release_status` is called before `trigger_release` THEN it returns
  commits ahead of `prodBranch`, CI status of the source ref, and whether a
  release PR is already open.
- AC-7: GIVEN `force: true` in the `trigger_release` params THEN the dispatched
  workflow inputs contain `force: "true"`.

**Code surface**:
- Trigger route: `apps/web/src/app/api/releases/trigger/route.ts`
- Status route: `apps/web/src/app/api/releases/status/route.ts`
- GitHub API wrapper: `apps/web/src/lib/github.ts`

---

## `branch_merge` path

**Capability statement**: For `branch_merge` workspaces, completing a task (or
calling `trigger_release`) MUST merge the configured source ref into `prodBranch`
via the GitHub API, poll Vercel for a terminal deployment state, run post-deploy
hooks, and record the full outcome in `tasks.releaseResult`.

**Invariants**:
- The merge MUST use the GitHub API (not `git push`) so the GitHub App token
  handles auth.
- Vercel polling MUST use a 5-minute timeout with 10-second intervals; states
  `READY`, `ERROR`, and `CANCELED` are terminal.
- Post-deploy hook failures do NOT roll back the release — the outcome records
  each hook's success/error.
- `tasks.releaseResult` MUST be written on every terminal path
  (`completed | failed | skipped | not_configured`).
- `main` (prodBranch) MUST be deployable after a `completed` release: only
  fast-forward merges are performed (GitHub API rejects non-FF merges by default).

**Acceptance criteria**:
- AC-8: GIVEN a successful `branch_merge` release WHEN the executor completes
  THEN `tasks.releaseResult.status = 'completed'` and `mergedAt` is set.
- AC-9: GIVEN `deployTarget.type = 'vercel'` and Vercel returns `state = 'ERROR'`
  THEN `tasks.releaseResult.deployState = 'ERROR'` and `status = 'failed'`.
- AC-10: GIVEN one post-deploy hook fails WHEN the executor finishes THEN
  `tasks.releaseResult.hooksRan` contains the failing entry with `success: false`
  AND `status` reflects overall release success (hook failures do not flip
  `status` to `failed` alone).
- AC-11: GIVEN a workspace with no `releaseConfig` WHEN `executeRelease` is
  called THEN it returns immediately with `status: 'not_configured'` — the task
  still completes normally.

**Code surface**:
- Executor: `apps/web/src/lib/release-executor.ts`
- Vercel polling: `pollVercelDeployment()` in the same file
- Schema: `packages/core/db/schema.ts` — `ReleaseResult`, `WorkspaceReleaseConfig`

---

## Release invariant: `main` is always deployable

**Invariants**:
- No direct commits to `main` outside the release path (convention enforced by
  branch protection, not code).
- A release failure MUST NOT leave `main` in a partial state — the GitHub API
  merge is atomic; if it fails the branch is unchanged.
- `release_status` MUST be callable at any time without side effects (read-only).

**Out of scope**: The `script` strategy execution (not yet implemented as of
2026-06-24). Version bumping and changelog generation (handled by the repo's own
release workflow, not buildd). Rollback mechanics.
