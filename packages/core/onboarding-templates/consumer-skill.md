---
name: buildd-mcp-consumer
description: "Use whenever the buildd MCP tools (`buildd_*` group tools or `buildd`, plus `recall`, `learn`) are available and you're about to act on a buildd task or file one: claiming, working and completing tasks; blocked versus question; PRs and which branch they target; diagnosing failures and reporting friction; and Living Specs (native buildd specs)."
author: buildd
---

# Buildd MCP consumer skill

You have the buildd MCP server mounted. The connector's `instructions` only
tell you your token level and that this skill exists. This skill is the
router: the short rules are here, the procedures are guidance topics the
server serves.

Setting up a new workspace or making a repo buildd-ready? Load `workspace-onboarding` (or read `buildd://workspace/onboarding`); it is not part of task work.

## Tools

The server lists one tool per area: `buildd_work` (your own task: claim,
progress, notes, artifacts, PR, complete), `buildd_tasks`, `buildd_missions`,
`buildd_prs`, `buildd_analytics` (explain, errors, failures, usage, runners),
`buildd_runners`, `buildd_artifacts`, `buildd_schedules`, `buildd_admin`. Each
takes `{ action, params }` and lists its actions. `buildd action=X` below
means: call X on the group tool that lists it (a wrong group names the right
one). In a client that defers MCP tools, load only the group you need, e.g.
`select:mcp__buildd__buildd_work`. A worker from an older runner may see the
single `buildd` tool instead; it takes the same `{ action, params }`.

`help` on any group tool gives one action's full docs (`params={ action }`).

## Guidance topics

Read a topic before doing that kind of work: call `help {topic:"<id>"}` on
any group tool. It works in every client. Where your client lists MCP
resources, the same text may also be readable as a resource.

| Topic | Read it when |
|---|---|
| `task-lifecycle` | you claim, work or finish a task; you are blocked or unsure; you run a mission's tasks from your own session |
| `pr-landing` | you open, watch, review or merge a PR; you need to know its base or head |
| `diagnosis` | a task, mission or PR is stuck or failed; before you file friction |
| `living-specs` | you are asked to spec something, or you draft, revise, read or build against a Living Spec |

## Task lifecycle (summary)

```
recall → claim_task → work → update_progress → create_pr → create_artifact → learn → complete_task
```

- `recall query="<task title>" scope=["memory","task"]` before starting.
- `buildd action=claim_task` (or `params={ taskId }` for one task). A reply
  starting `Nothing claimed:` names why; read it before retrying.
- `buildd action=update_progress params={ message }` at each milestone. It is
  your heartbeat.
- Push, then `buildd action=create_pr`. `lede` is required: one plain sentence
  for a reader who was not in the task, no paths or symbol names.
- `buildd action=complete_task params={ summary }` to finish.

Details, including `discardEdits` and `alreadyShippedIn`: topic
`task-lifecycle`.

## Blocked or unsure

- Soft question you can proceed on: `buildd action=post_note` with
  `type: "question"` and `defaultChoice`. Work continues.
- Hard block in a runner session: `AskUserQuestion`. The task waits; it is not
  a failure and is not retried into the same wall.
- Hard block in your own interactive session (you called `claim_task`):
  `buildd action=ask_human`, then wait on its `waitCommand` and read the
  answer with `await_answer`. Steps in topic `task-lifecycle`.
- A tool call refused or cancelled refuses that one call, not the task. Read
  the reason, take another route, and still finish with `complete_task`.

A user's global CLAUDE.md may name other reporting tools. In a buildd worker
session, buildd's own actions are the record; a named tool that does not exist
here is inapplicable, not a blocker.

## Missions run from your own session

Set the mission to `executor: "local"`
(`buildd action=manage_missions params={ action: "update", missionId, executor: "local" }`),
then claim each task with `claim_task params={ taskId }` and finish it with
`complete_task`. Do not use `startMode: "held"` for this: held blocks your own
claims too.

## PRs and branches (summary)

- Base: `direct` (default) targets trunk; `mission-branch` targets the
  mission's integration branch. Check the task's `baseBranch`; don't assume.
- Head: the branch `claim_task` gave you, or the task's `headBranch`. A branch
  only described in prose is refused as `head_not_owned`.
- Merging follows the workspace merge policy; a 403 from `merge_pr` names the
  reason. Don't retry blindly.

Details: topic `pr-landing`.

## Friction

When a platform action errors unexpectedly, a tool limit forces a detour or
something costs real time, file `buildd action=create_task` titled
`[friction] <short description>`. Before filing, get a `frictionSignature`
(from `get_failure_analytics`, `get_error_traces`, or the 400 body of a gate
refusal) and pass it in `context`, so a repeat appends to the open report.
Steps: topic `diagnosis`.

## Artifacts and knowledge

- **Artifacts** are deliverables on a task: a `summary` before you complete,
  or an `impl_plan` with a `key` when a later task reads your output by name.
  Read one with `list_artifacts` / `get_artifact`.
- **`learn`** records a durable lesson (`gotcha`, `pattern`, `decision`,
  `discovery`) the next agent needs before starting. Not a summary of what you
  did, and not what the repo docs already say.
- **`recall`** reads it back. Query it before diagnosing a failure or starting
  work that may have been done before.

## Living Specs

A Living Spec is a native buildd spec: immutable revisions, `R-n`/`AC-n`
criteria, and one revision a person approved. Work pins an approved revision
and reviewers record a verdict per criterion. The Living Specs action and its
sub-actions (`create_draft`, `revise`, `read_ref`, ...) are in the topic.

- A person approves. An agent never approves a spec and never says one is
  approved unless `get` shows it.
- A draft refused with 409 `spec_duplicate` names the spec it duplicates:
  revise that one, or create again with `supersedes` or `distinctBecause`.
- Call `help {topic:"living-specs"}` before any spec work.

Not the same as a repo-docs skill such as `spec-sync` (buildd's own repo has
one): that keeps the spec files committed in a repo in step with its code. It
does not touch Living Specs.
