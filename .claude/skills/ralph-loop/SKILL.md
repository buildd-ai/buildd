---
name: ralph-loop
description: "Verification loop skill for buildd tasks. Two modes: (1) prompt-based self-review via maxReviewIterations in task context, (2) agent-driven verification where agents run commands locally before completing."
author: buildd
---

# Ralph Loop — Self-Review & Verification Skill

Quality gate pattern for buildd tasks. Two complementary modes:

1. **Prompt-based self-review** (in-session): The runner automatically asks the agent to review its work before completing. Enabled via `maxReviewIterations` in task context.
2. **Agent-driven verification**: Agents run verification commands locally before completing. Taught via this skill document.

## Mode 1: In-Session Self-Review

When `maxReviewIterations` is set in the task context (e.g., `maxReviewIterations: 2`), the runner automatically injects a self-review prompt after the agent's first result. The agent must respond with `<promise>DONE</promise>` to pass, or fix issues and try again.

This is opt-in — default is 0 (disabled). Set it when creating tasks:

```
buildd action=create_task params={
  "title": "feat: add user auth",
  "description": "Implement OAuth login flow",
  "context": { "maxReviewIterations": 2 }
}
```

## Mode 2: Agent-Driven Verification

When a task has a `verificationCommand` or `failureContext`, agents should run verification locally.

### Verification Workflow

```
Agent works on task
  |→ Agent completes work
  |→ Agent runs verificationCommand locally (if set)
  |→ PASS → complete the task, create PR
  |→ FAIL → fix the issues, re-run verification
```

### If You Are a Retry Task

Check your task context for these fields:

| Field | Meaning |
|-------|---------|
| `failureContext` | What failed in the previous attempt — read this first |
| `baseBranch` | Your worktree is based on the previous attempt's branch |
| `iteration` | Which attempt this is (1-indexed) |
| `maxIterations` | Stop after this many attempts |
| `verificationCommand` | The command to run before completing |
| `prNumber` | Existing PR number (push fixes, don't create a new PR) |

### Retry Rules

1. **Read the failure context** — understand exactly what went wrong
2. **Your worktree already has the previous work** — don't start from scratch
3. **Fix the specific issue** — targeted fix, not a rewrite
4. **Run the verification command locally** before completing
5. **If there's an existing PR**, push to the same branch — it auto-updates

## Verification Best Practices

1. **Keep verification commands fast** — under 5 minutes
2. **Make failure output actionable** — include file paths and line numbers
3. **Set reasonable maxIterations** — 3 for simple fixes, 5 for complex features
4. **Always run verification locally before completing**

## Escalation

| Situation | Action |
|-----------|--------|
| Still failing after multiple attempts | Stop and report what's failing |
| Verification passes locally but fails in CI | Check environment differences |
| Previous attempt's code is fundamentally wrong | Say so in completion summary |
| Flaky test causing failures | Identify, fix or skip, note in summary |
