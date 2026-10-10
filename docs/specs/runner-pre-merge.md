---
title: Runner Pre-Merge, Derived Files and Mergiraf
status: active
owner: max
last_verified: 2026-10-10
summary: Before a conflict agent starts, the runner MUST merge the right base with derived-file and mergiraf drivers, MUST record every file mergiraf resolved, and MUST NOT push mergiraf's work without an agent.
domain: runners
surfaces: [apps/runner/src/merge-drivers.ts, apps/runner/src/workers.ts, apps/runner/src/hook-factory.ts, apps/web/src/lib/conflict-retry.ts]
related: [base-refresh-classification, live-sibling-conflict-probe, mission-task-lifecycle]
keywords: [derivedFiles, mergiraf, pre-merge, Pre-merge milestone, Merge milestone, merge driver, rerere, buildd-mergiraf-log, conflict retry, mission refresh, refreshTrunk, prBase, lockfile, no-agent finish, derived_merge]
verified_by: [apps/runner/__tests__/unit/merge-drivers.test.ts, apps/runner/__tests__/unit/mergiraf-ledger.test.ts, apps/web/src/lib/conflict-retry.test.ts, packages/core/__tests__/mcp-tools-get-task-milestones.test.ts, packages/core/__tests__/derived-files-detect.test.ts, apps/web/src/app/api/workspaces/[id]/route.test.ts]
supersedes: []
---

# Runner Pre-Merge, Derived Files and Mergiraf

Read this before changing how a runner merges a base branch, adding a merge
driver, or deciding whether a merge needs an agent. The server decides THAT a
conflict needs work (`base-refresh-classification`); this spec covers what the
runner does with it.

## Configuration

**Capability statement**: A workspace opts in per setting; with neither set, the
runner registers nothing and merges exactly as plain git.

**Invariants**:
- `gitConfig.derivedFiles` is a list of `{ glob, regenerate, strategy? }`. `strategy` is `ours` or `theirs` (default `theirs`, the incoming base).
- `normalizeDerivedFiles` (packages/shared) is the one rule set, read by the runner and enforced by the workspace PATCH route. A rule it would drop is a 400 at write time, never stored.
- A rule MUST NOT cover the whole tree (`**`, `*`, `/`) or a migration chain (drizzle, `migrations/`, `migrate/`, alembic, `versions/`, `*.sql`). Migration files and the drizzle journal are owned by the migration-collision renumber path, never regenerated.
- `gitConfig.mergiraf` is a boolean. The runner uses mergiraf only if it is enabled AND the binary is on PATH AND its path is shell-safe; otherwise it logs and skips it.
- There is no "keep both sides" rule (`merge=union`). On this repo, concatenating both sides duplicated changes the base already had more often than it was right.

**Acceptance criteria**:
- AC-1: WHEN PATCH sets `derivedFiles: [{ glob: "**", regenerate: "x" }]` THEN the route returns 400 and stores nothing.
- AC-2: WHEN PATCH sets a rule on `packages/core/drizzle/meta/_journal.json` THEN the route returns 400.
- AC-3: WHEN `mergiraf: true` and the binary is absent THEN no `merge.mergiraf.*` config and no mergiraf attribute line is written.
- AC-4: WHEN action=init scans a repo with a root `bun.lock` THEN it proposes `{ glob: "/bun.lock", regenerate: "bun install" }` and applies nothing.

## Driver registration

**Capability statement**: On every worker start in a configured workspace, the
runner registers drivers in its own clone, so the runner's merges and the
agent's own merges use them alike.

**Invariants**:
- Drivers live in the clone's `.git/config` and the common dir's `info/attributes`, inside a managed block. Nothing in the repo changes. `registerMergeDrivers` is idempotent, and an empty rule set removes the block.
- Derived-file rules are listed after mergiraf patterns, so a lockfile that is also `*.json` gets the regenerate driver.
- A derived-file driver keeps one side whole and records which generator is owed.
- `rerere.enabled` and `rerere.autoUpdate` are on. `.merge_file_*` (git's merge temp files) is excluded, so a killed merge's leftovers can never be committed.
- The mergiraf driver is a wrapper. Every file it handles, in any merge in that worktree, appends one line `<status>\t<repo-relative path>` to `$(git rev-parse --git-dir)/buildd-mergiraf-log` (`MERGIRAF_LEDGER`). Status is one of:
  - `resolved`: a plain line merge would have conflicted and mergiraf merged it. This is unreviewed code.
  - `clean`: a line merge would have succeeded too. Not counted.
  - `conflict`: mergiraf failed and git leaves the file conflicted.
- The wrapper returns mergiraf's own exit code.

**Acceptance criteria**:
- AC-5: WHEN registration runs twice THEN `info/attributes` contains each driver line once.
- AC-6: WHEN two files with the same basename in different directories are both resolved THEN the ledger lists both full paths.
- AC-7: WHEN mergiraf exits non-zero THEN git sees the same exit code and the ledger line is `conflict`.

## What the runner merges

**Capability statement**: `planPreMerge` picks the one ref to merge before the
agent starts, or none.

**Invariants**:
- The stated base wins. A conflict retry's `context.prBase` is the PR's real base branch, set by the server in `buildConflictRetryTask` and validated by `isPlainBranchName`. The runner merges `origin/<prBase>` unless prBase is malformed or names the task's own branch.
- Without `prBase`, a conflict retry merges the computed PR base. If that base equals the retry's own branch (a mission ship PR), it merges trunk instead. Merging a branch into itself is always "up to date".
- A mission refresh (`context.refreshTrunk`) merges `origin/<refreshTrunk>` into the integration branch.
- No pre-merge for:
  - migration collisions;
  - tasks that are not conflict work;
  - workspaces without `derivedFiles`.

**Acceptance criteria**:
- AC-8: GIVEN `context.prBase: "dev"` on a retry whose computed base is its own branch WHEN planning THEN the ref is `origin/dev`.
- AC-9: GIVEN a malformed `context.prBase` WHEN planning THEN it is ignored and the computed base is used.
- AC-10: GIVEN `failureContext.errorType: "migration_collision"` WHEN planning THEN no pre-merge runs.
- AC-11: GIVEN a mission refresh WHEN planning THEN the plan merges `origin/<refreshTrunk>` and is marked as not finishable without an agent.

## Pre-merge outcomes and who finishes

**Capability statement**: `mergeBaseWithDerivedFiles` returns one of four
outcomes, and only one narrow case may finish without an agent.

**Invariants**:
- `git merge` has a 10-minute limit. On timeout or any unexpected error the merge is aborted, the branch is reset to its prior HEAD, `.merge_file_*` files are removed, and the agent starts as if no pre-merge happened.
- `structurallyResolved` lists exactly the ledger's `resolved` paths for this merge. Exact duplicate import lines in those JS/TS files are removed (`dedupeImportLines`), because mergiraf once kept the same import twice and broke a type check.
- Outcomes:
  - `up_to_date`: the agent starts normally.
  - `conflicts`: the merge is left in progress. The agent's prompt lists only the real conflict files, the regenerate commands owed, and the files mergiraf resolved, to review.
  - `merged` with any `structurallyResolved`: the agent MUST review those files and run their tests before pushing.
  - `merged` with none, and the plan allows it: `canFinishWithoutAgent` is true, and `finishDerivedMerge` runs the task's `verificationCommand` if set, then pushes without force.
  - `error` (including a timeout): handled as described in the first invariant.
- A no-agent finish pushes only what git merged cleanly plus regenerated derived files. When there is no `verificationCommand`, the completion summary says nothing was verified locally. CI and review still gate landing; a push is not a merge.
- A mission refresh never finishes without an agent: its agent opens the refresh PR.

**Acceptance criteria**:
- AC-12: GIVEN a merge that outlives its limit WHEN it is killed THEN the result is `error` with "timed out", HEAD equals the prior HEAD, and `git status --porcelain` is empty.
- AC-13: GIVEN a merge where mergiraf resolved `src.ts` WHEN it completes THEN `canFinishWithoutAgent` is false and the agent's note names `src.ts`.
- AC-14: GIVEN a derived-only conflict and a failing `verificationCommand` WHEN finishing THEN nothing is pushed and the agent starts with a note saying what the runner tried.
- AC-15: GIVEN the remote branch moved WHEN finishing THEN the push is rejected, never forced, and the agent takes over.

## Transparency

**Capability statement**: Every pre-merge and every mergiraf resolution, the
runner's or the agent's, MUST be visible without access to the runner host.

**Invariants**:
- Every pre-merge records a milestone starting `Pre-merge:` with its outcome, the regenerate count, the files mergiraf resolved, and the first line of any error (`formatPreMergeMilestone`).
- Merges the agent runs itself are reported in two ways (`formatAgentMergeMilestones`):
  - after each merge-shaped Bash command (merge, rebase, pull, cherry-pick, am, revert, stash pop/apply), `createMergeLedgerHook` reads new ledger lines, records a `Merge: mergiraf resolved N file(s): …` or `Merge: mergiraf left N file(s) conflicted: …` milestone, and tells the agent to review each resolved file against both sides and run the covering tests before committing or pushing;
  - a sweep at session end records anything the hook missed.
- The ledger read offset (`mergirafLedgerOffset`) starts after the pre-merge, so the runner's own entries are never reported as the agent's.
- Milestones sync to the server. `get_task` with `include: ["milestones"]` prints them per worker, and always keeps `Pre-merge:` and `Merge:` lines even beyond the per-worker cap.
- A no-agent finish records a `base_refresh` gate event with `detail.stage: derived_merge`.

**Acceptance criteria**:
- AC-16: WHEN an agent runs `git merge` and mergiraf resolves `a.ts` THEN the next tool result carries context naming `a.ts`, and a `Merge: mergiraf resolved 1 file(s): a.ts` milestone exists.
- AC-17: WHEN `get_task` is called with `include: ["milestones"]` on a worker with more than 25 milestones THEN every `Pre-merge:` and `Merge:` line is printed, with an explicit count of omitted lines.
- AC-18: WHEN `get_task` is called without `milestones` THEN its output is unchanged.

**Code surface**:
- apps/runner/src/merge-drivers.ts: `registerMergeDrivers`, `planPreMerge`, `mergeBaseWithDerivedFiles`, `canFinishWithoutAgent`, `finishDerivedMerge`, `readMergirafLedger`, `dedupeImportLines`, `formatPreMergeMilestone`, `formatAgentMergeMilestones`, `formatDerivedMergeNote`, `formatDerivedFilesGuidance`, `isConflictRetryContext`, `MERGIRAF_LEDGER`.
- apps/runner/src/workers.ts: the wiring after setupWorktree, and the no-agent finish.
- apps/runner/src/hook-factory.ts: `createMergeLedgerHook`.
- packages/shared/src/derived-files.ts: `normalizeDerivedFiles`.
- packages/core/derived-files-detect.ts: `detectDerivedFiles`, the action=init proposals.
- apps/web/src/lib/conflict-retry.ts: `buildConflictRetryTask` (`context.prBase`), `isPlainBranchName`.
- apps/web/src/app/api/workspaces/[id]/route.ts: derivedFiles and mergiraf validation.
- packages/core/mcp-tools.ts: the `get_task` milestones include.

**Out of scope**:
- Whether a conflict needs an agent at all (re-check, update-branch, semantic overlap): see `base-refresh-classification`.
- Live overlap between two running workers: see `live-sibling-conflict-probe`.
- Migration-number collisions and renumbering.
- Installing mergiraf on hosts: apps/runner/install.sh, apps/runner/Dockerfile.once, and the Coder workspace image in the infrastructure repo.
- Using a decision model (Jev) to resolve hunks. It was evaluated and rejected: below safe precision, and its confident errors dropped a deletion or one side's edit.
