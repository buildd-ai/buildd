---
name: pr-landing
description: "Read before you open, watch, review or merge a PR for a buildd task: which base and head, the lede, CI and review state, and what the merge policy allows."
---

# PRs: opening, review and landing over MCP

Use buildd's PR actions, not a GitHub connector's: buildd's GitHub App token
holds the write permissions, and buildd records the PR against your task.

## Which base

A task's PR base depends on the mission's branch strategy (or the workspace
default). Check the claimed task's `baseBranch` and mission; do not assume.

- **`direct`** (default): the PR bases on trunk. The merge-policy tier applies
  to this PR.
- **`mission-branch`**: the PR bases on the mission's integration branch
  (`mission/<slug>-<id8>`) and lands there on green checks. The mission
  reaches trunk later in one PR, opened once every task PR has merged. One
  task is still one branch and one PR. Never commit on the integration branch
  itself.

## Which head

The head is the branch `claim_task` assigned: `buildd/<id8>-<slug>`, or the
task's `headBranch` when one was set at `create_task`. Another head is refused
as `head_not_owned`. A branch described only in the task's prose is invisible
to buildd: whoever files the task sets `headBranch` instead.

Exception for your own interactive session only: a worker you claimed
yourself may open its PR from another branch you pushed to, unless another
worker holds that name (`head_claimed`). Prefer the assigned branch.

## Open

`buildd action=create_pr params={ title, head, base, lede, body }`

- `lede` is required: one plain sentence on what changed and why it matters to
  someone who was not in the task. No paths, routes or symbol names; those go
  in `body`. Nothing grades it.
- `requestReview: true` hands the PR to a reviewer agent at once.
- No GitHub App on the workspace? Open it with `gh`, then register it with
  `prUrl`.
- Change the body later with `buildd action=update_pr params={ prNumber, body }`;
  `draft: false` marks a draft ready. `buildd action=close_pr params={ prNumber }`
  closes one.

## Watch

- `buildd action=get_pr params={ prNumber }`: mergeable state, checks,
  reviews, fix attempts. Add `includeCiFailures: true` for each failing job's
  step and log tail. Check that the checks ran on your current head commit
  before trusting green.
- `buildd action=list_prs params={ state: "attention" }`: conflicts, red CI
  and PRs waiting on a person.
- `buildd action=explain params={ prNumber }`: why a PR is stuck; for a
  conflict, which merges into the base touched the same files.

## Review and merge

Who merges is the workspace merge policy (`gitConfig.mergePolicy.tier`):

- `auto-threshold`: `buildd action=merge_pr params={ prNumber }` merges only
  if the auto-merge safety check passes (green CI, no denied paths, size cap,
  migration check).
- `agent-review`: self-merge is refused. Call
  `buildd action=request_pr_review params={ prNumber }`, then wait with
  `buildd action=get_pr_review params={ prNumber, waitFor: "merge", waitSeconds: 45 }`
  (call again on `timedOut`). An approval merges if the policy allows it.
- `human`: merge is refused; a person merges.

A 403 from `merge_pr` names the tier and the reason. Read it; do not retry.
`overrides` (base freshness, size cap) is a person's escape hatch, or one a
person granted on your task when filing it. Never pass it on your own.

## A PR that closed but landed elsewhere

When the work merged under another PR,
`buildd action=record_pr_supersession params={ prNumber, supersedingPrNumber, reason }`
records it. The superseding PR must exist and already be merged.
