---
status: superseded
superseded_by: docs/specs/mission-task-lifecycle.md#mission-completion-gate
superseded_on: 2026-08-29
superseded_reason: Described criteria as advisory metadata evaluated as a side effect of completion. The shipped contract inverts that — completion requests a verdict and the verdict gates completion (PR #1901).
assertions:
  - id: goal-criteria-column
    type: config_key
    key: goalCriteria
    file: packages/core/db/schema.ts
  - id: goal-criterion-type
    type: symbol
    name: GoalCriterion
    path: packages/shared/src/types.ts
  - id: evaluate-goal-criteria-fn
    type: symbol
    name: evaluateGoalCriteria
    path: packages/core/mission-helpers.ts
  - id: mission-evaluate-route
    type: route
    method: POST
    path: /api/missions/[id]/evaluate
    file: apps/web/src/app/api/missions/[id]/evaluate/route.ts
  - id: kpis-column
    type: config_key
    key: kpis
    file: packages/core/db/schema.ts
  - id: initiative-kpi-type
    type: symbol
    name: InitiativeKPI
    path: packages/shared/src/types.ts
---

# mission-goal-criteria

This design doc's body lives in the private knowledge base at `knowledge-base: buildd/design/mission-goal-criteria.md`; workers read it with `recall scope=docs`. Only the frontmatter stays here, because its assertions are checked against the code on every push (see `scripts/check-spec-conformance.ts`).
