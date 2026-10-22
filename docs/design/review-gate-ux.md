---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "merge-pr"
    type: "route"
    method: "POST"
    path: "/api/prs/[prNumber]/merge"
    file: "apps/web/src/app/api/prs/[prNumber]/merge/route.ts"
  # Mission task sheets were retired; review checks load on the task page.
  - id: "task-page-review-checks"
    type: "symbol_reachable"
    symbol: "taskDeliverySections"
    entry: "apps/web/src/app/app/(protected)/tasks/[id]/page.tsx"
  - id: "resolve-dependents"
    type: "symbol"
    name: "checkDependsOnResolved"
    path: "apps/web/src/lib/task-dependencies.ts"
  - id: "reviewer-gate-tests"
    type: "test_file"
    path: "apps/web/src/lib/reviewer-gate.test.ts"
---

# review-gate-ux

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/review-gate-ux.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
