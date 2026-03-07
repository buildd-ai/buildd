# Buildd Workflow

Enforced workflow for buildd tasks. Not suggestions — process.

## Lifecycle

```
claim → understand → plan → implement (TDD) → verify → PR → complete
```

## Steps

1. `buildd action=claim_task` — get task, branch, worker ID
2. **Understand** — read task, search memory, read files you'll modify
3. **Plan** — list files, changes, and tests before writing code
4. **Implement with TDD** — failing test first, then minimal code, then refactor
5. **Verify** — run full test suite, build, type check. Evidence, not promises.
6. `buildd action=create_pr` — never `gh pr create`
7. `buildd action=complete_task` — with summary

## Non-Negotiables

- No production code without a failing test first (when there's logic)
- No completion claims without running verification
- No commits to `main` or `dev` directly — use the assigned branch
- No skipping tests to save time
- Always use `buildd action=create_pr`, never `gh`
- Stop immediately on 409 (worker terminated)
- Check progress responses for admin instructions

## Escalation

- 3+ failed fixes → question the approach, describe what you tried
- Change spans >3 subsystems → present plan for review first
- Stuck >2 attempts → stop, describe problem, ask for guidance

## Anti-Shortcuts

"I'll add tests later" → No. Now.
"Too simple to test" → If it has logic, test it.
"I'll skip the build check" → Run it.
"I'll read the code later" → Read it first.
