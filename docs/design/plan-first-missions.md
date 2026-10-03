---
status: proposed
# Draft assertions — Tier 3 weekly cron (docs/design/spec-conformance.md §Tier 3).
# The gate machinery (requiresPlanApproval, the plan_awaiting_approval invariant,
# PlanReviewPanel) exists — but shipped for docs/design/spec-to-build-pattern.md's
# emitsPlan path, not for this doc's own trigger (flipping the flag on a
# mission's first organizer cycle from POST /api/missions). That specific write
# is still absent, so this doc's premise "nothing sets requiresPlanApproval" is
# now stale prose (two other writers exist) even though its own proposal is
# unbuilt.
#
# The first three assertions below genuinely pass — but per §2's per-assertion
# classification, a passing assertion under a non-terminal declared status
# (`proposed`) is `code_ahead` regardless of the other assertions in the doc.
# Status can't flip to Implemented until mission-auto-start-sets-requires-plan-approval
# also ships, so these three would be reclassified code_ahead and redispatched
# forever under a non-terminal status. Suppressed below (skip_until) rather than
# left to redispatch a reconcile-spec task against an already-accurate doc.
assertions:
  - id: "plan-review-panel-component"
    type: "symbol"
    name: "PlanReviewPanel"
    path: "apps/web/src/app/app/(protected)/tasks/[id]/PlanReviewPanel.tsx"
    skip_until: "2026-12-19"
    skip_reason: "PlanReviewPanel genuinely shipped (for spec-to-build-pattern.md's emitsPlan path) — this isn't a false positive — but the doc must stay 'proposed' until mission-auto-start-sets-requires-plan-approval ships, so this assertion will pass forever under a non-terminal status. mission-auto-start-sets-requires-plan-approval is the assertion that tracks real remaining progress."
  - id: "plan-awaiting-approval-invariant"
    type: "config_key"
    key: "plan_awaiting_approval"
    file: "apps/web/src/lib/mission-invariants.ts"
    skip_until: "2026-12-19"
    skip_reason: "plan_awaiting_approval invariant genuinely shipped (for spec-to-build-pattern.md's emitsPlan path) — this isn't a false positive — but the doc must stay 'proposed' until mission-auto-start-sets-requires-plan-approval ships, so this assertion will pass forever under a non-terminal status. mission-auto-start-sets-requires-plan-approval is the assertion that tracks real remaining progress."
  - id: "requires-plan-approval-gate-read"
    type: "symbol_reachable"
    symbol: "requiresPlanApproval"
    entry: "apps/web/src/lib/task-dependencies.ts"
    as: "read"
    skip_until: "2026-12-19"
    skip_reason: "The requiresPlanApproval read in task-dependencies.ts genuinely shipped (for spec-to-build-pattern.md's emitsPlan path) — this isn't a false positive — but the doc must stay 'proposed' until mission-auto-start-sets-requires-plan-approval ships, so this assertion will pass forever under a non-terminal status. mission-auto-start-sets-requires-plan-approval is the assertion that tracks real remaining progress."
  - id: "mission-auto-start-sets-requires-plan-approval"
    type: "symbol_reachable"
    symbol: "requiresPlanApproval"
    entry: "apps/web/src/app/api/missions/route.ts"
    as: "assign"
---

# plan-first-missions

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/plan-first-missions.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
