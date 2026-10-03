---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "tier-registry-resolution"
    type: "symbol"
    name: "resolveTierEntry"
    path: "packages/core/model-tier-registry.ts"
  - id: "model-routing"
    type: "symbol"
    name: "resolveEffectiveModel"
    path: "packages/core/model-router.ts"
  - id: "tier-registry-surface-precedence"
    type: "symbol"
    name: "pickRegistryRow"
    path: "packages/core/model-tier-registry.ts"
  - id: "tier-registry-tests"
    type: "test_file"
    path: "packages/core/__tests__/model-tier-registry.test.ts"
  - id: "claim-resolves-model"
    type: "symbol_reachable"
    symbol: "resolveEffectiveModel"
    entry: "apps/web/src/app/api/workers/claim/route.ts"
    as: "read"
---

# model-tiers

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/model-tiers.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
