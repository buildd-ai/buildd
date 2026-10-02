---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "inference-client"
    type: "symbol"
    name: "inferenceCall"
    path: "packages/core/inference-client.ts"
    skip_until: "2026-12-15"
    skip_reason: "Shipped and stable (Step 1) — inferenceCall is exported and in production use by the judge. Kept suppressed rather than promoting the whole design to 'implemented': Step 5 (retiring resolveTierEntrySync) is still unbuilt, so status is intentionally held at 'partially'."
  - id: "criteria-use-inference-client"
    type: "symbol_reachable"
    symbol: "inferenceCall"
    entry: "apps/web/src/lib/mission-criteria-eval.ts"
    as: "read"
    skip_until: "2026-12-15"
    skip_reason: "Shipped and stable (Step 3) — judgeWithLLM in mission-criteria-eval.ts reads inferenceCall directly. Same rationale as inference-client above: this design stays 'partially' until Step 5 lands."
---

# inference-calls-primitive

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/inference-calls-primitive.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
