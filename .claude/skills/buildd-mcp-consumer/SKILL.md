---
name: buildd-mcp-consumer
description: "Use whenever the buildd MCP tools (`buildd`, `recall`, `learn`) are available and you're about to act on a buildd task or file one — task coordination workflow: claiming, working, and completing tasks; deciding between a hard block and a flagged assumption; reporting friction; and which branch a task's PR should target."
author: buildd
---

# Buildd MCP Consumer Skill

You have the buildd MCP server mounted. This skill is the procedure for using
it — the connector's `instructions` only tell you your token level and that
this skill exists; everything about *how* to work a task lives here.

## Task Lifecycle

```
recall (check prior context) → claim_task → work → update_progress (milestones)
  → create_pr → create_artifact → learn → complete_task
```

1. **Before starting:** `recall query="<task title>" scope=["memory","task"]`
   — surfaces prior gotchas, patterns, and how similar tasks were solved.
2. **Claim:** `buildd action=claim_task`. Response includes your worker ID
   (save it — every later call needs it, though most auto-resolve it from
   context), the branch to check out, and the task description.
3. **Work it.** Check out the returned branch and make the change.
4. **Report progress at milestones** (roughly 25%, 50%, 75%):
   `buildd action=update_progress params={ progress, message }`.
5. **Ship:** push commits, then `buildd action=create_pr`. Optionally
   `action=get_pr` to check CI/review state, then `action=merge_pr` once
   green — merging is subject to the workspace's merge policy tier, and a
   403 there names the reason; don't retry blindly.
6. **Before completing:** `buildd action=create_artifact` with a summary of
   what you did (`type=summary`), or `type=impl_plan` with a `key` if a
   later task is meant to read this one's output. Then `learn` anything a
   future agent would want to know (see Knowledge Discipline below).
7. **Finish:** `buildd action=complete_task` with a summary.

## Blocked vs. Question — two different tools, do not conflate them

- **Hard block, no correct path forward** — a required tool/credential is
  genuinely unavailable, or the instruction is impossible as written: use
  `AskUserQuestion`. This parks the task waiting for input. It is **not**
  recorded as a failure and is **never** auto-retried into the same dead
  end; the owner is notified, and answering resumes your work from where you
  left off. Reserve this for cases where no amount of additional thinking
  produces a path forward — not for uncertainty, permission-seeking, or a
  design choice you're capable of making yourself.
- **Soft question you can proceed under a default for:** `buildd
  action=post_note` with `type=question` and `defaultChoice` set to what you
  chose. Non-blocking — work continues immediately. State the assumption and
  move on.

## Friction Reporting

If a platform action returns an unexpected error, a tool limitation forces a
detour, or something is confusing enough to cost real time — report it,
don't just work around it silently. These reports are the signal that drives
platform fixes.

File a `create_task` with title `[friction] <short description>` and a
description covering what broke, what you expected, and what you actually
had to do. Low priority is fine — this is background signal, not a blocker.

**Dedupe convention — check before filing:**
- If the friction traces to a tool-call error you saw, call
  `get_error_traces` first to get its pattern slug.
- If the friction is a **worker failure** (yours or a prior one's), call
  `get_failure_analytics` with `error: '<your error text>'` first — it tells
  you whether the failure is an already-known pattern (with count and
  first/last seen) and returns a ready-to-use `frictionSignature`.
- Either way, pass the result into `create_task` as
  `context: { frictionSignature: '<slug>', frictionExcerpt: '<first line>' }`.
  The server deduplicates friction tasks by `(frictionSignature, workspace)`
  — if an open task already carries the same signature, your report is
  appended to it instead of creating a duplicate, and you get the existing
  task ID back.

## Artifact and Knowledge Discipline

- **Artifacts** are deliverables attached to a task: a `summary` before you
  complete it, or an `impl_plan` (with a `key`) when a later task is meant to
  consume your output by name — check `list_artifacts`/`get_artifact` with
  that key before starting a task that says to read one.
- **`learn`** records durable lessons for the team — a `gotcha`, `pattern`,
  `decision`, or `discovery` that the *next* agent would want to know before
  starting. Worth saving: a non-obvious constraint you tripped over, a design
  decision and its reasoning, a workaround for a real limitation. Not worth
  saving: a summary of what you did (that's the artifact/completion summary),
  or anything already written down in the repo's docs.
- **`recall`** is how you read that knowledge back — always query it before
  diagnosing a failure or starting work that smells like it's been done
  before.

## Branch Strategy — know which one you're under

A task's PR targets one of two places, depending on the mission it belongs
to (or the workspace default, for a mission-less task). Check the claimed
task's `baseBranch` / mission context to know which applies — don't assume:

- **`direct`** (the default): your task's PR bases on the workspace's trunk
  branch directly. The workspace's merge policy tier applies to your PR.
- **`mission-branch`**: your task keeps its own branch and its own PR, same
  as always — but the PR's base is the *mission's* integration branch
  (`mission/<slug>-<id8>`), not trunk. Your PR still runs the platform's
  auto-merge checks and lands unattended into that integration branch; the
  mission reaches trunk later through exactly one PR from the integration
  branch to trunk, opened automatically once every task PR in the mission
  has merged. **One task still means one branch and one PR either way** —
  `mission-branch` changes the base ref your PR targets, not how many PRs
  your task produces. Never commit directly on the mission's integration
  branch itself; open your own branch off it.

Do not call either of these a "feature branch" — every task PR is already a
feature branch under both strategies, so the term doesn't distinguish them.
