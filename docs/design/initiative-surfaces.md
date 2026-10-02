---
status: superseded
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "initiative-list"
    type: "route"
    method: "GET"
    path: "/api/initiatives"
    file: "apps/web/src/app/api/initiatives/route.ts"
  - id: "initiative-progress"
    type: "symbol"
    name: "computeInitiativeProgress"
    path: "packages/core/mission-helpers.ts"
  - id: "initiative-segments"
    type: "symbol"
    name: "computeInitiativeSegments"
    path: "packages/core/mission-helpers.ts"
---

# initiative-surfaces

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/initiative-surfaces.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
