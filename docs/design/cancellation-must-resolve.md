---
status: superseded
superseded_by: docs/specs/mission-task-lifecycle.md#claim-gate-legibility-contract
superseded_on: 2026-09-19
superseded_reason: >
  This doc proposed a hard/soft dependsOn edge-type split, a `cancel_task` MCP
  action with a required disposition enum, and a stranded condition derived
  from hard-edge-parent-terminal-not-completed. None of that shipped —
  `tasks.dependsOn` is still a plain string[], there is no edgeType, and no
  `cancel_task` action exists. The problem was instead closed by a simpler,
  uniform design: every dependsOn edge is satisfied by any terminal parent
  status via one shared contract module (`dep-gate-contract.ts`, PR #1867 —
  CG-4/CG-5 in the shipped contract), so cancelling a task IS the disposition,
  with no separate enum needed. Stranding is caught generically by a
  claim-deferral sweep (`stranded-tasks-sweep.ts`, PR #2388) unrelated to
  dependsOn specifically, not by the hard-edge-derived condition this doc
  proposed.
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "cancel-disposition"
    type: "symbol_reachable"
    symbol: "dependentDisposition"
    entry: "apps/web/src/app/api/tasks/[id]/route.ts"
    as: "read"
  - id: "hard-edge-gate"
    type: "symbol_reachable"
    symbol: "hardDependsOn"
    entry: "apps/web/src/app/api/workers/claim/deps-gate.ts"
    as: "read"
  - id: "shared-dependency-gate"
    type: "symbol"
    name: "isGateSatisfied"
    path: "apps/web/src/lib/task-presentation.ts"
---

# cancellation-must-resolve

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/cancellation-must-resolve.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
