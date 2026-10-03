---
status: spec
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "visibility-filter"
    type: "symbol"
    name: "visibilityFilter"
    path: "apps/web/src/lib/task-visibility.ts"
  - id: "oauth-client-owner"
    type: "config_key"
    key: "ownerClientId"
    file: "packages/core/db/schema.ts"
---

# private-task-execution

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/private-task-execution.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
