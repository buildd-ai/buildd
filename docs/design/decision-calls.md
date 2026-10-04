---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
# Steps 1-6 shipped: the client, policy wiring, benchmark, the classifyTask
# shadow (since replaced) and the first confidence-gated apply. 2026-10-03:
# shadow-first retired as the default rollout; the decision ledger and
# task-role-routing's default-apply flip shipped (Point 2b). Then the
# measurable half: late outcome labels, out-of-band challengers and the
# collection-health readout.
assertions:
  - id: "decision-client"
    type: "symbol"
    name: "decisionCall"
    path: "packages/core/decision-client.ts"
  - id: "task-category-decision"
    type: "symbol"
    name: "categorizeTask"
    path: "apps/web/src/lib/task-category-decision.ts"
  - id: "gated-apply"
    type: "symbol"
    name: "gateTaskCategory"
    path: "apps/web/src/lib/task-category-decision.ts"
  - id: "decision-ledger-record"
    type: "symbol"
    name: "recordDecision"
    path: "packages/core/decision-ledger.ts"
  - id: "decision-ledger-query"
    type: "symbol"
    name: "queryDecisionLedger"
    path: "packages/core/decision-ledger.ts"
  - id: "task-role-apply-default"
    type: "symbol"
    name: "applyTaskRoleDecision"
    path: "apps/web/src/lib/task-role-apply.ts"
  - id: "decision-outcome-label"
    type: "symbol"
    name: "labelDecisionOutcome"
    path: "packages/core/decision-outcomes.ts"
  - id: "decision-challenger"
    type: "symbol"
    name: "runBuilddChallenger"
    path: "packages/core/decision-policy.ts"
  - id: "decision-readout"
    type: "symbol"
    name: "computeDecisionReadout"
    path: "packages/core/decision-readout.ts"
---

# decision-calls

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/decision-calls.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
