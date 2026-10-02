---
status: phase
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "initiative-progress"
    type: "symbol"
    name: "computeInitiativeProgress"
    path: "packages/core/mission-helpers.ts"
  - id: "linear-progress-adapter"
    type: "symbol"
    name: "fetchLinearProgress"
    path: "apps/web/src/lib/work-tracker.ts"
  - id: "initiatives-table"
    type: "symbol"
    name: "initiatives"
    path: "packages/core/db/schema.ts"
---

# linear-hierarchy-ingest

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/linear-hierarchy-ingest.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
