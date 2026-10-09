---
status: reference
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "task-card"
    type: "symbol"
    name: "TaskCard"
    path: "apps/web/src/components/TaskCard.tsx"
  - id: "mobile-header-tests"
    type: "test_file"
    path: "apps/web/src/components/MobilePageHeader.test.tsx"
---

# mobile-feed-spec

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/mobile-feed-spec.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
