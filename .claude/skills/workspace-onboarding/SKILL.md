---
name: workspace-onboarding
description: "Use when an owner wants a repo made buildd-ready, a readiness report says `skill: workspace-onboarding`, or you hold an onboarding scaffold / spec-authoring task: the one path from new workspace to first mission, with two owner approvals and nothing written to the default branch."
author: buildd
---

# Workspace Onboarding

Audience: an agent in an interactive session with a repo owner, or one running
an onboarding task. Not for ordinary task work (that is `buildd-mcp-consumer`).
Same resource if no skill is installed: `buildd://workspace/onboarding`.

## Rules

1. **Never commit to the default branch.** Every repo change is a PR from a
   task branch; a human merges it. Never auto-merge it, whatever the preset.
2. **Never require Vercel.** Previews are one optional visual-QA source; a repo
   with none is valid.
3. **Propose, then approve.** Nothing is written until the owner chose items
   (approval 1) and merges the PR (approval 2). Defaults are dry runs.
4. **Recompute, don't remember.** Re-run `readiness` instead of trusting what
   you saw earlier; the repo is the source of truth, not a stored step.
5. **Mirror the repo.** Use its own commands, paths and spec format. Where a
   command cannot be detected, leave a `TODO(owner)`, never a guess.

## Steps

Each is `buildd action=manage_workspaces params={ action, workspaceId, ... }`,
with the `action` shown.

1. **Create workspace:** `action: "create"` (name, optional `repoUrl`).
2. **Link repo:** `action: "update"` with `repoUrl` for an existing repo, or
   `action: "create_repo"`.
3. **Init:** `action: "init"` proposes merge-policy risk classes from the repo;
   apply with `action: "update"` on `gitConfig.policyConfig`. Default preset
   `balanced`; the preset is the owner's call. `init` also works standalone.
4. **Readiness:** `action: "readiness"` is read-only and idempotent. It returns
   items, a `nextStep` and `skill`. Run it after every step.
5. **Guided fixes:** `action: "scaffold"` (below).
6. **First spec:** `action: "author_spec"` (below).
7. **First mission:** `buildd action=manage_missions`, or the dashboard's
   `/app/missions/new?workspace=<id>`.

`nextStep` is the first unmet step: `link-repo`, `review-policy`,
`propose-fixes`, `author-spec`, `first-mission`, `done`. Follow it.

## Readiness items

Status: `detected`, `missing`, or `unknown` (could not tell: truncated tree,
no access). Treat `unknown` as unknown, never as missing; never propose files
over it. `core` items drive `nextStep`; `recommended` never block. An owner can
waive an item that does not apply; a waived item is skipped.

| id | importance | fix when `missing` |
|---|---|---|
| `agent-instructions` | core | `scaffold` |
| `spec-root` | core | `scaffold` |
| `spec-format` | core | `scaffold`, else `owner-decision` (mirror existing specs) |
| `test-command` | core | `owner-decision` |
| `merge-policy` | core | `apply-config` (the `init` result) |
| `typecheck-command` | recommended | `owner-decision` |
| `build-command` | recommended | `owner-decision` |
| `env-manifest` | recommended | `scaffold` |
| `migrations-dir` | recommended | `apply-config` (absent is fine) |
| `release-path` | recommended | `apply-config` or `scaffold`; else `owner-decision` |
| `visual-qa-source` | recommended | `owner-decision`; `sandbox` or `vercel-preview` |

Fix kinds: `scaffold` = a file the agent authors in a PR from a template;
`apply-config` = a detected value applied through `update` on `gitConfig`;
`owner-decision` = ask the owner, no automated fix.

## Guided fixes (approval 1, then 2)

`params={ action: "scaffold", workspaceId, itemIds: [...] }` takes only
`scaffold` items the owner named.

- No `itemIds`: does nothing. With `itemIds`: `dryRun` is the default, so it
  returns the rendered files and target paths and creates nothing. Show them.
- `confirm: true` creates one builder task that opens the PR(s): at most one for
  docs and instructions, one more for a release workflow. Items it
  skipped come back with the reason (already exists, `unknown`).
- The task verifies the rendered files against the repo, adjusts, then
  opens the PR. A human merges it. Then run `readiness` again.

Apply `apply-config` and `owner-decision` items through the owner, never
silently. Not scaffolded: CI, spec checkers, Vercel config.

## First spec: the interview

Ask one product question at a time and each capability question once per Q2
item. Re-ask a vague answer ("properly", "etc.", "works well"); write "must",
not "should" or "may". Q5 is pre-filled from a scan; the owner confirms, and
only paths that exist are kept. These match `packages/shared/src/onboarding-interview.ts`.

| # | Question | Answer field | Goes to | Becomes |
|---|---|---|---|---|
| Q1 | In one or two sentences, what is this product and who uses it? | `title, description` | spec | title and one-sentence summary |
| Q2 | List the 3-7 things it must do (verbs, not features). | `capabilities[].name` | spec | one block per item, first is primary |
| Q3 | For each: what must always be true, whatever the input? | `capabilities[].invariants` | spec | falsifiable invariants |
| Q4 | For each: give one example that works and one that must be rejected. | `capabilities[].accepted, capabilities[].rejected` | spec | GIVEN/WHEN/THEN criteria, 3+ per block, one error path |
| Q5 | Where in the repo does this live? (pre-filled from a scan; the owner confirms) | `capabilities[].codePaths` | spec | code surface |
| Q6 | What is explicitly not part of this? | `outOfScope` | spec | out of scope |
| Q7 | How would you know it works today? (tests, a command, a manual check) | `verification` | spec | `verified_by` only for a real test path |
| Q8 | Anything that must never change without you? | `protectedAreas` | merge-policy | the policy decision, not the spec |

Pass the answers as `params={ action: "author_spec", workspaceId, answers }`:
`dryRun` is the default and returns the draft markdown; show it and adjust.
`confirm: true` creates one builder task that opens a PR adding that one file,
flat under the spec root, `status: draft`. The owner merges and promotes it.
Never write `active`. Feed Q8 into the merge-policy decision from step 3.

## Done

Report `readiness` once more. When `nextStep` is `first-mission`, offer to
create a mission from the owner's first goal; do not start one unasked.
