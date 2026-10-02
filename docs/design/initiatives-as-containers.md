---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "initiative-card-builder"
    type: "symbol"
    name: "buildInitiativeCard"
    path: "apps/web/src/lib/initiative-view.ts"
  - id: "initiative-card-loader"
    type: "symbol"
    name: "loadInitiativeCards"
    path: "apps/web/src/lib/initiative-cards.ts"
  - id: "initiative-card-component"
    type: "symbol"
    name: "InitiativeCard"
    path: "apps/web/src/components/initiatives/InitiativeCard.tsx"
  - id: "initiative-card-tests"
    type: "test_file"
    path: "apps/web/src/lib/initiative-view.test.ts"
---

# initiatives-as-containers

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/initiatives-as-containers.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
