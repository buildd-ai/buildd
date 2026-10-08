---
title: Orchestration Decisions (Shadow and Promotion Guard)
status: active
owner: max
last_verified: 2026-10-03
summary: Creation-manifest decisions MUST stay record-only without a committed promotion; claim hold/start MAY apply a confident Jev START to its three advisory gates only; both MUST fall back to the rule on failure.
domain: tasks
surfaces: [packages/core/orchestration-decision.ts, packages/core/orchestration-promotion.ts, packages/core/orchestration-readout.ts, apps/web/src/app/api/workers/claim/hold-start-shadow.ts]
related: [model-routing-and-tiers, mission-task-lifecycle]
keywords: [jev, shadow, gated, applying fraction, cohort, propensity, orchestration_decisions, orchestration_manifest, orchestration_claim, readout, insufficient_n, soft overlap, softOverlaps, partitionOverlapEdges, hold start]
verified_by: [packages/core/__tests__/orchestration-decision.test.ts, packages/core/__tests__/orchestration-promotion.test.ts, packages/core/__tests__/orchestration-readout.test.ts, packages/core/__tests__/orchestration-claim-decision.test.ts, packages/core/__tests__/path-overlap-edges.test.ts, apps/web/src/app/api/workers/claim/hold-start-shadow.test.ts, apps/web/src/app/api/workers/claim/soft-overlap-gate.test.ts]
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
  - id: "partition-overlap-edges"
    type: "symbol"
    name: "partitionOverlapEdges"
    path: "packages/core/path-overlap.ts"
  - id: "soft-overlap-gate"
    type: "symbol"
    name: "evaluateSoftOverlaps"
    path: "apps/web/src/app/api/workers/claim/soft-overlap-gate.ts"
  - id: "soft-overlap-gate-test"
    type: "test_file"
    path: "apps/web/src/app/api/workers/claim/soft-overlap-gate.test.ts"
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
# Orchestration Decisions (Shadow, Promotion Guard and Live Hold/Start)

**Capability statement**: Buildd MAY ask a decision model two orchestration
questions, which files a scope-less task will edit (at creation) and whether
an advisory-deferred task should start (at claim). It MUST record every answer
content-free. The creation-manifest answer MUST NOT change behaviour unless a
committed, evidence-backed promotion grants an applying cohort. The claim
hold/start answer MAY apply, but only a confident Jev START, only to the three
advisory gates, and never past a deterministic rail.

The creation-manifest decision is **shadow-only** as shipped: no promotion is
recorded, so its applying fraction resolves to zero. See
`knowledge-base: buildd/design/conflict-aware-orchestration.md` "Rollout status".

**Claim hold/start is live by owner decision** (tasks 7eb191b9 and d0db21dd),
reversing the earlier "stays evidence-gated" exception: it ships `gated` at a
conservative starting threshold (`CLAIM_HOLD_MIN_CONFIDENCE`) with every
eligible deferral in the applying arm, and does not go through the promotion
guard. Every call is logged so the threshold can be recalibrated from labelled
outcomes. Rollback is one switch: `CLAIM_HOLD_APPLYING_FRACTION = 0` returns
every advisory gate to deterministic HOLD.

**Hard vs soft path overlap**: a stored `dependsOn` edge blocks until the
upstream completes and merges, and is never re-checked. At creation (and on a
conflict retry) `partitionOverlapEdges` makes an inferred edge only for a
same-file overlap, a migration or schema path, or a workspace serialized
surface. A prefix-only overlap is SOFT: recorded as
`pathDeclaration.softOverlaps` (the pair, the overlapping paths, the edge
kind), never an edge, and decided at claim by hold/start (`soft_overlap` gate).
Migration 0265 moved the pending tasks' pre-split inferred edges into
`softOverlaps` (kind `legacy_inferred`), reclassified at each claim against the
current manifests.

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
- Claim hold/start applies at `CLAIM_HOLD_APPLYING_FRACTION` (1) through
  `grantedFraction`, which clamps it to [0, 1]; zero or non-finite is rolled
  back. Its definition is `gated` at `CLAIM_HOLD_MIN_CONFIDENCE`, so a START
  below the threshold, from a non-Jev model, or any fallback is the rule's HOLD.
- The creation-manifest fraction (`MANIFEST_APPLYING_FRACTION`, zero) is
  never used raw. `resolveApplyingFraction` grants it only when `ORCHESTRATION_PROMOTIONS`
  holds `eligible_for_gated` evidence for the same decision id and candidate
  policy, whose measured identity equals the deployed definition's and whose
  threshold equals the deployed `minConfidence`. The grant is capped at the
  evidence's cohort ceiling. Any other case grants zero.
- A requested fraction of zero, below zero or non-finite grants zero without
  reading evidence. Rolling back is setting zero.
- A team that has not opted in to the capability writes no ledger row. An
  opted-in team writes one content-free row per look: labels that are not
  short opaque tokens are stored hashed (`contentFreeLabel`).
- At claim, only advisory deferrals are asked about: `advisory_manifest`,
  `open_pr_overlap` (every overlapping PR's worker ended) and `soft_overlap`.
  `classifyClaimHoldEligibility` refuses a forced claim, an unresolved lease
  read, a live lease, a serialized surface, a migration path and (open-PR
  overlap) a live PR holder before any model sees the task. Declared
  dependencies, pacing, concurrency, caps, budgets and auth are never asked
  about.
- An applied START is honoured only for the same claim-time state digest and
  within its TTL; a ledger read error holds.
- A soft overlap holds only while its holder is in flight. Reclassified at
  claim (`evaluateSoftOverlaps`): a same-file, migration or serialized overlap
  is a deterministic hold Jev never sees; a failed holder read holds every
  soft entry (fail closed); a finished holder or a vanished overlap releases.
- Creation never stores a prefix-only overlap as a `dependsOn` edge.
- A force claim past a soft overlap records a `force_soft_overlap` bypass row
  with the holder, the paths and `calibration: human_force`: human feedback,
  never a model label.
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
- Creation-manifest candidates are tree-pinned when the server can read the
  repository tree at the task's base commit (`getServerTreeCandidateAdapter`,
  cached per commit, ranked by the workspace code corpus): every candidate
  exists at that commit and coverage is `tree_pinned`. Unknown scope then
  means candidate truncation or a path the task text names that the tree
  lacks. A failed tree or corpus read degrades to `neighbour_diff_only`.
- Each manifest group's verdict carries two eligibilities. Lease eligibility
  is the gated-application verdict above and still refuses unknown scope.
  Ordering eligibility grades the predicted set on whole-set precision/recall
  against the regex and neighbour-union baselines, reporting unknown scope as
  a covariate; it applies nothing.

**Acceptance criteria**:

- AC-1: GIVEN a gated definition and a requested fraction of 1 WHEN
  `resolveApplyingFraction` finds no matching evidence THEN the granted
  fraction is 0 (the creation-manifest path).
- AC-1b: GIVEN the shipped claim hold/start definition WHEN Jev answers START
  at or above the threshold THEN the row is applied with `experiment_arm`
  `apply`; below the threshold, or on a provider error, the effective verdict
  is HOLD.
- AC-1c: GIVEN a new task whose manifest overlaps an in-flight task's only by
  directory prefix WHEN it is created THEN no `dependsOn` edge is stored and
  the pair is recorded in `pathDeclaration.softOverlaps`; GIVEN the same file
  on both sides THEN the edge is stored and listed in `inferredDependsOn`.
- AC-1d: GIVEN a soft overlap with an in-flight holder WHEN no applied START
  exists THEN the claim defers with reason `soft_overlap` naming the holder,
  paths and verdict; WHEN one exists THEN the declared paths are acquired
  exclusively and the claim proceeds; WHEN the holder holds a live lease on
  the files THEN the claim defers regardless.
- AC-2: GIVEN matching eligible evidence WHEN the deployed definition's
  questions or model differ from the measured one THEN the refusal is
  `fingerprint_mismatch` and the granted fraction is 0.
- AC-3: GIVEN matching eligible evidence WHEN the deployed `minConfidence`
  differs from the measured threshold THEN the refusal is `threshold_mismatch`.
- AC-4: GIVEN matching eligible evidence with a cohort ceiling WHEN a larger
  fraction is requested THEN the granted fraction equals the ceiling.
- AC-5: GIVEN a requested fraction of 0 THEN the granted fraction is 0 and
  the gated START path is unreachable (no ledger lookup).
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
  `CLAIM_HOLD_MIN_CONFIDENCE`, `classifyClaimHoldEligibility`,
  `isGatedStartReachable`.
- `packages/core/path-overlap.ts`: `classifyManifestOverlap`,
  `partitionOverlapEdges`, `readSoftOverlaps`; callers POST /api/tasks and
  `apps/web/src/lib/conflict-retry.ts`.
- `apps/web/src/app/api/workers/claim/soft-overlap-gate.ts`:
  `evaluateSoftOverlaps`; holder read in `soft-overlap-store.ts`.
- `apps/web/src/lib/explain-coordination.ts`: `buildCoordinationHolds`, the
  explain answer's `coordination.holds` (edge kind, holder, paths, verdict).
- `packages/core/drizzle/0265_soft_overlap_legacy_edges.sql`: the legacy
  edge conversion (pending tasks only, idempotent).
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
- `apps/web/src/lib/orchestration-decision-stats-query.ts`:
  `fetchOrchestrationDecisionStats`, the DB-free evidence count (rows by
  decision group / UTC day / fallback reason, labelled vs unlabelled, opt-in
  state) behind MCP `get_decision_stats`. The readout script
  needs `DATABASE_URL`; this does not.
- Data model: `orchestration_decisions`, `orchestration_touch_labels`,
  `orchestration_manifest_predictions` in `packages/core/db/schema.ts`.

**Out of scope**:

- Any applied creation-manifest decision in production. Promotion is blocked
  pending deployed evidence.
- Widening hold/start beyond its three advisory gates.
- Early release of dependents before their upstream merges.
- The optional overlap-real decision (design §5c).
- Readout output: it holds workspace data and is a private artifact, never
  committed.
