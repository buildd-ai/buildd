---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "session-model-resolution"
    type: "symbol"
    name: "resolveSessionModel"
    path: "apps/runner/src/prompt-builder.ts"
  - id: "task-detail-resolved-model"
    type: "symbol_reachable"
    symbol: "predictedModel"
    entry: "apps/web/src/app/app/(protected)/tasks/[id]/page.tsx"
    as: "read"
  - id: "usage-model-tests"
    type: "test_file"
    path: "apps/web/src/lib/usage-stats.test.ts"
---

# task-model-visibility

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/task-model-visibility.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
