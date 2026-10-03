---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# auto-merge-safety, green-ci-policy and migration-journal-guard all genuinely
# shipped (Candidates 2 and 4 below) but the doc must stay 'partially' until
# merge-order-edges' mergeAfter (Candidate 3) ships too, so those three would
# be reclassified code_ahead and redispatched forever under a non-terminal
# status. Suppressed below (skip_until) rather than left to redispatch.
assertions:
  - id: "auto-merge-safety"
    type: "symbol"
    name: "evaluateAutoMergeSafety"
    path: "apps/web/src/lib/auto-merge.ts"
    skip_until: "2026-12-19"
    skip_reason: "evaluateAutoMergeSafety genuinely shipped (Candidate 2, §Shipped note) — this isn't a false positive — but the doc must stay 'partially' until merge-order-edges (Candidate 3's mergeAfter) ships, so this assertion will pass forever under a non-terminal status. merge-order-edges is the assertion that tracks real remaining progress."
  - id: "green-ci-policy"
    type: "config_key"
    key: "enforceGreenCI"
    file: "packages/core/db/schema.ts"
    skip_until: "2026-12-19"
    skip_reason: "enforceGreenCI genuinely shipped (Candidate 2, §Shipped note) — this isn't a false positive — but the doc must stay 'partially' until merge-order-edges (Candidate 3's mergeAfter) ships, so this assertion will pass forever under a non-terminal status. merge-order-edges is the assertion that tracks real remaining progress."
  - id: "merge-order-edges"
    type: "config_key"
    key: "mergeAfter"
    file: "packages/shared/src/types.ts"
  - id: "migration-journal-guard"
    type: "test_file"
    path: "packages/core/__tests__/migration-journal-ordering.test.ts"
    skip_until: "2026-12-19"
    skip_reason: "migration-journal-ordering.test.ts genuinely covers the shipped Candidate 4 substitute (the CI-script guard, §Shipped note) — this isn't a false positive — but the doc must stay 'partially' until merge-order-edges (Candidate 3's mergeAfter) ships, so this assertion will pass forever under a non-terminal status. merge-order-edges is the assertion that tracks real remaining progress."
---

# convergence-layer

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/convergence-layer.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
