---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# failure-classification-contract intentionally fails: the packages/core two-arg
# classifyFailure(error, pattern) contract this doc specifies was never built.
# apps/web/src/lib/failure-classifier.ts is a pre-existing, unrelated single-arg
# classifier — it does not satisfy this assertion. Fix the assertion only once
# the §1 primitive actually ships. select-failover, manual-provider-switch, and
# backend-policy-tests pass because §§3/6 (bidirectional direction, manual
# override) genuinely shipped, exactly as scoped — see "What Has Shipped" /
# "What Has Not" below for the full picture. Per-assertion classification
# flags any passing assertion under this doc's non-terminal `partially` status
# as code_ahead regardless of whether the doc's own prose already says so, so
# these three are suppressed below (skip_until) rather than left to redispatch
# a reconcile-spec task against an already-accurate doc; re-verify and either
# renew or drop the suppression once failure-classification-contract ships and
# the doc can promote to `implemented`.
assertions:
  - id: "select-failover"
    type: "symbol"
    name: "pickFailoverBackend"
    path: "packages/core/backend-policy.ts"
    skip_until: "2026-12-19"
    skip_reason: "pickFailoverBackend genuinely shipped (§3/What Has Shipped) — this isn't a false positive — but the doc must stay 'partially' until failure-classification-contract ships, so this assertion will pass forever under a non-terminal status. failure-classification-contract is the assertion that tracks real remaining progress."
  - id: "manual-provider-switch"
    type: "route"
    method: "POST"
    path: "/api/tasks/[id]/reassign"
    file: "apps/web/src/app/api/tasks/[id]/reassign/route.ts"
    skip_until: "2026-12-19"
    skip_reason: "The manual reassign route genuinely shipped (§6/What Has Shipped) — this isn't a false positive — but the doc must stay 'partially' until failure-classification-contract ships, so this assertion will pass forever under a non-terminal status. failure-classification-contract is the assertion that tracks real remaining progress."
  - id: "backend-policy-tests"
    type: "test_file"
    path: "packages/core/__tests__/backend-policy.test.ts"
    skip_until: "2026-12-19"
    skip_reason: "backend-policy.test.ts genuinely covers the shipped pickFailoverBackend (§3/What Has Shipped) — this isn't a false positive — but the doc must stay 'partially' until failure-classification-contract ships, so this assertion will pass forever under a non-terminal status. failure-classification-contract is the assertion that tracks real remaining progress."
  - id: "failure-classification-contract"
    type: "symbol"
    name: "classifyFailure"
    path: "packages/core/failure-classification.ts"
---

# backend-failover-policy

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/backend-failover-policy.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
