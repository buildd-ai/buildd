---
title: Release Flow
status: active
owner: max
last_verified: 2026-10-12
summary: The release system MUST resolve a workspace's declared release strategy, execute it through the matching dispatcher, verify the resulting deploy, and record the outcome while leaving prodBranch deployable.
domain: releases
surfaces: [apps/web/src/lib/release-executor.ts, packages/core/release-strategy.ts, apps/web/src/app/api/releases/trigger/route.ts, apps/web/src/app/api/releases/status/route.ts]
related: [db-migration-gates, webhook-dataflow]
keywords: [trigger_release, release_status, workflow_dispatch, branch_merge, prodbranch, releaseresult, release candidate, release/v]
verified_by: [packages/core/__tests__/release-strategy.test.ts, packages/core/__tests__/release-candidate.test.ts, apps/web/src/lib/workflow/review-composition.test.ts, apps/web/src/lib/release-executor.test.ts]
assertions:
  - id: trigger-release-route
    type: route
    method: POST
    path: /api/releases/trigger
    file: apps/web/src/app/api/releases/trigger/route.ts
  - id: release-status-route
    type: route
    method: GET
    path: /api/releases/status
    file: apps/web/src/app/api/releases/status/route.ts
  - id: resolve-release-strategy
    type: symbol
    name: resolveReleaseStrategy
    path: packages/core/release-strategy.ts
  - id: effective-strategy
    type: symbol
    name: effectiveStrategy
    path: packages/core/release-strategy.ts
  - id: classify-release-pr
    type: symbol
    name: classifyReleasePr
    path: packages/core/release-candidate.ts
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
- The source ref's CI state (`ciState`) MUST ignore advisory post-merge
  integration check-runs (name prefix `post-merge integration`, from
  `.github/workflows/post-merge-integration.yml`). They sit on every dev SHA,
  i.e. on the release PR head, and never gate a release; `release_status`
  reports them separately as `postMergeIntegration`, and the health watcher
  does not file CI-failing tasks for them.
- Post-merge integration MUST be incremental against evidence, not against
  `prodBranch`: a dev push is tested when server, runner or job-definition
  code changed since the newest dev ancestor whose integration run actually
  passed (`scripts/ci/post-merge-coverage.ts`). A run that failed, was
  cancelled or was skipped is never that base, a push dev has already moved
  past defers to the newer run, and missing evidence means test. A skipped
  post-merge run is reported as `skipped`, never `passing`.
- A release candidate PR (`release/vX.Y.Z` → `prodBranch`) MUST get its own
  full API + runner integration run on its exact head SHA (check
  `candidate integration / integration`, from `build.yml`). It is not
  advisory: it counts toward `ciState`, and only a `success` conclusion counts
  as passing (skipped, neutral and cancelled are failing). A green from any
  other SHA, including the dev SHA it was cut from, is not evidence for it.
  It is the only job that tests a candidate; `release candidate verified`
  (also `build.yml`, reported on every PR into `prodBranch`) aggregates it
  with the candidate's shape check and is the check to require on main.

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

## Release candidate recognition

**Capability statement**: buildd MUST treat a PR into `prodBranch` as the
workspace's frozen release candidate only when the workspace declares one
(`releaseConfig.candidate`) and the PR proves it was opened by the release
workflow at the head it records. Recognition narrows review to what the
candidate's PRs did not already cover; it never relaxes CI, branch protection,
path escalation or the migration inspector.

**Invariants**:
- `releaseConfig.candidate = { branches, sourceBranch, authors }` has no
  defaults. Absent, or with any field empty, no PR is a candidate. A branch
  pattern is an exact ref or a path prefix ending in `*`; a pattern matching
  `prodBranch` or `sourceBranch` is refused on save.
- `ref` stays the ref `workflow_dispatch` runs on. It is never read as the
  candidate branch or the candidate source.
- A PR is a candidate only when all hold: base is `prodBranch`; head matches a
  pattern; head repo is the base repo; author is in `authors`; the body carries
  the `<!-- release-candidate {...} -->` metadata naming this branch,
  `prodBranch` and `sourceBranch`; and the metadata's `candidateSha` is the PR's
  current head. A push that did not go through the workflow's explicit
  amendment leaves `candidateSha` stale, and the PR reviews in full.
- The legacy `releaseBranch` → `prodBranch` PR is still recognised by refs
  alone.
- Composition review of a candidate looks up constituent PRs merged into
  `sourceBranch` (never into the candidate branch), and proves each landed
  patch equals its approved reviewed head. The single release-only commit
  (version bump + CHANGELOG) is a release artifact. Anything else (a
  release-only change, an unapproved PR, a direct commit) is a novel delta
  that gets its own review.
- A candidate workspace's releases are `gated`: a successful release workflow
  run moves its row to `pending_external` (the PR is open), never to
  `deploying`. Only a merge into `prodBranch` whose head contains the row's sha
  advances it, re-pointed at the merge commit, and only deploy verification of
  that sha makes it `healthy`. A row for a `sourceBranch` commit that landed
  after the cut is not contained by the candidate and stays in flight.
- The stale-row heal searches merged PRs into `prodBranch` whose head is a
  candidate branch (or the legacy head), since a candidate's head is not
  `ref`.

**Acceptance criteria**:
- AC-C1: GIVEN `candidate.branches = ['release/v*']` WHEN `github-actions[bot]`
  opens `release/v1.2.3` → `main` with metadata naming its head THEN
  `classifyReleasePr` returns `kind: 'candidate'` with constituent base
  `sourceBranch`.
- AC-C2: GIVEN the same PR opened by another account, from a fork, without
  metadata, or after a push moved its head THEN it is `kind: 'none'` and gets
  the full review and the aggregate size cap.
- AC-C3: GIVEN a candidate whose every commit is an approved dev PR plus the
  version commit THEN its head is covered by composition and no aggregate
  reviewer is dispatched; a migration still meets the migration inspector at
  merge.

**Code surface**:
- Policy and classifier: `packages/core/release-candidate.ts` —
  `classifyReleasePr()`, `releaseCandidatePolicy()`, `hasReleasePrShape()`
- Composition: `apps/web/src/lib/workflow/review-composition.ts` —
  `compositionConstituentBase()`; write site `review-effects.ts`
- Merge gate: `apps/web/src/lib/auto-merge.ts`
- Tracking: `packages/core/release-archetype.ts`,
  `apps/web/src/lib/release/gated-merge.ts`,
  `apps/web/src/app/api/cron/release-health-check/route.ts`
- Config: `apps/web/src/app/api/workspaces/[id]/config/route.ts`,
  workspace settings `ReleaseSection.tsx`

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
