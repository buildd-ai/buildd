---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "task-phase"
    type: "symbol"
    name: "deriveTaskPhase"
    path: "apps/web/src/lib/task-presentation.ts"
  - id: "task-intensity"
    type: "symbol"
    name: "deriveIntensity"
    path: "apps/web/src/lib/task-presentation.ts"
  - id: "task-presentation-tests"
    type: "test_file"
    path: "apps/web/src/lib/task-presentation.test.ts"
---

# task-presentation

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/task-presentation.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
