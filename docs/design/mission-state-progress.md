---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "drive-state"
    type: "symbol"
    name: "deriveDriveState"
    path: "apps/web/src/lib/mission-helpers.ts"
  - id: "task-health"
    type: "symbol"
    name: "deriveTaskHealthSignal"
    path: "apps/web/src/lib/mission-helpers.ts"
  - id: "mission-progress"
    type: "symbol"
    name: "computeMissionProgress"
    path: "packages/core/mission-helpers.ts"
---

# mission-state-progress

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/mission-state-progress.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
