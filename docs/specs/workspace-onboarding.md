---
title: Workspace Onboarding
status: draft
owner: max
last_verified: 2026-10-02
summary: Onboarding MUST derive a workspace's readiness from observable repo facts without writing, and every change it proposes to the repo MUST arrive as an owner-merged PR from a non-default branch.
domain: surfaces
surfaces: [packages/core/workspace-readiness.ts, apps/web/src/app/api/workspaces/[id]/readiness/route.ts, packages/core/onboarding-scaffold.ts, packages/core/onboarding-spec.ts]
related: [team-workspace-mission-onboarding, mcp-action-contracts]
keywords: [readiness report, scaffold PR, author_spec, onboarding skill, buildd-ready, nextStep, anti-blind-copy, interview]
verified_by: [packages/core/__tests__/workspace-readiness.test.ts, apps/web/src/app/api/workspaces/[id]/readiness/route.test.ts, packages/core/__tests__/onboarding-render.test.ts, packages/core/__tests__/onboarding-scaffold.test.ts, apps/web/src/app/api/workspaces/[id]/onboarding/scaffold/route.test.ts, packages/core/__tests__/onboarding-spec.test.ts, apps/web/src/app/api/workspaces/[id]/onboarding/spec/route.test.ts, packages/core/__tests__/mcp-tools-manage-workspaces.test.ts, scripts/mcp-consumer-skill-action-drift.test.ts, scripts/mcp-consumer-skill-instructions.test.ts, scripts/workspace-onboarding-skill.test.ts]
supersedes: []
---

# Workspace Onboarding

Promoted from `docs/design/workspace-onboarding.md` (now Implemented). The design
holds the rationale and the rejected alternatives; this file holds the contract.

**Status is `draft`** under SPEC-FORMAT rule 9. Fourteen of the sixteen criteria
are asserted by tests that exist today; AC-12 is guarded for its frontmatter
clause only, and AC-16 has no direct guard (see each criterion). Promote to
`active` once those two are closed.

## Onboarding path

**Capability statement**: A workspace pointed at an arbitrary repo MUST get one
documented path (create workspace, link or create repo, init, readiness report,
owner-approved scaffold PR, first spec, first mission) in which detection is a
pure function of repo facts and no step writes to the repo's default branch.

**Invariants**:

- `computeReadiness` is a pure function of its input: no fetch, no database, no clock; equal inputs give equal reports.
- The readiness report is recomputed per request and never stored; only owner decisions (waivers, the scaffold PR link) persist, in `gitConfig.onboarding`, which is a TypeScript-only change with no migration.
- A detector that cannot see MUST report `unknown`, never `missing`: a truncated tree, an unreadable manifest, an absent optional detector and an unreachable repo all yield `unknown`. A file that is present still counts as `detected`.
- Detectors recognise ecosystems by manifests and lockfiles, never by a repo name, and name no buildd-specific path or toolchain outside generic candidate lists.
- `core` items drive `nextStep`; `recommended` items never block the first spec or mission. `nextStep` is the first unmet step, so the dashboard and MCP answer "what next" from one source.
- Nothing onboarding does commits to the default branch: scaffold and spec authoring only create a builder task whose PR is opened from a task branch against the default branch.
- Every scaffold or spec task is tagged `requiresReview`, so the merge policy resolves it to the human tier whatever preset the workspace applied; onboarding PRs are never auto-merged.
- `dryRun` defaults to true on both write-adjacent actions; `dryRun: false` without `confirm: true` is refused, and an explicit `dryRun: true` wins over `confirm: true`.
- A scaffold call that names no `itemIds` does nothing. Present files are never overwritten; a waived item is skipped.
- At most two scaffold PRs per run: one docs-and-instructions PR with one commit per item, and a separate release-workflow PR only when selected.
- Templates are derived, parameterised files under `packages/core/onboarding-templates/`, never copies of buildd's own files. An undetectable command renders a `TODO(owner)` line, never a guess.
- A generated spec is one flat file `<specsRoot>/<slug>.md` with `status: draft`, contains no "should" or "may", and claims only code-surface and `verified_by` paths that exist in the repo.
- The interview (Q1-Q8) is defined once in `packages/shared`; the dashboard wizard and the skill read that one definition.
- Readiness IO is bounded: at most 12 manifests, at most 64 KB each, fetched through the contents API.
- Vercel is never required. A workspace with no deployments or no deployment permission resolves visual QA to `sandbox` or `missing`.
- `init` is unchanged and keeps working standalone.

**Acceptance criteria**:

- AC-1: GIVEN a file list and manifests with no `bun`, no `apps/`, no `docs/specs` WHEN `computeReadiness` runs THEN no item's evidence or fix names a buildd-specific path.
  Verified by: packages/core/__tests__/workspace-readiness.test.ts ("no buildd-shaped output for non-buildd fixtures").
- AC-2: GIVEN a Python/uv fixture repo WHEN `computeReadiness` runs THEN `test-command` and `build-command` are derived from `pyproject.toml` and the lockfile, not `bun run test`.
  Verified by: packages/core/__tests__/workspace-readiness.test.ts ("python/uv fixture (AC-2)").
- AC-3: GIVEN a truncated git tree WHEN `computeReadiness` runs THEN every item that depends on absent files is `unknown`, never `missing`, and `truncated` is true.
  Verified by: packages/core/__tests__/workspace-readiness.test.ts ("truncated tree (AC-3)"), apps/web/src/app/api/workspaces/[id]/readiness/route.test.ts.
- AC-4: GIVEN a workspace with no linked repo WHEN `action=readiness` runs THEN it returns `nextStep: 'link-repo'`, reads GitHub never, and writes nothing.
  Verified by: apps/web/src/app/api/workspaces/[id]/readiness/route.test.ts ("no repository"), packages/core/__tests__/mcp-tools-manage-workspaces.test.ts ("manage_workspaces readiness").
- AC-5: GIVEN any workspace WHEN `action=readiness` is called twice THEN both calls return the same report and perform no writes.
  Verified by: apps/web/src/app/api/workspaces/[id]/readiness/route.test.ts ("read-only and idempotent").
- AC-6: GIVEN the readiness work is merged WHEN `action=init` runs THEN its output and behaviour are unchanged and still target `/api/workspaces/[id]/policy-init`.
  Verified by: packages/core/__tests__/mcp-tools-manage-workspaces.test.ts ("init output does not tell the caller to type paths", "does not change what init calls"). No onboarding work touches the policy-init route.
- AC-7: GIVEN `action=scaffold` WHEN called with no `itemIds` THEN no task is created; WHEN called with `itemIds` and no `confirm` THEN no task is created and the rendered files are returned.
  Verified by: apps/web/src/app/api/workspaces/[id]/onboarding/scaffold/route.test.ts ("AC-7"), packages/core/__tests__/onboarding-scaffold.test.ts ("no item ids is a no-op").
- AC-8: GIVEN `action=scaffold` with `confirm: true` WHEN it runs THEN exactly one builder task with `outputRequirement: pr_required` is created, based on the workspace default branch, and nothing is committed to that branch by the route.
  Verified by: apps/web/src/app/api/workspaces/[id]/onboarding/scaffold/route.test.ts ("AC-8"). The route holds no repository write path; the agent commits on a task branch.
- AC-9: GIVEN the `autonomous` preset applied WHEN a scaffold task is created THEN its merge policy resolves to the human tier, so the PR is not auto-merged.
  Verified by: apps/web/src/app/api/workspaces/[id]/onboarding/scaffold/route.test.ts ("AC-9").
- AC-10: GIVEN every template rendered against a non-buildd fixture WHEN the output is scanned THEN no denylisted string appears outside caller-passed parameter values.
  Verified by: packages/core/__tests__/onboarding-render.test.ts ("anti-blind-copy gate (AC-10)"), packages/core/__tests__/onboarding-scaffold.test.ts ("never leaks buildd layout into a stranger repo").
- AC-11: GIVEN `author_spec` answers WHEN the spec is rendered THEN it is one flat file under the detected spec root (or the default when none), `status: draft`, each block has at least 3 ACs including one rejection case, and the text contains no "should" or "may".
  Verified by: packages/core/__tests__/onboarding-spec.test.ts ("authorSpec: blocks (AC-11)", "where the file goes"), apps/web/src/app/api/workspaces/[id]/onboarding/spec/route.test.ts ("the file is flat under the detected spec root").
- AC-12: GIVEN a generated spec WHEN it is validated THEN it passes `specs:check`-style frontmatter validation for the default format's required fields, and after the PR merges `spec_compare` returns it.
  Verified by (frontmatter clause only): packages/core/__tests__/onboarding-spec.test.ts ("authorSpec: frontmatter (AC-12)"). The `spec_compare` retrieval clause has no test yet.
- AC-13: GIVEN the `workspace-onboarding` skill WHEN it names a backticked action that is not in `allActions` or a documented group sub-action THEN the drift gate fails.
  Verified by: scripts/mcp-consumer-skill-action-drift.test.ts ("action drift gate mechanics").
- AC-14: GIVEN the MCP server WHEN `buildd://workspace/onboarding` is read THEN it returns exactly the contents of `.claude/skills/workspace-onboarding/SKILL.md`.
  Verified by: scripts/mcp-consumer-skill-instructions.test.ts ("buildd://workspace/onboarding resource").
- AC-15: GIVEN no Vercel deployments and no GitHub deployment permission WHEN `computeReadiness` runs THEN `visual-qa-source` resolves to `sandbox` or `missing`, never an error, and the rest of the report is unaffected.
  Verified by: packages/core/__tests__/workspace-readiness.test.ts ("visual-qa-source (AC-15)"), apps/web/src/app/api/workspaces/[id]/readiness/route.test.ts ("a workspace with no GitHub deployment access still gets the rest of the report").
- AC-16: GIVEN a workspace that never calls `readiness`, `scaffold` or `author_spec` WHEN the work ships THEN no flag, field or schema column it added changes that workspace's behaviour.
  Not yet verified by a test. Structurally: the only schema change is an optional `gitConfig.onboarding` TypeScript field with no migration, and the three actions are new.

**Code surface**:

- Routes: `/api/workspaces/[id]/readiness` (GET), `/api/workspaces/[id]/onboarding/scaffold` (POST), `/api/workspaces/[id]/onboarding/spec` (POST); handlers at `apps/web/src/app/api/workspaces/[id]/readiness/route.ts`, `apps/web/src/app/api/workspaces/[id]/onboarding/scaffold/route.ts`, `apps/web/src/app/api/workspaces/[id]/onboarding/spec/route.ts`.
- MCP: the `readiness`, `scaffold` and `author_spec` cases of `manage_workspaces` in `packages/core/mcp-tools.ts`; the `buildd://workspace/onboarding` resource in `apps/web/src/app/api/mcp/route.ts`, traced by `apps/web/next.config.mjs`.
- Pure core: `computeReadiness` in `packages/core/workspace-readiness.ts` with detectors in `packages/core/readiness/`; `packages/core/ecosystem-detect.ts` (lockfile table shared with `apps/runner/src/env-verify.ts`); `renderOnboardingTemplate` in `packages/core/onboarding-render.ts` over `packages/core/onboarding-templates/`; `planScaffold` in `packages/core/onboarding-scaffold.ts`; `authorSpec` in `packages/core/onboarding-spec.ts`.
- IO shell: `gatherReadinessInput` in `apps/web/src/lib/workspace-readiness-io.ts` (bounded manifest reads).
- Shared: `ONBOARDING_INTERVIEW` in `packages/shared/src/onboarding-interview.ts`; the `WorkspaceOnboardingConfig` type in `packages/shared/src/types.ts`, hung off `WorkspaceGitConfig` in `packages/core/db/schema.ts`.
- Dashboard: `ReadinessCard.tsx`, `RepoLinkCard.tsx` and `SpecWizard.tsx` under `apps/web/src/app/app/(protected)/workspaces/[id]/config/`.
- Skill: `.claude/skills/workspace-onboarding/SKILL.md` (at most 8 KB, enforced by `scripts/workspace-onboarding-skill.test.ts`).

**Out of scope**:

- Scaffolding CI, a spec checker (spec format rules 7 and 8 stay buildd-only), the no-prod-data workflow, git hooks, or any Vercel configuration.
- Auto-merging or directly committing any onboarding change to a stranger's default branch.
- Back-filling specs for existing code; the first spec is spec-first, from the owner's answers.
- Changing `init`, the merge-policy model, the conformance assertion vocabulary, or the consumer skill beyond its one pointer line.
- A new agent role; onboarding work runs on the existing builder and organizer roles.
- Bulk-running the report across workspaces or migrating existing workspaces.
