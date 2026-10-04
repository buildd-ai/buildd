---
title: Orchestration Decisions (Shadow and Promotion Guard)
status: active
owner: max
last_verified: 2026-10-03
summary: Creation-manifest and claim hold/start decisions MUST only record suggestions unless a committed readout promotion grants a cohort, and MUST fall back to the deterministic rule on every failure.
domain: tasks
surfaces: [packages/core/orchestration-decision.ts, packages/core/orchestration-promotion.ts, packages/core/orchestration-readout.ts, apps/web/src/app/api/workers/claim/hold-start-shadow.ts]
related: [model-routing-and-tiers, mission-task-lifecycle]
keywords: [jev, shadow, gated, applying fraction, cohort, propensity, orchestration_decisions, orchestration_manifest, orchestration_claim, readout, insufficient_n]
verified_by: [packages/core/__tests__/orchestration-decision.test.ts, packages/core/__tests__/orchestration-promotion.test.ts, packages/core/__tests__/orchestration-readout.test.ts, apps/web/src/app/api/workers/claim/hold-start-shadow.test.ts]
assertions:
  - id: "run-orchestration-decision"
    type: "symbol"
    name: "runOrchestrationDecision"
    path: "packages/core/orchestration-decision.ts"
  - id: "resolve-applying-fraction"
    type: "symbol"
    name: "resolveApplyingFraction"
    path: "packages/core/orchestration-promotion.ts"
  - id: "promotions-record"
    type: "symbol"
    name: "ORCHESTRATION_PROMOTIONS"
    path: "packages/core/orchestration-promotion.ts"
  - id: "build-readout"
    type: "symbol"
    name: "buildOrchestrationReadout"
    path: "packages/core/orchestration-readout.ts"
  - id: "release-gated-start"
    type: "symbol"
    name: "releaseGatedStartPaths"
    path: "apps/web/src/app/api/workers/claim/hold-start-shadow.ts"
  - id: "claim-cohort-through-guard"
    type: "symbol_reachable"
    symbol: "resolveApplyingFraction"
    entry: "apps/web/src/app/api/workers/claim/hold-start-shadow.ts"
    as: "call"
  - id: "manifest-cohort-through-guard"
    type: "symbol_reachable"
    symbol: "resolveApplyingFraction"
    entry: "packages/core/manifest-prediction-source.ts"
    as: "call"
  - id: "promotion-test"
    type: "test_file"
    path: "packages/core/__tests__/orchestration-promotion.test.ts"
  - id: "readout-test"
    type: "test_file"
    path: "packages/core/__tests__/orchestration-readout.test.ts"
supersedes: []
---
# Orchestration Decisions (Shadow and Promotion Guard)

**Capability statement**: Buildd MAY ask a decision model two orchestration
questions, which files a scope-less task will edit (at creation) and whether
an advisory-deferred task should start (at claim). It MUST record every answer
content-free and MUST NOT let an answer change behaviour unless a committed,
evidence-backed promotion grants an applying cohort for that exact definition.

This contract describes **shadow-only** behaviour. As shipped, no promotion is
recorded, so every applying fraction resolves to zero and both decisions are
record-only. See `knowledge-base: buildd/design/conflict-aware-orchestration.md` "Rollout status".

**Relationship to the 2026-10-03 owner decision retiring shadow-first as the
default decision-call rollout** (`knowledge-base: buildd/design/decision-calls.md`
Point 2b, "Staying evidence-gated"): that decision does not flip this one live.
A wrong gated START can produce a real merge collision, so this stays the one
decision in the table that requires a committed, evidence-backed promotion —
not a leftover shadow phase nobody got around to graduating, a deliberate
exception for a decision whose correct confidence threshold cannot be chosen
responsibly without first measuring it on decisions that already happened.

**Invariants**:

- Every orchestration decision goes through `runOrchestrationDecision`: one
  overall deadline covers access, retrieval and the call, and every failure
  (capability off, no key, deadline, invalid answer, provider error, empty
  candidate set, thrown dependency) returns the caller's deterministic rule
  verdict. It never throws.
- An answer is applied only when all three hold: the kit's policy permits it
  (not `shadow`, at or above the threshold), `isJevModel` passes for the model
  that answered, and the unit was drawn into the applying arm. A non-Jev team
  model is recorded as a suggestion, never applied, even inside a granted
  cohort.
- The requested applying fraction (`CLAIM_HOLD_APPLYING_FRACTION`,
  `MANIFEST_APPLYING_FRACTION`, both zero) is never used raw.
  `resolveApplyingFraction` grants it only when `ORCHESTRATION_PROMOTIONS`
  holds `eligible_for_gated` evidence for the same decision id and candidate
  policy, whose measured identity equals the deployed definition's and whose
  threshold equals the deployed `minConfidence`. The grant is capped at the
  evidence's cohort ceiling. Any other case grants zero.
- A requested fraction of zero, below zero or non-finite grants zero without
  reading evidence. Rolling back is setting zero.
- A team that has not opted in to the capability writes no ledger row. An
  opted-in team writes one content-free row per look: labels that are not
  short opaque tokens are stored hashed (`contentFreeLabel`).
- At claim, only advisory deferrals are asked about. `classifyClaimHoldEligibility`
  refuses a forced claim, an unresolved lease read, a live lease, a serialized
  surface, a migration path and a live PR holder before any model sees the
  task.
- A gated START acquires the task's declared paths through the exclusive
  acquisition primitive before the atomic claim. If the claim is then lost,
  `releaseGatedStartPaths` gives back exactly the lease rows that acquisition
  inserted (`releaseLeaseRows`, by row id, manifest untouched), unless a
  winning claim now owns the task, re-checked under the workspace lock.
  Waiters on a released path are told the task's real release reason
  (`resolveReleaseReasonForTask`).
- Gated creation-manifest application stays disabled
  (`GATED_MANIFEST_APPLICATION_ENABLED` is false), and `prepareGatedManifest`
  refuses any prediction with unknown scope.
- The readout (`buildOrchestrationReadout`) emits a threshold only for an
  `eligible_for_gated` verdict. With too few labelled rows in any of train,
  held-out or the later window the verdict is `insufficient_n` and the
  threshold is null. A held claim decision is censored, never a safe start.

**Acceptance criteria**:

- AC-1: GIVEN a gated claim definition and a requested fraction of 1 WHEN
  `ORCHESTRATION_PROMOTIONS` holds no matching evidence THEN the granted
  fraction is 0 and the recorded row has `applying_fraction` 0 and
  `experiment_arm` `observe`.
- AC-2: GIVEN matching eligible evidence WHEN the deployed definition's
  questions or model differ from the measured one THEN the refusal is
  `fingerprint_mismatch` and the granted fraction is 0.
- AC-3: GIVEN matching eligible evidence WHEN the deployed `minConfidence`
  differs from the measured threshold THEN the refusal is `threshold_mismatch`.
- AC-4: GIVEN matching eligible evidence with a cohort ceiling WHEN a larger
  fraction is requested THEN the granted fraction equals the ceiling.
- AC-5: GIVEN matching eligible evidence WHEN the requested fraction is 0 THEN
  the granted fraction is 0 and the gated START path is unreachable (no ledger
  lookup).
- AC-6: GIVEN a granted cohort of 1 WHEN a non-Jev model answers START with
  high confidence THEN the outcome is `suggested` with reason `non_jev` and the
  effective verdict is the rule's HOLD.
- AC-7: GIVEN the decision provider returns an error or the deadline passes
  WHEN a decision runs THEN the effective verdict is the rule verdict and the
  row's status is `fallback`.
- AC-8: GIVEN a gated START that acquired leases WHEN the atomic claim is lost
  and the task is no longer owned by a live claim THEN only the rows that
  attempt inserted are released, and another attempt's leases for the same
  task survive; WHEN the task is now `assigned`, `in_progress` or `review`
  THEN they are kept.
- AC-9: GIVEN only shadow claim decisions (every hold censored) WHEN the
  readout runs THEN the claim verdict is `insufficient_n` with a null
  threshold, and its wait, stranded and throughput figures are still reported.
- AC-10: GIVEN no recorded decisions in the window WHEN the readout runs THEN
  both decisions are `insufficient_n` and the promotion status is `blocked`.

**Code surface**:

- `packages/core/orchestration-decision.ts`: `runOrchestrationDecision`,
  `assignApplyingArm`, `contentFreeLabel`.
- `packages/core/orchestration-promotion.ts`: `resolveApplyingFraction`,
  `ORCHESTRATION_PROMOTIONS`, `measuredIdentity`, `manifestPickIdentity`.
- `packages/core/orchestration-claim-decision.ts`: `CLAIM_HOLD_DECISION`,
  `classifyClaimHoldEligibility`, `isGatedStartReachable`.
- `apps/web/src/app/api/workers/claim/hold-start-shadow.ts`:
  `ClaimHoldCollector`, `scheduleClaimHoldShadow`, `grantedFraction`,
  `gatedStartApplies`, `acquireGatedStartPaths`, `releaseGatedStartPaths`;
  wired from `apps/web/src/app/api/workers/claim/route.ts`.
- `packages/core/manifest-prediction.ts` and `manifest-prediction-source.ts`:
  `predictCreationManifest`, `prepareGatedManifest`, `labelManifestPrediction`.
- `packages/core/orchestration-outcomes.ts`: `labelDecisionOutcomes`.
- `packages/core/orchestration-readout.ts`: `buildOrchestrationReadout`,
  `splitWorkUnits`, `replayDecisionEval`, `calibrateAndJudge`; loader
  `packages/core/orchestration-readout-source.ts`; operator command
  `scripts/orchestration-readout.ts`.
- Data model: `orchestration_decisions`, `orchestration_touch_labels`,
  `orchestration_manifest_predictions` in `packages/core/db/schema.ts`.

**Out of scope**:

- Any applied orchestration decision in production. Promotion is blocked
  pending deployed evidence. The `live` mode needs a later successful gated
  readout.
- Choosing an exploration cohort for hold/start without outcome evidence.
- The optional overlap-real decision (design §5c).
- Readout output: it holds workspace data and is a private artifact, never
  committed.
