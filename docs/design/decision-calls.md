---
status: implemented
# Structural conformance only; passing does not certify every prose invariant.
# Steps 1-6 shipped: the client, policy wiring, benchmark, the classifyTask
# shadow (since replaced) and the first confidence-gated apply.
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
---

# decision-calls

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/decision-calls.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
