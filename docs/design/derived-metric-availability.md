---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "derived-metric-type"
    type: "symbol"
    name: "DerivedMetric"
    path: "packages/core/derived-metric.ts"
  - id: "unavailable-result"
    type: "symbol"
    name: "derivedUnavailable"
    path: "packages/core/derived-metric.ts"
  - id: "mission-progress-metric"
    type: "symbol"
    name: "deriveMissionProgressMetric"
    path: "packages/core/mission-helpers.ts"
  - id: "derived-metric-tests"
    type: "test_file"
    path: "packages/core/__tests__/derived-metric.test.ts"
---

# derived-metric-availability

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/derived-metric-availability.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
