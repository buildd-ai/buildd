---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "task-grid"
    type: "symbol"
    name: "TaskGrid"
    path: "apps/web/src/app/app/(protected)/tasks/TaskGrid.tsx"
  - id: "task-grid-tests"
    type: "test_file"
    path: "apps/web/src/app/app/(protected)/tasks/TaskGrid.test.ts"
---

# mobile-filter-pattern

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/mobile-filter-pattern.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
