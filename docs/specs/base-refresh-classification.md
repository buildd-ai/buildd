---
title: Base Refresh Classification
status: active
owner: max
last_verified: 2026-10-01
summary: A behind-only PR MUST be refreshed agent-free via a head-pinned branch update; only a verified textual conflict dispatches a conflict agent, and an unknown semantic verdict never clears a merge.
domain: tasks
surfaces: [apps/web/src/lib/base-refresh.ts, apps/web/src/lib/pr-branch-update.ts, apps/web/src/lib/semantic-refresh.ts, apps/web/src/lib/conflict-retry.ts]
related: [surface-merge-ordering, pr-lifecycle-reconciliation]
keywords: [update-branch, expected_head_sha, behind, conflict agent, semanticRefresh, same_symbol, unknown, single-flight]
verified_by: [apps/web/src/lib/base-refresh.test.ts, apps/web/src/lib/semantic-refresh.test.ts, apps/web/src/lib/pr-branch-update.test.ts, apps/web/src/lib/conflict-retry.test.ts]
supersedes: []
---
# Base Refresh Classification

**Capability statement**: When a PR is behind its actual base (including a
mission integration branch), buildd MUST refresh it through the head-pinned
update-branch operation without an agent. It MUST classify every failure, and
dispatch the conflict agent only on a verified textual conflict.
Classification is on by default. The semantic check runs only when the
workspace sets `semanticRefresh` to `shadow` or `enforce` (default `off`).

**Invariants**:

- `classifyBranchUpdateFailure`: only the provider's merge-conflict refusal is
  a conflict. A moved head is re-read; "no new commits" is up to date; rate
  limits, auth, server and network errors, and unknown errors are deferred. An
  API error is never conflict evidence.
- At most `MAX_REFRESH_FAILURES` operational failures per PR head, then one
  diagnostic. A new head starts a fresh budget.
- Single-flight per task: a live refresh lease or a lost compare-and-set
  returns in-flight with no mutation.
- With the semantic check off, the clean path makes no symbol lookup, no model
  call and records no hold.
- A verified same-symbol overlap under enforce returns a semantic conflict
  (review, not refresh or merge). Shadow records a warning and refreshes.
- An unknown verdict never clears. Under enforce it defers up to
  `MAX_SEMANTIC_RECHECKS` per head, then reports unverified with a diagnostic,
  and never dispatches a textual-conflict agent.
- Every merge door calls `checkBaseRefreshHold`. A hold is keyed to a head, so
  a pushed fix supersedes it.
- The deployed symbol provider is `UNAVAILABLE_SYMBOL_PROVIDER`, so every
  shared-file refresh is unknown and nothing is semantically auto-cleared.

**Acceptance criteria**:

- AC-1: GIVEN a behind-only PR with disjoint changes WHEN it is refreshed THEN
  the branch is updated pinned to the evaluated head and no agent task is
  created.
- AC-2: GIVEN the update fails with a rate limit or network error WHEN it is
  classified THEN it is deferred and no conflict task is created.
- AC-3: GIVEN the provider reports a merge conflict WHEN it is classified THEN
  the conflict agent is dispatched.
- AC-4: GIVEN the head moved since evaluation WHEN the update is refused THEN
  no attempt is counted and the PR is re-read.
- AC-5: GIVEN enforce mode and an unknown semantic verdict WHEN the merge is
  evaluated THEN it is held, never cleared.
- AC-6: GIVEN repeated operational failures on one head WHEN the budget is
  spent THEN refresh stops for that head with one diagnostic.

**Code surface**:

- `apps/web/src/lib/base-refresh.ts`: `refreshBehindPr`,
  `checkBaseRefreshHold`, `postRefreshDiagnostic`.
- `apps/web/src/lib/pr-branch-update.ts`: `classifyBranchUpdateFailure`,
  `updateBehindPrBranch`.
- `apps/web/src/lib/semantic-refresh.ts`: `resolveSemanticRefreshMode`,
  `assessSemanticOverlap`, `getServerSymbolProvider`.
- `apps/web/src/lib/conflict-retry.ts`: `dispatchConflictRetry`. The
  `merge_pr` door at `/api/github/pr` reports a behind-base wait; the mode is
  validated at `/api/workspaces/[id]`.

**Out of scope**: rebasing or rewriting a shared branch; model-driven
resolution on a clean disjoint path; a revision-pinned server symbol index
(not deployed, so semantic auto-clearance stays effectively disabled).
