---
status: proposed
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "tiered-count"
    type: "symbol"
    name: "countByTier"
    path: "packages/core/task-count.ts"
  - id: "tiered-count-tests"
    type: "test_file"
    path: "packages/core/__tests__/task-count.test.ts"
  - id: "mission-api-tier-counts"
    type: "symbol_reachable"
    symbol: "tierCounts"
    entry: "apps/web/src/app/api/missions/[id]/route.ts"
    as: "read"
---

# task-tier-presentation

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/task-tier-presentation.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
