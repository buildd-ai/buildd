---
name: ralph-loop
description: "Verification loop skill for buildd tasks. Teaches agents to run verification gates, handle failures with structured context, and create retry tasks that chain back to the original."
author: buildd
---

# Ralph Loop — Verification & Retry Skill

Automated verification loop for buildd tasks. When a task has a verification command, run it before completing. If it fails, create a structured retry task so the next attempt starts from your work.

## When to Use This Skill

- Task context includes `verificationCommand`
- Task context includes `failureContext` (you're a retry attempt)
- You want to set up a verification gate for a new task
- CI failed on your PR and you need to create a retry

## How the Loop Works

```
Agent works on task
  |
  v
Agent completes work
  |
  v
Runner runs verificationCommand (if set)
  |
  ├─ PASS → task marked completed, PR auto-merges if enabled
  |
  └─ FAIL → task marked failed with verification output
            |
            v
         CI failure webhook (or agent) creates retry task:
           - parentTaskId = original task
           - baseBranch = previous branch (preserves work)
           - failureContext = what failed
           - iteration = N+1
           |
           v
         New agent claims → works on same branch
         (loop repeats until pass or maxIterations)
```

## If You Are a Retry Task

Check your task context for these fields:

| Field | Meaning |
|-------|---------|
| `failureContext` | What failed in the previous attempt — read this first |
| `baseBranch` | Your worktree is based on the previous attempt's branch |
| `iteration` | Which attempt this is (1-indexed) |
| `maxIterations` | Stop after this many attempts |
| `verificationCommand` | The command that will gate your completion |
| `prNumber` | Existing PR number (push fixes, don't create a new PR) |

### Retry Workflow

1. **Read the failure context** — understand exactly what went wrong
2. **Your worktree already has the previous work** — don't start from scratch
3. **Fix the specific issue** — targeted fix, not a rewrite
4. **Run the verification command locally first**:
   ```bash
   # Run whatever verificationCommand says, e.g.:
   bun test && bun run build
   ```
5. **If there's an existing PR**, push to the same branch — it auto-updates
6. **Complete the task** — the runner will re-run verification before marking done

### Do NOT:

- Start from scratch — your branch has the previous work
- Create a new PR if one exists — push to the existing branch
- Skip running verification locally — the runner will catch you anyway
- Ignore the failure context — it tells you exactly what to fix

## Setting Up Verification for New Tasks

When creating a task that should be verified, include `verificationCommand` in the context:

```
buildd action=create_task params={
  "title": "feat: add user auth",
  "description": "Implement OAuth login flow",
  "verificationCommand": "bun test && bun run build",
  "maxIterations": 3
}
```

The verification command runs in the worktree after the agent completes. Common commands:

| Project Type | Verification Command |
|-------------|---------------------|
| TypeScript/Next.js | `bun test && bun run build` |
| Rust | `cargo test && cargo clippy` |
| Python | `pytest && mypy .` |
| Go | `go test ./... && go vet ./...` |

## Creating a Retry Task Manually

If you detect a failure and want to create a retry yourself (instead of waiting for CI):

```
buildd action=create_task params={
  "title": "Retry: fix failing tests",
  "description": "Previous attempt failed: [error details]",
  "parentTaskId": "original-task-id",
  "baseBranch": "buildd/abc12345-original-branch",
  "verificationCommand": "bun test && bun run build",
  "iteration": 2,
  "maxIterations": 5,
  "failureContext": "Test failed: expected 200 got 500 in auth.test.ts"
}
```

## Verification Best Practices

1. **Keep verification commands fast** — under 5 minutes. If your test suite takes longer, use a focused subset.
2. **Make failure output actionable** — include file paths and line numbers when possible.
3. **Set reasonable maxIterations** — 3 for simple fixes, 5 for complex features. More than 5 usually means the approach is wrong.
4. **Run verification locally before completing** — don't rely solely on the runner's gate.

## Escalation

| Situation | Action |
|-----------|--------|
| Iteration = maxIterations and still failing | Stop. Report what's failing and why attempts haven't worked. |
| Verification passes locally but fails in CI | Check environment differences (Node version, env vars, dependencies). |
| Previous attempt's code is fundamentally wrong | Say so in your completion. Don't perpetuate a bad approach. |
| Flaky test causing failures | Identify the flaky test, fix or skip it, note in completion summary. |
