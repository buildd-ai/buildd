---
status: accessor
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "mission-state-accessor"
    type: "symbol"
    name: "deriveMissionStateView"
    path: "apps/web/src/lib/mission-state-view.ts"
  - id: "mission-state-view"
    type: "symbol"
    name: "MissionStateView"
    path: "apps/web/src/lib/mission-state-view.ts"
  - id: "mission-state-view-tests"
    type: "test_file"
    path: "apps/web/src/lib/mission-state-view.test.ts"
---

# mission-state-ownership

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/mission-state-ownership.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
