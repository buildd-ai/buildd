---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# Each assertion names a deliverable of one implementation step, so the derived
# status moves from failing to implemented as the steps land.
#
# 'partially' is deliberate, not drift. Every unsuppressed assertion passes, but
# claim-planner-wired is held under skip_until, and a suppressed assertion
# derives as 'partial' — declaring 'implemented' here would fail the
# declared-ahead-of-derived check. The doc reaches 'implemented' only when the
# planner actually orders claims: a record-mode readout pins thresholds in
# CLAIM_PLANNER_CALIBRATION (packages/core/claim-planner.ts), the suppression is
# removed, and the status flips in the same PR.
#
# The other assertions name deliverables that have shipped. They pass for real,
# so they are suppressed with the same review date rather than left as standing
# code_ahead rows. Lift all of the suppressions together when the status flips.
assertions:
  - id: "readout-cron-route"
    type: "route"
    method: "GET"
    path: "/api/cron/orchestration-readout"
    file: "apps/web/src/app/api/cron/orchestration-readout/route.ts"
    skip_until: "2026-12-15"
    skip_reason: "The orchestration readout cron route genuinely shipped and belongs to this design, so this is not a false positive. But the doc must stay 'partially' until the planner actually orders claims (claim-planner-wired, held until a record-mode readout pins CLAIM_PLANNER_CALIBRATION), so this would pass forever under a non-terminal status. claim-planner-wired tracks the remaining work; lift this suppression in the PR that flips the status to 'implemented'."
  - id: "silent-completion-predicate"
    type: "symbol"
    name: "isSilentCompletion"
    path: "apps/web/src/lib/silent-completion.ts"
    skip_until: "2026-12-15"
    skip_reason: "The silent-completion predicate genuinely shipped and belongs to this design, so this is not a false positive. But the doc must stay 'partially' until the planner actually orders claims (claim-planner-wired, held until a record-mode readout pins CLAIM_PLANNER_CALIBRATION), so this would pass forever under a non-terminal status. claim-planner-wired tracks the remaining work; lift this suppression in the PR that flips the status to 'implemented'."
  - id: "silent-completion-gated"
    type: "symbol_reachable"
    symbol: "isSilentCompletion"
    entry: "apps/web/src/app/api/workers/[id]/route.ts"
    as: "call"
    skip_until: "2026-12-15"
    skip_reason: "The silent-completion gate in the worker update route genuinely shipped and belongs to this design, so this is not a false positive. But the doc must stay 'partially' until the planner actually orders claims (claim-planner-wired, held until a record-mode readout pins CLAIM_PLANNER_CALIBRATION), so this would pass forever under a non-terminal status. claim-planner-wired tracks the remaining work; lift this suppression in the PR that flips the status to 'implemented'."
  - id: "tree-pinned-candidates"
    type: "symbol"
    name: "getServerTreeCandidateAdapter"
    path: "packages/core/manifest-prediction-source.ts"
    skip_until: "2026-12-15"
    skip_reason: "Tree-pinned manifest candidates genuinely shipped and belongs to this design, so this is not a false positive. But the doc must stay 'partially' until the planner actually orders claims (claim-planner-wired, held until a record-mode readout pins CLAIM_PLANNER_CALIBRATION), so this would pass forever under a non-terminal status. claim-planner-wired tracks the remaining work; lift this suppression in the PR that flips the status to 'implemented'."
  - id: "prediction-on-plan-approval"
    type: "symbol_reachable"
    symbol: "scheduleCreationManifestShadow"
    entry: "apps/web/src/lib/approve-plan.ts"
    as: "call"
    skip_until: "2026-12-15"
    skip_reason: "Manifest prediction on plan approval genuinely shipped and belongs to this design, so this is not a false positive. But the doc must stay 'partially' until the planner actually orders claims (claim-planner-wired, held until a record-mode readout pins CLAIM_PLANNER_CALIBRATION), so this would pass forever under a non-terminal status. claim-planner-wired tracks the remaining work; lift this suppression in the PR that flips the status to 'implemented'."
  - id: "supersession-reconciler"
    type: "symbol"
    name: "reconcileSubjectEvent"
    path: "apps/web/src/lib/supersession.ts"
    skip_until: "2026-12-15"
    skip_reason: "The supersession reconciler genuinely shipped and belongs to this design, so this is not a false positive. But the doc must stay 'partially' until the planner actually orders claims (claim-planner-wired, held until a record-mode readout pins CLAIM_PLANNER_CALIBRATION), so this would pass forever under a non-terminal status. claim-planner-wired tracks the remaining work; lift this suppression in the PR that flips the status to 'implemented'."
  - id: "supersession-rules"
    type: "symbol"
    name: "SUPERSESSION_RULES"
    path: "apps/web/src/lib/supersession.ts"
    skip_until: "2026-12-15"
    skip_reason: "The supersession rule table genuinely shipped and belongs to this design, so this is not a false positive. But the doc must stay 'partially' until the planner actually orders claims (claim-planner-wired, held until a record-mode readout pins CLAIM_PLANNER_CALIBRATION), so this would pass forever under a non-terminal status. claim-planner-wired tracks the remaining work; lift this suppression in the PR that flips the status to 'implemented'."
  - id: "claim-planner"
    type: "symbol"
    name: "planClaimBatch"
    path: "packages/core/claim-planner.ts"
    skip_until: "2026-12-15"
    skip_reason: "The claim planner genuinely shipped and belongs to this design, so this is not a false positive. But the doc must stay 'partially' until the planner actually orders claims (claim-planner-wired, held until a record-mode readout pins CLAIM_PLANNER_CALIBRATION), so this would pass forever under a non-terminal status. claim-planner-wired tracks the remaining work; lift this suppression in the PR that flips the status to 'implemented'."
  - id: "claim-planner-wired"
    type: "symbol_reachable"
    symbol: "planClaimBatch"
    entry: "apps/web/src/app/api/workers/claim/route.ts"
    as: "call"
    skip_until: "2026-12-15"
    skip_reason: "Wired and passing, but the planner does not order claims yet. The work has since been released, but no workspace has run the planner in record mode, so there is still no record-mode evidence: CLAIM_PLANNER_CALIBRATION's verdict is insufficient_n, the pinned thresholds stay null and no workspace runs apply. Suppressed so the design holds at 'partially' until a readout earns the flip. Contract: docs/specs/claim-ordering.md."
  - id: "claim-planner-tests"
    type: "test_file"
    path: "packages/core/__tests__/claim-planner.test.ts"
    skip_until: "2026-12-15"
    skip_reason: "The claim planner's test file genuinely shipped and belongs to this design, so this is not a false positive. But the doc must stay 'partially' until the planner actually orders claims (claim-planner-wired, held until a record-mode readout pins CLAIM_PLANNER_CALIBRATION), so this would pass forever under a non-terminal status. claim-planner-wired tracks the remaining work; lift this suppression in the PR that flips the status to 'implemented'."
---

# jev-scheduling

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/jev-scheduling.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
