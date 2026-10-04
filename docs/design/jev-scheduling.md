---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# Each assertion names a deliverable of one implementation step, so the derived
# status moves from failing to implemented as the steps land.
assertions:
  - id: "readout-cron-route"
    type: "route"
    method: "GET"
    path: "/api/cron/orchestration-readout"
    file: "apps/web/src/app/api/cron/orchestration-readout/route.ts"
  - id: "silent-completion-predicate"
    type: "symbol"
    name: "isSilentCompletion"
    path: "apps/web/src/lib/silent-completion.ts"
  - id: "silent-completion-gated"
    type: "symbol_reachable"
    symbol: "isSilentCompletion"
    entry: "apps/web/src/app/api/workers/[id]/route.ts"
    as: "call"
  - id: "tree-pinned-candidates"
    type: "symbol"
    name: "getServerTreeCandidateAdapter"
    path: "packages/core/manifest-prediction-source.ts"
  - id: "prediction-on-plan-approval"
    type: "symbol_reachable"
    symbol: "scheduleCreationManifestShadow"
    entry: "apps/web/src/lib/approve-plan.ts"
    as: "call"
  - id: "supersession-reconciler"
    type: "symbol"
    name: "reconcileSubjectEvent"
    path: "apps/web/src/lib/supersession.ts"
  - id: "supersession-rules"
    type: "symbol"
    name: "SUPERSESSION_RULES"
    path: "apps/web/src/lib/supersession.ts"
  - id: "claim-planner"
    type: "symbol"
    name: "planClaimBatch"
    path: "packages/core/claim-planner.ts"
  - id: "claim-planner-wired"
    type: "symbol_reachable"
    symbol: "planClaimBatch"
    entry: "apps/web/src/app/api/workers/claim/route.ts"
    as: "call"
    skip_until: "2026-12-15"
    skip_reason: "Wired and passing, but the planner does not order claims yet. The evaluation step found no record-mode evidence: the work has not reached a release and no workspace has opted in, so the readout is insufficient_n, the pinned thresholds stay null and no workspace runs apply. Suppressed so the design holds at 'partially' until a readout earns the flip. Contract: docs/specs/claim-ordering.md."
  - id: "claim-planner-tests"
    type: "test_file"
    path: "packages/core/__tests__/claim-planner.test.ts"
---

# jev-scheduling

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/jev-scheduling.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
