---
title: Model Policy Cells and the Dial
status: active
owner: max
last_verified: 2026-10-07
summary: Each tier x surface cell MUST serve its primary until the team's own graded coding outcomes show an alternate keeps up within the dial's tolerance, and MUST revert, recorded, when it slips.
domain: integrations
surfaces: [packages/core/tier-dial.ts, packages/core/tier-dial-source.ts, apps/web/src/app/api/model-tiers/cells/route.ts, packages/shared/src/model-policy-cells.ts]
related: [model-policy, model-routing-and-tiers]
keywords: [dial, cell, primary, alternates, may also use, always, learning, shifted, reverted, shadow, threshold, non-inferiority, auto-revert, tier_pools.dial, dial_state]
verified_by: [packages/core/__tests__/tier-dial.test.ts, packages/core/__tests__/tier-dial-source.test.ts, packages/core/__tests__/tier-pool-source.test.ts, apps/web/src/app/api/model-tiers/cells/route.test.ts, apps/web/src/app/api/cron/tier-pools/route.test.ts]
supersedes: []
assertions:
  - id: "decide-dial-cell"
    type: "symbol"
    name: "decideDialCell"
    path: "packages/core/tier-dial.ts"
  - id: "dial-threshold"
    type: "symbol"
    name: "dialThreshold"
    path: "packages/core/tier-dial.ts"
  - id: "dial-settings"
    type: "symbol"
    name: "DIAL_SETTINGS"
    path: "packages/core/tier-dial.ts"
  - id: "write-dial-state"
    type: "symbol"
    name: "writeDialState"
    path: "packages/core/tier-dial-source.ts"
  - id: "cells-read-route"
    type: "route"
    method: "GET"
    path: "/api/model-tiers/cells"
    file: "apps/web/src/app/api/model-tiers/cells/route.ts"
  - id: "cells-dial-route"
    type: "route"
    method: "PATCH"
    path: "/api/model-tiers/cells"
    file: "apps/web/src/app/api/model-tiers/cells/route.ts"
  - id: "dial-column"
    type: "config_key"
    key: "dial_state"
    file: "packages/core/db/schema.ts"
  - id: "dial-tests"
    type: "test_file"
    path: "packages/core/__tests__/tier-dial.test.ts"
---

# Model Policy Cells and the Dial

**Capability statement**: For every tier x surface cell a team gets one read
model (primary, alternates, one dial, a learning state, what ran), and on the
coding surface buildd moves traffic to a cheaper alternate only after the
team's own outcomes show it keeps up, and moves it back on its own when it
stops keeping up.

## Model

- A cell's **primary** is the tier registry's resolution (the tier pool's
  incumbent once a pool exists). Its **alternates** ("may also use") are the
  pool's active challengers.
- The **dial** is 1..5, default 3. 1 = always the primary; 5 = the cheapest
  alternate that keeps up. The dial sets the tolerance (margin, confidence)
  and the most traffic an alternate may take (`DIAL_SETTINGS`: 25% / 50% /
  75% / 100% for dials 2..5).
- **States** (rendered verbatim): `always` (dial 1 or no alternates),
  `learning` (shadow), `shifted`, `reverted`.
- A cell is run by the dial when its pool's `mode` is `dial`. `pinned`,
  `split` and `explore` pools keep working unchanged; an exact split is still
  a `split` pool and shows `experimentRunning`.

## Signals

A coding run is graded on three "higher is better" signals: **merged** (the PR
merged; a closed PR or a model-attributable failure is a miss; an infra
failure is not graded), **review ok** (the first reviewer verdict was approve)
and **no rework** (no reviewer asked for changes). A run counts as graded once
merged is known.

## Threshold

Not a constant. For the dial's margin `m`, confidence `z` and the primary's
noisiest signal variance `v = p(1−p)`, each side needs `n = 2·z²·v/m²` graded
runs (floor 20) — the point at which equal rates can clear the bound. When
`n` would take more than 28 days at the cell's graded-run pace, `z` is
lowered (never below 1.036, 85% one-sided) to fit, and the promotion test uses
that same `z`.

## Invariants

- Learning (shadow) never changes the served model: a dial pool serves its
  primary unless its state is `shifted`, whatever its stored allocation or a
  run's sticky prior says. The would-be pick is recorded on the run's
  assignment (`eligibility.shadowArmId`).
- Dial 1 serves the primary for every run.
- A promotion needs both the alternate and the primary at or above the
  threshold, and the lower bound of (alternate − primary) at `z` at least
  −margin on every signal with enough runs (merged always).
- A shifted cell reverts when, on the cell's own runs since the shift, the
  alternate's rate on any signal is more than the margin below the primary's.
  A revert holds 14 days, then learning restarts on evidence after the revert.
- A revert records which alternate slipped (`revertedFrom`), so the UI can
  name it; the response also carries `overrideWorkspaces`, the distinct
  workspaces with an override row of their own.
- Every state change is one compare-and-set write with a `tier_pool_changes`
  row (`promotion`, `revert` or `dial`) carrying its reason. Nothing moves
  traffic silently.
- Workspace overrides keep precedence: a workspace with its own registry row
  for the tier never enters the pool (`overrideCount` on the cell).
- A task in a model-routing experiment never enters a pool.

## Acceptance criteria

- AC-1: GIVEN a dial pool in `learning` WHEN a task is claimed THEN the
  primary serves it and the assignment records the shadow pick.
- AC-2: GIVEN an alternate below the threshold WHEN the step runs THEN the
  cell stays `learning` with `progress.graded < progress.threshold`.
- AC-3: GIVEN both sides above the threshold and outcomes within the margin
  WHEN the step runs THEN the cell is `shifted`, the alternate takes the
  dial's share and a `promotion` change row exists.
- AC-4: GIVEN a shifted cell whose alternate's merged rate slips past the
  margin WHEN the step runs THEN the cell is `reverted` with `revertReason`
  and a `revert` change row.
- AC-5: WHEN an admin sets dial 1 THEN all traffic returns to the primary in
  the same write.
- AC-6: GIVEN a `split` pool WHEN a task is claimed THEN the draw follows the
  admin's allocation exactly.
- AC-7: `GET /api/model-tiers/cells?teamId=` returns `ModelPolicyCellsResponse`
  to any team member; `PATCH` (dial) is owner/admin only and 409s on a stale
  `expectedVersion`.

## Out of scope

Chat cells report their configured state only; chat evidence comes from the
chat-learning work (the optional chat fields on `whatRan` stay absent until
then). The settings page (`apps/web/src/app/app/(protected)/settings/models/`)
renders this read model verbatim and is not part of this contract.

## Code surface

- Pure decisions: `packages/core/tier-dial.ts` — `DIAL_SETTINGS`,
  `dialThreshold`, `withinTolerance`, `decideDialCell`, `applyDialChange`,
  `dialAllocation`, `decideDialArm`, `gradeRun`.
- Stores: `packages/core/tier-dial-source.ts` — `loadTeamCodingRuns`,
  `runDialStep`, `writeDialState`, `buildModelPolicyCells`.
- Draw: `packages/core/tier-pool-source.ts` — `drawAgentPoolArm`,
  `servingAllocation`.
- Data: `tier_pools.mode = 'dial'`, `tier_pools.dial`, `tier_pools.dial_state`
  (`packages/core/db/schema.ts`).
- Routes: `apps/web/src/app/api/model-tiers/cells/route.ts`;
  `apps/web/src/app/api/cron/tier-pools/route.ts` (hourly step).
- Contract types: `packages/shared/src/model-policy-cells.ts`.
