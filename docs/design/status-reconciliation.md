---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "mission-dependency-fallback"
    type: "symbol"
    name: "isMissionBlocked"
    path: "apps/web/src/lib/mission-dependency.ts"
  - id: "mission-health-derivation"
    type: "symbol"
    name: "deriveMissionHealth"
    path: "apps/web/src/lib/mission-helpers.ts"
  - id: "mission-dependency-tests"
    type: "test_file"
    path: "apps/web/src/lib/mission-dependency.test.ts"
---

# status-reconciliation

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/status-reconciliation.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
