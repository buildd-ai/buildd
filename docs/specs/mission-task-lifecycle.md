---
title: Mission & Task Lifecycle
status: superseded
owner: max
last_verified: 2026-10-14
summary: The coordination layer MUST allow only documented task/worker/mission transitions, name every claim gate, refuse completion without passing criteria, and refuse any merge that outruns an outstanding review verdict.
domain: missions
surfaces: [apps/web/src/lib/mission-completion.ts, apps/web/src/app/api/workers/claim/route.ts, packages/core/mission-helpers.ts, apps/web/src/lib/review-verdict-gate.ts]
related: [task-state-machine, claim-gate-legibility, mission-completion, organizer-context, mission-surface-audit]
keywords: [delivery epoch, mission delivery, successor delivery, gatereason, cancompletemission, derivemissionhealth, goalcriteria, dependson, activehours, awaitingmerge, isWaitingOnYou, workingbranch, integration branch, primaryprnumber, review_verdict, changes_requested, reviewheadsha, effectiveverdict, prsupersession, supersededbyprnumber, recordprsupersession]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "local-strand"
    type: "symbol"
    name: "deriveLocalStrand"
    path: "apps/web/src/lib/local-strand.ts"
  - id: "local-strand-tests"
    type: "test_file"
    path: "apps/web/src/lib/local-strand.test.ts"
  - id: "claim-task"
    type: "route"
    method: "POST"
    path: "/api/workers/claim"
    file: "apps/web/src/app/api/workers/claim/route.ts"
  - id: "completion-gate"
    type: "symbol"
    name: "canCompleteMission"
    path: "apps/web/src/lib/mission-completion.ts"
  - id: "criteria-evaluation"
    type: "symbol"
    name: "evaluateGoalCriteria"
    path: "packages/core/mission-helpers.ts"
  - id: "completion-gate-tests"
    type: "test_file"
    path: "apps/web/src/lib/mission-completion.test.ts"
  - id: "review-verdict-gate"
    type: "symbol"
    name: "evaluateReviewVerdictGate"
    path: "apps/web/src/lib/review-verdict-gate.ts"
  - id: "review-verdict-gate-tests"
    type: "test_file"
    path: "apps/web/src/lib/review-verdict-gate.test.ts"
  - id: "pr-supersession-write"
    type: "symbol"
    name: "recordPrSupersession"
    path: "apps/web/src/lib/pr-supersession.ts"
  - id: "pr-supersession-tests"
    type: "test_file"
    path: "apps/web/src/lib/pr-supersession.test.ts"
  - id: "pr-shipped-predicate"
    type: "symbol"
    name: "prShipState"
    path: "packages/core/pr-shipped.ts"
  - id: "pr-shipped-tests"
    type: "test_file"
    path: "packages/core/__tests__/pr-shipped.test.ts"
  - id: "visual-review-policy"
    type: "symbol"
    name: "resolveVisualReviewPolicy"
    path: "apps/web/src/lib/workflow/visual-review-policy.ts"
  - id: "visual-review-policy-tests"
    type: "test_file"
    path: "apps/web/src/lib/workflow/visual-review-policy.test.ts"
  - id: "visual-review-state"
    type: "symbol"
    name: "deriveMissionVisualReview"
    path: "apps/web/src/lib/workflow/visual-review-state.ts"
  - id: "visual-review-state-tests"
    type: "test_file"
    path: "apps/web/src/lib/workflow/visual-review-state.test.ts"
superseded_by: task-state-machine
---
# Contract map

The contract is split by capability. Existing criterion ids are preserved in
their owning child; links to this former aggregate resolve through this map.

- [task-state-machine](task-state-machine.md)
- [claim-gate-legibility](claim-gate-legibility.md)
- [mission-completion](mission-completion.md)
- [organizer-context](organizer-context.md)
- [mission-surface-audit](mission-surface-audit.md)
