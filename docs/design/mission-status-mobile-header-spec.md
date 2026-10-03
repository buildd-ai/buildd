---
status: normative
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "mission-health-groups"
    type: "symbol"
    name: "healthToGroup"
    path: "apps/web/src/lib/mission-helpers.ts"
  - id: "filter-group-map"
    type: "symbol"
    name: "FILTER_TO_GROUPS"
    path: "apps/web/src/lib/mission-helpers.ts"
  - id: "mobile-header-tests"
    type: "test_file"
    path: "apps/web/src/components/MobilePageHeader.test.tsx"
---

# mission-status-mobile-header-spec

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/mission-status-mobile-header-spec.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
