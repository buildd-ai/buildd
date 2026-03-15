---
name: buildd-workflow
description: "Workflow skill that helps agents work effectively in buildd. Enforces disciplined development — TDD, quality gates, proper planning, progress reporting, and no shortcuts."
author: buildd
---

# Buildd Workflow Skill

Enforced workflow for agents working in buildd. Not suggestions — process.

## When to Use This Skill

- Starting work on a buildd task
- Need a refresher on the claim → work → ship lifecycle
- Unsure about quality gates, TDD enforcement, or escalation rules

## Task Lifecycle

```
claim → understand → plan → implement (TDD) → verify → PR → document → complete
```

---

## Step 1: Claim a Task

```
buildd action=claim_task
```

You'll receive:
- **Worker ID** — your identity for all subsequent calls
- **Branch name** — the git branch to work on
- **Task description** — what to build/fix
- **Relevant memories** — prior context from workspace knowledge base
- **Open PRs** — concurrent work by other agents (avoid conflicting files)

Save the worker ID. You need it for every subsequent call.

## Step 2: Understand Before Acting

**Gate: Do not write any code until you understand the problem and the codebase.**

1. Read the task description fully
2. Search workspace memory for relevant context:
   ```
   buildd_memory action=search params={ "query": "relevant topic" }
   ```
3. Read every file you plan to modify
4. Read related tests
5. Check how similar features are implemented
6. If Open PRs were returned, check which files they touch

Report understanding:
```
buildd action=update_progress params={ "progress": 10, "message": "Reviewed codebase, identified files to change" }
```

## Step 3: Plan the Work

**Gate: Have a concrete plan before writing code.**

For anything beyond a trivial fix, create a plan listing:
- Each file to modify and the change in that file
- The test that validates each change
- The verification command to run

For tasks with `planRequired: true`, submit formally:
```
buildd action=update_progress params={
  "plan": "## Changes\n1. `packages/core/db/schema.ts` — add column X\n2. `apps/web/src/app/api/tasks/route.ts` — handle new field\n\n## Tests\n- Test 1: verify column migration\n- Test 2: API returns new field\n\n## Verification\n- `bun run build` passes\n- `bun test` passes"
}
```

**Wait for approval** before writing any code if plan was submitted.

### Adaptive Rigor

Match planning depth to task complexity:

| Task | Workflow |
|------|----------|
| Typo / config fix | Direct fix → verify → commit |
| Single-function change | Mental plan → implement → test → commit |
| Feature (1-3 files) | Written plan → TDD → review → PR |
| Multi-file feature | Detailed plan → TDD with subagents → review → PR |
| Architecture change | Plan → human approval → phased execution → review each phase |

## Step 4: Implement with TDD

**Gate: No production code without a failing test first.**

Follow strict RED-GREEN-REFACTOR:

1. **RED** — Write a failing test that defines the expected behavior
2. **GREEN** — Write the minimum code to make the test pass
3. **REFACTOR** — Clean up without changing behavior, tests still pass
4. Repeat for each change in the plan

```bash
git checkout <branch-name>
# Write test first → run it → watch it fail
# Write implementation → run test → watch it pass
# Refactor → run test → still passes
```

Report progress at milestones:
```
buildd action=update_progress params={ "progress": 25, "message": "Tests written for new endpoint" }
buildd action=update_progress params={ "progress": 50, "message": "Core implementation passing tests" }
```

### When TDD Doesn't Apply

Not everything needs a test-first approach:
- Config changes, documentation, migrations — verify by running/building instead
- UI-only changes without logic — visual verification is acceptable
- But if there's logic, there's a test.

## Step 5: Verify Before Claiming Done

**Gate: No completion claims without fresh verification evidence.**

Before creating a PR, run and confirm:

1. **Tests pass**: Run the full test suite, not just your new tests
2. **Build succeeds**: `bun run build` (or the relevant build command)
3. **Types check**: `npx tsc --noEmit` for TypeScript projects
4. **No regressions**: Verify you haven't broken existing functionality

```
buildd action=update_progress params={ "progress": 75, "message": "All tests passing, build clean, ready for PR" }
```

Do NOT skip verification to save time. Run the commands. Read the output. Report what you found.

## Step 6: Push and Create PR

```bash
git add -A
git commit -m "feat: description of changes"
git push origin <branch-name>
```

Create the PR through buildd (never `gh pr create`):
```
buildd action=create_pr params={
  "title": "feat: description of changes",
  "head": "<branch-name>",
  "body": "## Changes\n- What changed and why\n\n## Testing\n- Tests added/modified\n- Verification commands run and their output"
}
```

**PR rules**:
- Conventional title format: `feat:`, `fix:`, `refactor:`, `ci:`, `docs:`
- Target `dev` for features, `main` only for hotfixes
- Keep PRs under 400 lines when possible — split larger changes

## Step 7: Document What You Did

**Gate: No task completion without a summary artifact and relevant memory entries.**

Before calling `complete_task`, capture what you did so future agents and reviewers can understand the work without reading every commit.

### Write a Summary Artifact

Create a summary artifact that captures the key decisions, changes, and gotchas:

```
buildd action=create_artifact params={
  "type": "summary",
  "title": "Summary: <task title>",
  "content": "## What Changed\n- <file/area>: <what and why>\n\n## Key Decisions\n- <decision>: <reasoning>\n\n## Gotchas / Things to Know\n- <anything surprising or non-obvious>\n\n## Files Changed\n- `path/to/file.ts` — <what changed>\n\n## Testing\n- <what was tested and how>"
}
```

The summary should answer: *What changed? Why this approach? What should the next person know?*

### Save Workspace Memories

Save anything you learned that future agents should know — patterns, gotchas, architectural decisions:

```
buildd_memory action=save params={
  "type": "discovery",
  "title": "How X works in this codebase",
  "content": "Explanation of the pattern, gotcha, or insight",
  "files": ["path/to/relevant/file.ts"],
  "tags": ["relevant", "tags"]
}
```

**What to save as memory:**
- Non-obvious patterns you discovered (type: `pattern`)
- Gotchas that tripped you up or almost did (type: `gotcha`)
- Architecture decisions you made or uncovered (type: `architecture`)
- Discoveries about how something works (type: `discovery`)

**What NOT to save:**
- Task-specific details (that's what the summary artifact is for)
- Things already documented in code comments or docs
- Obvious patterns any agent would find by reading the code

### Skip Conditions

You can skip the summary artifact for:
- Trivial changes (typo fixes, config tweaks, single-line changes)
- Failed tasks (the error message in `complete_task` is sufficient)

You should still save memories even for trivial tasks if you discovered something non-obvious.

## Step 8: Complete the Task

```
buildd action=complete_task params={
  "summary": "Added X feature. Created migration, updated API, added tests. PR #123."
}
```

If the task failed:
```
buildd action=complete_task params={
  "error": "Could not complete because X. Attempted Y but Z blocked progress."
}
```

---

## Non-Negotiables

These rules apply to every task regardless of size or urgency:

- **Never commit directly to `main` or `dev`** — use the assigned branch
- **Never skip tests to save time** — if there's logic, there's a test
- **Never use `gh pr create`** — buildd can't track PRs it didn't create
- **Never use `db:push` in production** — use `db:generate` + `db:migrate`
- **Never claim completion without running verification** — evidence, not promises
- **Always check progress responses for admin instructions** — they override your plan
- **Always stop on 409** — your worker was terminated, do not push/commit/PR

## Escalation Rules

Know when to stop and involve a human:

| Trigger | Action |
|---------|--------|
| 3+ failed attempts at the same fix | Stop patching. Question the approach. Describe what you tried. |
| Change affects >3 unrelated subsystems | Present plan for review before executing |
| Blocked on external dependency or missing access | Report blocker, move to next task if possible |
| Test suite broken before your changes | Report the pre-existing failure, don't paper over it |
| Stuck for >2 attempts with no progress | Stop. Describe the problem and what you've tried. Ask for guidance. |
| DB migration needed | Flag for human review before applying in production |

## Anti-Shortcut Guardrails

Thoughts that indicate you're about to take a shortcut:

- "I'll add tests later" — No. Write the test now.
- "This is too simple to need a test" — If it has logic, it needs a test.
- "I'll just skip the build check, my changes are small" — Run it anyway.
- "Let me just fix this quick without reading the existing code" — Read first.
- "The existing tests are probably fine, I don't need to run them" — Run them.
- "I can commit to dev directly, it's just a small fix" — Use the branch.
- "I'll clean this up in a follow-up PR" — Clean it up now.

## Using Workspace Memory

### Search Before You Start
```
buildd_memory action=search params={ "query": "relevant topic" }
```

### Save What You Learn
```
buildd_memory action=save params={
  "type": "discovery",
  "title": "How to handle X in this codebase",
  "content": "Explanation of the pattern or solution",
  "concepts": ["relevant", "tags"]
}
```

Save: non-obvious patterns, gotchas, architecture decisions. Don't save: task-specific details or things already in docs.

## Avoiding Conflicts with Other Agents

When claim_task returns Open PRs:
1. Check which files those PRs touch
2. Rebase on top of the other agent's branch if overlapping
3. Or coordinate changes to non-overlapping sections
4. At minimum, note the conflict risk in your PR description

## Quick Reference

| Action | When |
|--------|------|
| `buildd action=claim_task` | Start of work |
| `buildd action=update_progress` | At 10% (understood), 25% (tests written), 50% (implementation), 75% (verified) |
| `buildd action=create_pr` | After pushing commits |
| `buildd action=create_artifact` | After PR, before completing — write a summary of what changed and why |
| `buildd action=complete_task` | After summary artifact is created |
| `buildd_memory action=search` | Before starting, when stuck |
| `buildd_memory action=save` | After discovering something useful — patterns, gotchas, decisions |
