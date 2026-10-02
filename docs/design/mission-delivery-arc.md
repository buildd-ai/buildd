---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "mission-integration-pr"
    type: "symbol"
    name: "openMissionIntegrationPr"
    path: "apps/web/src/lib/mission-pr.ts"
  - id: "release-attribution"
    type: "symbol"
    name: "attributeRelease"
    path: "packages/core/release-attribution.ts"
  - id: "release-attribution-tests"
    type: "test_file"
    path: "packages/core/__tests__/release-attribution.test.ts"
---

# mission-delivery-arc

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/mission-delivery-arc.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
