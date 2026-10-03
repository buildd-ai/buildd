---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# pr-refresh-seam and task-read-refresh-tests pass, but neither is evidence
# that this spec's migration shipped: refreshStaleWorkersForWorkspaces
# predates this doc (it backs home/page.tsx from PR #1883), and
# tasks/page.test.ts tests unrelated mission-budget plumbing, not the
# refresh-before-query behavior Step 1 calls for. See "Implementation
# Status" below for what has actually shipped.
assertions:
  - id: "pr-terminal-accessor"
    type: "symbol"
    name: "isPrTerminal"
    path: "apps/web/src/lib/task-presentation.ts"
  - id: "pr-refresh-seam"
    type: "symbol"
    name: "refreshStaleWorkersForWorkspaces"
    path: "apps/web/src/lib/pr-state-refresh.ts"
    skip_until: "2026-12-19"
    skip_reason: "Predates this doc (backs home/page.tsx since PR #1883); passing is not evidence Step 1 shipped. Structurally will always pass while status stays partially — see Implementation Status below."
  - id: "task-read-refresh-tests"
    type: "test_file"
    path: "apps/web/src/app/app/(protected)/tasks/page.test.ts"
    skip_until: "2026-12-19"
    skip_reason: "Tests unrelated mission-budget plumbing, not the refresh-before-query behavior Step 1 calls for. Structurally will always pass while status stays partially — see Implementation Status below."
---

# derived-state-accessors

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/derived-state-accessors.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
