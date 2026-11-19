---
title: Harness Adoption Outcome Criteria (DRAFT)
status: draft
owner: max
last_verified: 2026-11-14
summary: Each harness change MUST name its success as a relative change on a baseline delivery metric, and none is called adopted until its owner agrees the measure.
domain: tasks
surfaces: [apps/runner/src/stuck-detection.ts, apps/runner/src/verify-guard.ts, apps/web/src/lib/loop-dispatcher.ts, apps/web/src/lib/review-verdict-gate.ts]
related: [mission-task-lifecycle, living-specs]
keywords: [harness adoption, success measures, baseline, fail-to-resolve loop time, first-push CI failure rate, retries per task, open-to-merge, abandoned PRs, base drift, outcome criteria]
supersedes: []
assertions:
  - id: verify-guard-tests
    skip_until: "2027-01-12"
    skip_reason: "Spec is still draft; assertion proves only that the named surface exists. Remove when the spec is promoted to active."
    type: test_file
    path: apps/runner/__tests__/unit/verify-guard.test.ts
  - id: stuck-detection-tests
    skip_until: "2027-01-12"
    skip_reason: "Spec is still draft; assertion proves only that the named surface exists. Remove when the spec is promoted to active."
    type: test_file
    path: apps/runner/__tests__/unit/stuck-detection.test.ts
---

# Harness Adoption Outcome Criteria (DRAFT)

**DRAFT for owner review.** Everything under "Proposed outcome criteria" is a proposal written by the harness-adoption baseline mission. No threshold below is agreed until its owner approves it. Thresholds are relative changes against a pre-change baseline taken over a comparable window. No production counts appear here: exact baseline figures live in the private knowledge-base.

## Why this file exists

The five harness changes are specified as native Living Specs in buildd, not as repo files. A builder token cannot revise an approved native spec's criteria (the revise call returns `acceptance_role_forbidden`), so the drafts sit here, one block per spec. When the owner agrees a block, an organizer or researcher revises the native spec's outcome section with it, and the block is removed from this file or marked superseded.

| Harness change | Native Living Spec (short id) |
| --- | --- |
| Stuck detection | In-session stuck detection: error streaks and alternation (`773d2851`) |
| Loop retries | Loop retries: the next iteration sees what the last verification said (`6b0f64aa`) |
| Self-review | Staged self-review before complete_task, intent-only, measured (`f3742450`) |
| Skill candidates, usage telemetry, retirement | Skill candidates, usage telemetry and retirement (`b41a9107`); Skill candidates from repeated verified work (`34682a64`) |
| Review by risk | Review by risk: merge to dev on its own, one look before production (`62e985a8`) |

The build missions for these specs could not be listed from a builder session: the missions tool exposes only the spec discrepancy ledger. Owners should attach each block to its mission when they approve it.

## Baseline metrics

Each measure below uses one of: fail-to-resolve loop time (first failure to resolution), first-push CI failure rate, retries per task, PR open-to-merge time, abandoned PRs, base drift (how far a branch is behind its base when it merges). Method for measuring them: the delivery-forensics skill.

## Proposed outcome criteria

### Stuck detection (`773d2851`)

- Measure 1, precision: at least 70% of a sample of logged stuck signals are judged truly stuck on read-through. Under 50%, retune thresholds before nudging is the default.
- Measure 2, retries per task: once nudging is the default, retries per task for tasks whose workers hit a signal fall at least 15% relative to comparable tasks before nudging.
- Measure 3, fail-to-resolve loop time: median fail-to-resolve time for those tasks falls at least 15% relative.
- Measure 4, abandoned PRs: the abandoned share after a stuck worker does not rise and trends down at least 10% relative.
- Guardrail: first-push CI failure rate and PR open-to-merge time worsen by no more than 5% relative; the new scenarios abort no session.
- Kill: if fewer than half of nudged sessions change approach, return to log mode.

### Loop retries (`6b0f64aa`)

- Measure 1, fail-to-resolve loop time: median time from first failed verification to exit condition met falls at least 25% relative.
- Measure 2, retries per task: iterations needed per loop task fall at least 15% relative.
- Measure 3, repeat failures: the share of iterations that fail with the same verifier outcome as the previous one falls at least 30% relative.
- Guardrail: prompt size grows by no more than the section cap; abandoned PRs from loop tasks do not rise.
- Kill: no measurable change in measures 1 and 2 after a full window means the output excerpt is not the missing signal; stop extending the section.

### Staged self-review (`f3742450`)

The spec already requires a pre-registered readout; these are proposed values for the owner to store on the experiment before it starts.

- Measure 1, first-push CI failure rate: the treatment arm is lower than control by at least 10% relative, on intent-class causes, by the readout's interval.
- Measure 2, reviewer rounds: request-changes rounds per PR fall at least 15% relative in the treatment arm.
- Measure 3, PR open-to-merge time: not worse than control by more than 10% relative.
- Cost ceiling: added turns per staged task stay under an owner-set ceiling stored before the start.
- Kill: rubber-stamp (high touch rate with near-zero flip rate), no favourable difference at the minimum sample, or cost above the ceiling switches the stage off.

### Skill candidates, usage telemetry and retirement (`b41a9107`, `34682a64`)

- Measure 1, telemetry coverage: at least 95% of claims that deliver a skill write a usage row.
- Measure 2, safe retirement: at most 5% of archived skills are restored within 30 days because they were needed; any such restore returns retirement to recording.
- Measure 3, candidate value (only after the build gate in `34682a64` is met): tasks that start with a promoted skill show first-push CI failure rate and retries per task each at least 15% lower relative than comparable tasks without it.
- Measure 4, candidate quality: a majority of reviewed candidates are accepted; a clear majority dismissed after 60 days in acting mode removes the feature.
- Guardrail: no change in first-push CI failure rate or retries per task beyond 5% relative worse after a retirement pass.

### Review by risk (`62e985a8`)

- Measure 1, PR open-to-merge time: median for PRs not held for a person falls at least 50% relative.
- Measure 2, abandoned PRs: falls at least 25% relative.
- Measure 3, base drift: branch distance behind its base at merge falls at least 20% relative.
- Guardrail: post-merge CI failure rate on the integration branch rises by no more than 10% relative; every PR touching a held area (access, credentials, migrations, acceptance tests) waits for a person, with no exceptions.
- Kill: any held-area PR merging with no person approval turns the mode off for that workspace.

## Acceptance criteria

- AC-1: GIVEN this file WHEN it is read THEN it states every threshold as a relative change or percentage and contains no absolute production count.
- AC-2: GIVEN a harness change WHEN its block has no owner approval THEN the block stays marked DRAFT and the change is not described as adopted.
- AC-3: GIVEN a block an owner agrees WHEN it is moved into the native spec THEN this file is updated in the same change so the two never disagree.
- AC-4: GIVEN a measure whose baseline cannot be computed WHEN the readout is written THEN it reports the measure as unmeasured and does not substitute another metric.

## Code surface

The surfaces of each harness change, as the native specs name them: `apps/runner/src/stuck-detection.ts`, `apps/runner/src/verify-guard.ts`, `apps/web/src/lib/loop-dispatcher.ts`, `apps/web/src/lib/review-verdict-gate.ts`.

## Out of scope

- Building any of the harness changes.
- Choosing final thresholds: that is the owners' decision.
- Baseline figures: they live in the private knowledge-base.
