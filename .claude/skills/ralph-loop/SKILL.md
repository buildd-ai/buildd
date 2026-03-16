---
name: ralph-loop
description: "Verification loop skill for buildd tasks. Uses SDK Stop hook to re-feed the original prompt on each iteration until the agent outputs a completion promise — matching the Anthropic ralph-loop plugin pattern."
author: buildd
---

# Ralph Loop — Verification & Iteration Skill

Ralph loop implements the [Ralph Wiggum technique](https://ghuntley.com/ralph/) for iterative AI development. The runner's Stop hook intercepts session exit and re-feeds the **same original prompt** — the agent sees its previous file modifications and git history, creating a self-referential improvement loop.

This mirrors the official Anthropic `ralph-loop` plugin but runs inside the buildd runner via the SDK's Stop hook API.

## How It Works

```
Agent receives task prompt (with verification + completion instructions)
  |
  v
Agent works on the task
  |
  v
Agent tries to exit (session ends)
  |
  v
Stop hook fires:
  ├─ Found <promise>DONE</promise>? → Allow exit. Task completes.
  ├─ Max iterations reached?        → Allow exit. Log exhaustion.
  └─ Otherwise                      → Block exit. Re-feed same prompt.
                                       Agent sees its file changes.
                                       Loop continues.
```

The key insight: the prompt never changes between iterations. The agent's work persists in files and git. Each iteration, the agent reads its own previous work and iteratively improves.

## Task Context Fields

Configure ralph loop behavior via task context:

| Field | Default | Purpose |
|-------|---------|---------|
| `maxReviewIterations` | `2` | Max iterations before auto-stop (0 = unlimited) |
| `completionPromise` | `"DONE"` | Text that signals genuine completion |
| `verificationCommand` | none | Command to run before completing (e.g., `bun test && bun run build`) |

### CI Retry Fields (for retry tasks)

| Field | Meaning |
|-------|---------|
| `failureContext` | What failed in the previous attempt — read this first |
| `baseBranch` | Your worktree is based on the previous attempt's branch |
| `iteration` | Which attempt this is (1-indexed) |
| `maxIterations` | Stop after this many attempts |
| `prNumber` | Existing PR number (push fixes, don't create a new PR) |

## Completion Promise

To signal completion, the agent must output:

```
<promise>DONE</promise>
```

(Or whatever `completionPromise` is set to in task context.)

**CRITICAL**: Only output the promise when the statement is genuinely true. The loop is designed to continue until real completion — do not output false promises to escape.

## Verification Command

When `verificationCommand` is set, the prompt instructs the agent to run it before completing:

```bash
# Example: verificationCommand = "bun test && bun run build"
bun test && bun run build
```

The agent should:
1. Run the verification command
2. If it fails, fix the issues
3. Re-run until it passes
4. Only then output the completion promise

## Creating Tasks with Ralph Loop

```
buildd action=create_task params={
  "title": "feat: add user auth",
  "description": "Implement OAuth login flow",
  "verificationCommand": "bun test && bun run build",
  "completionPromise": "DONE",
  "maxReviewIterations": 5
}
```

Common verification commands:

| Project Type | Verification Command |
|-------------|---------------------|
| TypeScript/Next.js | `bun test && bun run build` |
| Rust | `cargo test && cargo clippy` |
| Python | `pytest && mypy .` |
| Go | `go test ./... && go vet ./...` |

## If You Are a Retry Task

1. **Read `failureContext`** — understand exactly what went wrong
2. **Your worktree already has the previous work** — don't start from scratch
3. **Fix the specific issue** — targeted fix, not a rewrite
4. **Run the verification command** before completing
5. **Push to the existing PR branch** if `prNumber` is set

## Best Practices

1. **Keep verification commands fast** — under 5 minutes. Use a focused subset for large test suites.
2. **Set reasonable maxReviewIterations** — 3 for simple fixes, 5 for complex features. More than 5 usually means the approach is wrong.
3. **Write clear task descriptions** — the same prompt is re-fed each iteration, so clarity compounds.
4. **Include success criteria** — explicit criteria help the agent know when to output the completion promise.

## Escalation

| Situation | Action |
|-----------|--------|
| Still failing after multiple iterations | Stop. Report what's failing and why attempts haven't worked. |
| Verification passes locally but fails in CI | Check environment differences (Node version, env vars, dependencies). |
| Previous attempt's code is fundamentally wrong | Say so in your completion. Don't perpetuate a bad approach. |
| Flaky test causing failures | Identify the flaky test, fix or skip it, note in completion summary. |

## Implementation

The ralph loop is implemented in the runner's Stop hook (`apps/runner/src/workers.ts`):

1. **Initialization**: When a session starts, `RalphLoopState` is created from task context and attached to the `WorkerSession`
2. **Stop hook**: On session exit, checks for `<promise>` tags in `last_assistant_message`. If not found, returns `{ decision: "block", reason: originalPrompt, systemMessage: "🔄 Ralph iteration N" }`
3. **Iteration tracking**: State tracks current iteration, logs milestones, and emits worker updates for the UI
4. **Cleanup**: On completion or exhaustion, ralph state is cleared and exit is allowed
