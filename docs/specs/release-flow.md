---
title: Release Flow
status: active
owner: max
last_verified: 2026-10-23
summary: The release system MUST resolve a workspace's declared release strategy, execute it through the matching dispatcher, verify the resulting deploy, and record the outcome while leaving prodBranch deployable.
domain: releases
surfaces: [apps/web/src/lib/release-executor.ts, packages/core/release-strategy.ts, apps/web/src/app/api/releases/trigger/route.ts, apps/web/src/app/api/releases/status/route.ts]
related: [db-migration-gates, webhook-dataflow]
keywords: [trigger_release, release_status, workflow_dispatch, branch_merge, prodbranch, releaseresult, release candidate, release/v]
verified_by: [apps/web/src/lib/release-candidate-ci.test.ts, apps/web/src/lib/ci-failure-retry.release-candidate.test.ts, apps/web/src/lib/release/record.test.ts, apps/web/src/lib/release/candidate-amend.test.ts, apps/web/src/lib/workflow-dispatch-inputs.test.ts, apps/web/src/app/api/workspaces/[id]/config/route.test.ts, packages/core/__tests__/release-strategy.test.ts, packages/core/__tests__/release-compose.test.ts, apps/web/src/lib/release/compose-actions.test.ts, scripts/release-candidate.test.ts, packages/core/__tests__/release-candidate.test.ts, apps/web/src/lib/workflow/review-composition.test.ts, apps/web/src/lib/workflow/candidate-review.test.ts, apps/web/src/lib/pr-landing.test.ts, apps/web/src/lib/reviewer.test.ts, apps/web/src/lib/release-executor.test.ts]
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
  - id: candidate-review-scope
    type: symbol
    name: candidateReviewScope
    path: apps/web/src/lib/workflow/candidate-review.ts
  - id: release-compose-route
    type: route
    method: POST
    path: /api/releases/compose
    file: apps/web/src/app/api/releases/compose/route.ts
  - id: plan-composition
    type: symbol
    name: planComposition
    path: packages/core/release-compose.ts
supersedes: []
---
# Release Flow

**Capability statement**: The buildd release system MUST resolve a workspace's
declared release strategy, execute it via the appropriate dispatcher (GitHub
workflow dispatch, branch merge, or script), verify the resulting deploy, and
record the outcome, leaving `main` (or the configured `prodBranch`) always in a
deployable state.

---

## Strategy Resolution

**Invariants**:
- A workspace with no `releaseConfig` or `releaseConfig.enabled = false` MUST
  resolve to `not_configured` / `disabled` and never attempt a release.
- Strategy defaults to `branch_merge` when `releaseConfig.strategy` is absent
  (legacy workspaces).
- `workflow_dispatch` requires both `workflowFile` and `ref`; missing either
  MUST produce `reason: 'invalid'` from `resolveReleaseStrategy`.
- `branch_merge` requires `prodBranch`; missing it MUST produce
  `reason: 'invalid'`.
- `script` strategy requires `command`; missing it MUST produce
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
- Resolver: `packages/core/release-strategy.ts`: `resolveReleaseStrategy()`,
  `effectiveStrategy()`
- Schema types: `packages/core/db/schema.ts`: `WorkspaceReleaseConfig`,
  `ReleaseStrategy`

---

## `workflow_dispatch` path

**Capability statement**: For `workflow_dispatch` workspaces, `trigger_release`
MUST dispatch the repo's GitHub Actions workflow and read back the run ID, status,
and URL.

**Invariants**:
- The dispatch uses the buildd GitHub App installation token (not a personal
  token).
- Dispatching opens the release PR; it does NOT itself deploy. Production ships
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
- A release candidate gets **no aggregate review**. Since it has no kernel
  delivery, the landing gate attests its composition at its exact head before
  any reviewer is asked (`candidateReviewScope`). Its review scope is only the
  landed changes with no approved reviewed patch: direct commits on
  `sourceBranch`, any release-only change beyond the version + CHANGELOG
  commit, and patches that differ from their approved head. Empty: no
  reviewer at all, the attestation is the review. Not empty: one reviewer over
  exactly those commits, told to read each one, never the full candidate diff.
  Unreadable: the full review, as before.
- Also covered: a PR merged with a merge commit (the merge, against its first
  parent, must equal the approved head's change; the PR's own commits must be
  on that head), and `prodBranch` merged back into `sourceBranch` after a
  release when it brings only CHANGELOG and `"version"` lines. An aggregate
  diff past GitHub's 300-file cap is not a reason to review in full: the
  complete commit list stands in for it.
- Size cap and workspace path classes (e.g. destructive schema changes) are
  judged on the delta only, at dispatch and at the verdict
  (`scopeToCompositionDelta`): a constituent reviewed on its own PR never
  escalates the candidate. The migration inspector at merge, CI, `release
  candidate verified` and branch protection are unchanged.
- An amendment makes a new candidate SHA whose metadata names it, so the new
  head is composed afresh; only the amendment's new commits can add delta.
- A candidate workspace's releases are `gated`: a successful release workflow
  run moves its row to `pending_external` (the PR is open), never to
  `deploying`. Only a merge into `prodBranch` whose head contains the row's sha
  advances it, re-pointed at the merge commit, and only deploy verification of
  that sha makes it `healthy`. A row for a `sourceBranch` commit that landed
  after the cut is not contained by the candidate and stays in flight.
- The stale-row heal searches merged PRs into `prodBranch` whose head is a
  candidate branch (or the legacy head), since a candidate's head is not
  `ref`.
- A red candidate is never repaired on its branch. The CI doors (check-suite
  webhook, red-PR sweep, manual Fix CI) ask `classifyCiRedReleasePr` before
  any CI fix and before the kernel door. A trusted candidate at its recorded
  head gets one fix task per head, based on `sourceBranch` and bound to no PR;
  once that fix merges the candidate is amended through the declared amend
  contract, or the team is told it needs a re-cut. A candidate-shaped PR that is not provably one gets nothing filed.
  The manual Fix CI is refused for both.
- `trigger_release` dedupes a dispatch against an in-flight release for the
  same source commit, except an amendment (`amend` or `exclude` input set, or
  an automatic amendment through the declared contract): a plain dispatch
  leaves an open candidate unchanged, so an amendment is never a repeat of it.
- buildd moves a candidate only through an amend contract the workspace
  declared: `releaseConfig.candidate.amend = { mode: 'inputs', versionInput,
  confirmInput? }` (dispatch the release workflow with those inputs set to the
  candidate's version) or `{ mode: 'redispatch' }` (dispatch it with its
  ordinary inputs; the team's pipeline re-cuts). `workflow_dispatch` only. No
  default and no inference from the workflow's input names: buildd's own
  workspace declares `{ mode: 'inputs', versionInput: 'amend', confirmInput:
  'amend_confirm' }` explicitly. The declaration lives in workspace config, next
  to the trust policy (`authors`, `branches`), because a repo-editable file
  would let any PR author change what buildd dispatches. Whether the workflow
  can carry it out is read from the workflow file's
  `on.workflow_dispatch.inputs` at `ref`: on save (a mapping the file does not
  declare, or a file that cannot be read, is refused) and again before every
  dispatch, so the config cannot drift from the workflow silently.
- When the fix for a red candidate merges into `sourceBranch` and the contract
  holds at `ref`, the amendment is dispatched automatically and the candidate
  is commented. Without a contract, or when the workflow at `ref` no longer
  declares its inputs (or cannot be read), nothing is dispatched: the
  candidate PR gets a comment, the fix task an open note, and the team a
  needs-attention alert, each saying the fix merged, the candidate needs a
  re-cut or amend by the team's pipeline, and what was checked. Neither a
  silent skip nor a failed task. Once per fix PR (a marker on the fix task, handed back if the
  dispatch fails). A candidate that is closed, or whose head is no longer the
  one the fix was filed for, is left alone. A merge found by reconciliation
  rather than the webhook amends the same way: the base is read from the fix
  PR on GitHub. Both context keys (`releaseCandidateFix` on the fix task and
  the amendment marker) are server-owned: a caller's copy is dropped on every
  task-create path.
- A release candidate has **no kernel delivery, by design**. The kernel's
  deliveries exist to drive a PR's own head forward: repair pushes, CI retries
  on its branch, review-fix rounds. A candidate's head is frozen to the SHA its
  metadata records, so every one of those is a move the candidate must not
  make. Its gates are not the kernel's: composition covers review, `candidate
  integration` runs CI on the exact head SHA, and `release candidate verified`
  gates the merge. A failure is answered on `sourceBranch` and a re-cut, never
  on the candidate. Do not open a delivery for a trusted candidate.

**Acceptance criteria**:
- AC-12: GIVEN `candidate.branches = ['release/v*']` WHEN `github-actions[bot]`
  opens `release/v1.2.3` → `main` with metadata naming its head THEN
  `classifyReleasePr` returns `kind: 'candidate'` with constituent base
  `sourceBranch`.
- AC-13: GIVEN the same PR opened by another account, from a fork, without
  metadata, or after a push moved its head THEN it is `kind: 'none'` and gets
  the full review and the aggregate size cap.
- AC-14: GIVEN a candidate whose every commit is an approved dev PR (squashed
  or merged with a merge commit) plus the version commit and any version-only
  merge of `prodBranch` back into `sourceBranch`, at any diff size, WHEN the
  landing gate reaches review THEN its head is covered by composition and no
  reviewer is dispatched; a migration still meets the migration inspector at
  merge.
- AC-25: GIVEN a fully composed candidate WHEN it is amended THEN the new head
  is composed afresh and, with no new uncovered commit, no reviewer is
  dispatched for it either.
- AC-26: GIVEN a candidate with N direct commits on `sourceBranch` (no PR)
  THEN exactly one reviewer is dispatched, scoped to exactly those N commits
  and their paths, and the size cap and path classes are judged on that delta
  alone.
- AC-27: GIVEN a constituent touching `packages/core/drizzle/` that was
  approved on its own PR THEN it does not escalate the candidate, while a
  migration inside the delta still does.

- AC-19: GIVEN a trusted candidate whose CI is red at its recorded head WHEN
  the check-suite webhook or the red-PR sweep reports it THEN one fix task is
  filed with `baseBranch = sourceBranch` and no PR binding, the gate records
  `release_candidate`, and no head-branch CI attempt or kernel observation
  happens; a second report on the same head files nothing.
- AC-20: GIVEN an in-flight release row for dev commit X WHEN `trigger_release`
  is called for X with `inputs.amend` (or `inputs.exclude`) set THEN the
  workflow is dispatched and the row re-armed, not reported as deduped.
- AC-21: GIVEN the fix task for a red candidate WHEN its PR merges into
  `sourceBranch` THEN the release workflow is dispatched once with
  `amend = amend_confirm = <version>` and the candidate is commented; a
  redelivery, a closed candidate, or a candidate already amended dispatches
  nothing, and a failed dispatch hands the marker back so a retry can amend.
  A merge reported without a webhook delivery reads the fix PR's base from
  GitHub and amends the same way. This requires the declared contract: the
  workflow is dispatched with the contract's `versionInput` (and
  `confirmInput`) set to `<version>`, after the workflow file at `ref` was read
  and found to declare them.
- AC-22: GIVEN a candidate workspace with no `candidate.amend` (or a strategy
  other than `workflow_dispatch`) WHEN the fix PR for its red candidate merges
  THEN nothing is dispatched, and the candidate PR, the fix task and the team
  are told the fix merged and the candidate needs a re-cut or amend by their
  pipeline, naming what was checked; a redelivery posts nothing again.
- AC-23: GIVEN `candidate.amend` maps inputs the workflow file at `ref` does
  not declare (or the file cannot be read) WHEN the config is saved THEN the
  save is refused 422 naming the missing inputs; and WHEN the workflow loses
  them after a valid save THEN the fix merging dispatches nothing and posts
  the re-cut notice of AC-22.
- AC-24: GIVEN buildd's own workspace with `candidate.amend = { mode: 'inputs',
  versionInput: 'amend', confirmInput: 'amend_confirm' }` and its
  `release.yml` WHEN a red candidate's fix merges THEN the dispatch is the same
  as before the contract existed: `amend = amend_confirm = <version>`, once,
  with the candidate commented.

**Code surface**:
- Policy and classifier: `packages/core/release-candidate.ts`:
  `classifyReleasePr()`, `releaseCandidatePolicy()`, `hasReleasePrShape()`
- Red candidate CI: `apps/web/src/lib/release-candidate-ci.ts`:
  `classifyCiRedReleasePr()`, `buildReleaseCandidateFixTask()`; doors
  `apps/web/src/lib/ci-failure-retry.ts`,
  `apps/web/src/app/api/prs/[prNumber]/retry-ci/route.ts`
- Auto-amend: `apps/web/src/lib/release/candidate-amend.ts`:
  `amendCandidateOnFixMerge()`; subscriber `release-candidate-amend-on-fix`
  in `apps/web/src/lib/release/subscribers.ts`
- Amend contract: `packages/core/release-config-shape.ts`:
  `amendContractShapeError()`, `amendContractCapabilityError()`,
  `amendDispatchInputs()`; workflow inputs read from the file at `ref`:
  `apps/web/src/lib/workflow-dispatch-inputs.ts`:
  `readWorkflowDispatchInputs()`
- Amendment dedup: `apps/web/src/lib/release/record.ts`: `isAmendmentDispatch()`
- Composition: `apps/web/src/lib/workflow/review-composition.ts`:
  `compositionConstituentBase()`, `isReleaseArtifactMerge()`; write site
  `review-effects.ts` (kernel PRs)
- Candidate review scope: `apps/web/src/lib/workflow/candidate-review.ts`:
  `candidateReviewScope()`; asked by the landing gate
  (`apps/web/src/lib/pr-landing.ts`, agent-review step); delta reviewer through
  `apps/web/src/lib/stale-approval-re-review.ts`; verdict-time scope
  `scopeToCompositionDelta()` in `apps/web/src/lib/reviewer.ts`
- Merge gate: `apps/web/src/lib/auto-merge.ts`
- Tracking: `packages/core/release-archetype.ts`,
  `apps/web/src/lib/release/gated-merge.ts`,
  `apps/web/src/app/api/cron/release-health-check/route.ts`
- Config: `apps/web/src/app/api/workspaces/[id]/config/route.ts`,
  workspace settings `ReleaseSection.tsx`

---

## Owner release flow: Compose → Cut → Review → Release

**Capability statement**: A team owner or admin of a candidate workspace MUST
be able to choose what a release ships, cut the frozen candidate, review its
checks on the exact candidate SHA, and release it, each step an explicit
button recorded with who pressed it and when (`release_flow_steps`). A release
MUST NOT read as done on PR open or merge: only when production reports a
deployed SHA that is, or descends from, the candidate's merge commit.

**Invariants**:
- Compose groups the source branch's first-parent PRs since `prodBranch` by
  mission (through the worker that owns each PR): "on dev" missions, open
  mission PRs into `sourceBranch` that are approved on their head with every
  check passing ("ready"), and PRs with no mission ("other changes"). Default:
  everything on dev in, ready missions out.
- Including a ready mission merges its mission PR through the dashboard's gated
  merge route, never a raw merge. Its refusal is the answer.
- Leaving out a change already on dev is a candidate amendment: the release
  engine (`scripts/release-candidate.ts exclude`) reverts that change's commit
  on the candidate branch only, which makes a new candidate SHA, dismisses
  approvals and voids checks. The owner reads that before confirming. A revert
  that does not apply cleanly changes nothing and names the conflicting files.
  A later `amend` keeps what was left out; sync-dev re-lands each left-out
  change on dev (reverting the revert, trailer `Release-Excluded`) after main
  merges back.
- A cut is refused when the source branch moved since the page was read.
- Review counts checks and approvals on the candidate SHA only; anything on an
  earlier SHA counts for nothing. Nothing in the flow approves a candidate.
- Release merges the candidate pinned to its SHA, only when every required
  check passed and an approval stands on that SHA; branch protection still
  applies.

**Acceptance criteria**:
- AC-15: GIVEN PRs on dev from two missions and one with no mission THEN
  Compose shows two "on dev" missions and one "other change", all selected,
  and an approved green mission PR as "ready", unselected.
- AC-16: GIVEN a ready mission WHEN the owner presses Include THEN the mission
  PR goes through `POST /api/prs/[n]/merge` and no other merge is attempted.
- AC-17: GIVEN an open candidate WHEN the owner leaves a mission out THEN the
  candidate branch gets a new SHA without that mission's changes, `dev` is
  unchanged, approvals on the old SHA are dismissed, and an approval or check
  on the old SHA no longer enables Release.
- AC-18: GIVEN a merged candidate WHEN production reports a SHA that does not
  contain the merge commit (or none) THEN "Mark released" is refused and
  recorded as refused.

**Code surface**:
- Decisions: `packages/core/release-compose.ts`
- Engine: `scripts/release-candidate.ts` (`exclude`), `.github/workflows/release.yml`,
  `.github/workflows/sync-dev.yml`
- Reads and buttons: `apps/web/src/lib/release/compose-source.ts`,
  `apps/web/src/lib/release/compose-actions.ts`, `POST /api/releases/compose`
- Page: `apps/web/src/app/app/(protected)/releases/compose/`

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
- Post-deploy hook failures do NOT roll back the release; the outcome records
  each hook's success/error.
- `tasks.releaseResult` MUST be written on every terminal path
  (`completed | failed | skipped | not_configured`). A release PR whose CI is
  not green yet records `pending_ci`, and the webhook completes or fails the
  task later.
- `main` (prodBranch) MUST be deployable after a `completed` release. A
  worker PR is squash-merged pinned to its head (`mergeReleasePrPinned`).
  With no PR, the branch merges through `POST /repos/{repo}/merges`, which
  creates a merge commit and is refused with a 409 on a conflict, leaving
  `prodBranch` unchanged.

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
  called THEN it returns immediately with `status: 'not_configured'`; the task
  still completes normally.

**Code surface**:
- Executor: `apps/web/src/lib/release-executor.ts`
- Vercel polling: `pollVercelDeployment()` in the same file
- Schema: `packages/core/db/schema.ts`: `ReleaseResult`, `WorkspaceReleaseConfig`

---

## Release invariant: `main` is always deployable

**Invariants**:
- No direct commits to `main` outside the release path (convention enforced by
  branch protection, not code).
- A release failure MUST NOT leave `main` in a partial state: the GitHub API
  merge is atomic; if it fails the branch is unchanged.
- `release_status` MUST be callable at any time without side effects (read-only).

**Out of scope**: The `script` strategy execution (resolved and validated by
`resolveReleaseStrategy`, but `trigger_release` answers 501 "not yet
implemented"). Version bumping and changelog generation (handled by the repo's own
release workflow, not buildd). Rollback mechanics.

## Renumbered

Release candidate criteria AC-C1 to AC-C3 became AC-12 to AC-14. Owner
release flow criteria AC-F1 to AC-F4 became AC-15 to AC-18.
