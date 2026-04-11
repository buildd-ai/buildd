---
name: ralph-loop
description: "Verification loop skill for buildd tasks. Teaches agents to run verification gates locally, handle failures, and iterate until passing."
author: buildd
---

# Ralph Loop — Verification & Retry Skill

Verification loop pattern for buildd tasks. When a task has a verification command, agents should run it locally before completing. If it fails, fix the issues and retry — all within the same session to preserve full context.

## When to Use This Skill

- Task context includes `verificationCommand`
- Task context includes `failureContext` (you're a retry attempt)
- You want to verify your work before completing a task

## How the Loop Works

```
Agent works on task
  |
  v
Agent completes work
  |
  v
Agent runs verificationCommand locally (if set in task context)
  |
  ├─ PASS → complete the task, create PR
  |
  └─ FAIL → fix the issues, re-run verification
            (repeat until pass or you're stuck)
```

Verification runs in-session — the agent keeps full context of what it tried and why it failed. No new tasks are created for retries.

## If You Are a Retry Task

Check your task context for these fields:

| Field | Meaning |
|-------|---------|
| `failureContext` | What failed in the previous attempt — read this first |
| `baseBranch` | Your worktree is based on the previous attempt's branch |
| `iteration` | Which attempt this is (1-indexed) |
| `maxIterations` | Stop after this many attempts |
| `verificationCommand` | The command to run before completing |
| `prNumber` | Existing PR number (push fixes, don't create a new PR) |

### Retry Workflow

1. **Read the failure context** — understand exactly what went wrong
2. **Your worktree already has the previous work** — don't start from scratch
3. **Fix the specific issue** — targeted fix, not a rewrite
4. **Run the verification command locally**:
   ```bash
   # Run whatever verificationCommand says, e.g.:
   bun test && bun run build
   ```
5. **If there's an existing PR**, push to the same branch — it auto-updates
6. **Complete the task** once verification passes

### Do NOT:

- Start from scratch — your branch has the previous work
- Create a new PR if one exists — push to the existing branch
- Skip running verification locally — always verify before completing
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

Common verification commands:

| Project Type | Verification Command |
|-------------|---------------------|
| TypeScript/Next.js | `bun test && bun run build` |
| Rust | `cargo test && cargo clippy` |
| Python | `pytest && mypy .` |
| Go | `go test ./... && go vet ./...` |

## Verification Best Practices

1. **Keep verification commands fast** — under 5 minutes. If your test suite takes longer, use a focused subset.
2. **Make failure output actionable** — include file paths and line numbers when possible.
3. **Set reasonable maxIterations** — 3 for simple fixes, 5 for complex features. More than 5 usually means the approach is wrong.
4. **Always run verification locally before completing** — don't skip this step.

## Escalation

| Situation | Action |
|-----------|--------|
| Still failing after multiple attempts | Stop. Report what's failing and why attempts haven't worked. |
| Verification passes locally but fails in CI | Check environment differences (Node version, env vars, dependencies). |
| Previous attempt's code is fundamentally wrong | Say so in your completion. Don't perpetuate a bad approach. |
| Flaky test causing failures | Identify the flaky test, fix or skip it, note in completion summary. |
