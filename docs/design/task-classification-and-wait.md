---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "task-class-derivation"
    type: "symbol"
    name: "deriveTaskType"
    path: "packages/core/mission-helpers.ts"
  - id: "deliverable-predicate"
    type: "symbol"
    name: "isDeliverableTask"
    path: "packages/core/mission-helpers.ts"
  - id: "task-class-invariants"
    type: "test_file"
    path: "packages/core/__tests__/task-class-invariants.test.ts"
---

# task-classification-and-wait

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/task-classification-and-wait.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
