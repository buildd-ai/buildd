---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "display-status"
    type: "symbol"
    name: "deriveDisplayStatus"
    path: "apps/web/src/lib/task-presentation.ts"
  - id: "timestamp-label"
    type: "symbol"
    name: "deriveTimestampLabel"
    path: "apps/web/src/lib/task-presentation.ts"
  - id: "timestamp-status-tests"
    type: "test_file"
    path: "apps/web/src/lib/task-presentation.test.ts"
---

# task-status-timestamps

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/task-status-timestamps.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
