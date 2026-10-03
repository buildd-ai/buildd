---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# execution-cluster-selection and context-assembly genuinely shipped (the "Done
# (PR #2138)" block of the Implementation sketch) but the doc must stay 'partially'
# until durable-context-assembly-table (sketch step 6, the assembly table) ships too,
# so those two would be reclassified code_ahead and redispatched forever under a
# non-terminal status. Suppressed below (skip_until) rather than left to redispatch
# a reconcile-spec task against an already-accurate doc.
assertions:
  - id: "execution-cluster-selection"
    type: "symbol"
    name: "selectExecCluster"
    path: "packages/core/retrieval-clusters.ts"
    skip_until: "2026-12-19"
    skip_reason: "selectExecCluster genuinely shipped (the Done / PR #2138 block of the Implementation sketch) — this isn't a false positive — but the doc must stay 'partially' until durable-context-assembly-table (sketch step 6, the assembly table) ships, so this assertion will pass forever under a non-terminal status. durable-context-assembly-table is the assertion that tracks real remaining progress."
  - id: "context-assembly"
    type: "symbol"
    name: "ContextAssembly"
    path: "packages/core/retrieval-clusters.ts"
    skip_until: "2026-12-19"
    skip_reason: "ContextAssembly genuinely shipped (the Done / PR #2138 block of the Implementation sketch — the assembly record) — this isn't a false positive — but the doc must stay 'partially' until durable-context-assembly-table (sketch step 6, the assembly table) ships, so this assertion will pass forever under a non-terminal status. durable-context-assembly-table is the assertion that tracks real remaining progress."
  - id: "durable-context-assembly-table"
    type: "config_key"
    key: "assembly_id"
    file: "packages/core/db/schema.ts"
---

# mission-context-clusters

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/mission-context-clusters.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
