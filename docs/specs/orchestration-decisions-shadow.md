---
title: Orchestration Decisions (Shadow and Promotion Guard)
status: active
owner: max
last_verified: 2026-10-23
summary: Creation-manifest decisions MUST stay record-only without a committed promotion and fall back to the rule; the claim hold/start question is retired and its ledger stays readable.
domain: tasks
surfaces: [packages/core/orchestration-decision.ts, packages/core/orchestration-promotion.ts, packages/core/orchestration-readout.ts, apps/web/src/app/api/workers/claim/start-lease.ts]
related: [model-routing-and-tiers, mission-task-lifecycle, live-sibling-conflict-probe]
keywords: [jev, shadow, gated, applying fraction, cohort, propensity, orchestration_decisions, orchestration_manifest, orchestration_claim, readout, insufficient_n, soft overlap, softOverlaps, hold start]
verified_by: [packages/core/__tests__/orchestration-claim-learning.test.ts, packages/core/__tests__/orchestration-claim-learning-input.test.ts, packages/core/__tests__/orchestration-claim-learning-evidence.test.ts, packages/core/__tests__/orchestration-claim-learning-source.test.ts, apps/web/src/app/api/admin/operator/route.test.ts, packages/core/__tests__/orchestration-claim-risk.test.ts, packages/core/__tests__/orchestration-claim-risk-eval.test.ts, apps/web/src/lib/hard-overlap-surfaces.test.ts, packages/core/__tests__/orchestration-decision.test.ts, packages/core/__tests__/orchestration-promotion.test.ts, packages/core/__tests__/orchestration-readout.test.ts, packages/core/__tests__/orchestration-claim-decision.test.ts, packages/core/__tests__/path-overlap-edges.test.ts, apps/web/src/app/api/workers/claim/start-lease.test.ts]
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
  - id: "assess-claim-overlap-risk"
    type: "symbol"
    name: "assessClaimOverlapRisk"
    path: "packages/core/orchestration-claim-risk.ts"
  - id: "evaluate-claim-risk-policy"
    type: "symbol"
    name: "evaluateClaimRiskPolicy"
    path: "packages/core/orchestration-claim-risk-eval.ts"
  - id: "release-start-lease"
    type: "symbol"
    name: "releaseStartPaths"
    path: "apps/web/src/app/api/workers/claim/start-lease.ts"
  - id: "read-soft-overlaps"
    type: "symbol"
    name: "readSoftOverlaps"
    path: "packages/core/path-overlap.ts"
  - id: "start-lease-test"
    type: "test_file"
    path: "apps/web/src/app/api/workers/claim/start-lease.test.ts"
  - id: "hard-overlap-surfaces"
    type: "symbol"
    name: "overlapIsHard"
    path: "apps/web/src/lib/hard-overlap-surfaces.ts"
  - id: "soft-overlap-evidence"
    type: "symbol"
    name: "loadSoftOverlapEvidence"
    path: "packages/core/orchestration-claim-source.ts"
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
# Orchestration Decisions (Shadow, Promotion Guard and Hold/Start History)

**Capability statement**: Buildd MAY ask a decision model which files a
scope-less task will edit (at creation). It MUST record every answer
content-free, and the answer MUST NOT change behaviour unless a committed,
evidence-backed promotion grants an applying cohort. The claim hold/start
question (whether an overlap-deferred task should start) is retired: nothing
asks it, and its recorded rows stay readable.

The creation-manifest decision is **shadow-only** as shipped: no promotion is
recorded, so its applying fraction resolves to zero. See
`knowledge-base: buildd/design/conflict-aware-orchestration.md` "Rollout status".

**Claim hold/start is retired** (living spec *Overlap scheduling: serial lanes
and file locks*, R-1 to R-3). Nothing is guessed from overlapping manifests at
creation, so there is no advisory overlap deferral left to ask about: at claim
only lane paths (migration or schema, the unmergeable list, a workspace hard
surface) hold, deterministically, and the edit-time lease stops two agents
editing one file. No `orchestration_claim` decision is asked or recorded. The
rows already in `orchestration_decisions`, the risk tiering
(`assessClaimOverlapRisk`), the replay evaluation, the learning cells and the
readouts below remain, reading that history.

**Path overlap at creation**: no `dependsOn` edge and no
`pathDeclaration.softOverlaps` entry is minted from overlapping manifests, in
POST /api/tasks or a conflict retry. Older rows keep theirs:
`pathDeclaration.inferredDependsOn` edges still gate as dependencies, and
`softOverlaps` (kinds `same_file`, `prefix`, `legacy_inferred`, read by
`readSoftOverlaps`) hold nothing at claim.

**Invariants**:

- Every orchestration decision goes through `runOrchestrationDecision`: one
  overall deadline covers access, retrieval and the call, and every failure
  (capability off, no key, deadline, invalid answer, provider error, empty
  candidate set, thrown dependency) returns the caller's deterministic rule
  verdict. It never throws.
- An answer is applied only when all three hold: the kit's policy permits it
  (not `shadow`), the answering model is measured for this decision and its
  answer clears the measured gate, and the unit was drawn into the applying
  arm. Measured means `measurementFor` (`packages/core/decision-model-measurements.ts`)
  finds an active `decision_model_measurements` row for the decision id, the
  answering model and the decision's current prompt version; Jev with no row
  counts as measured at the definition's own threshold. `gateOnMeasurement`
  then compares the number the row names (confidence, top p, margin or
  calibrated top p) with the row's threshold, or with per-label thresholds
  when the row acts on some labels only. Any other model, or a row whose
  prompt version no longer matches, or a retired row, is recorded as a
  suggestion with reason `non_jev`, never applied, even inside a granted
  cohort. A measured answer below its threshold is `below_threshold`.
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
- Opting a team in (`teams.enabledDecisionShadows`) is a platform operator's
  switch, written only through `PATCH /api/admin/teams/[id]/experiment-flags`;
  team settings refuse it to every team role
  (`docs/specs/team-permissions.md` "Platform operator").
- No overlap at claim is asked about. A soft overlap holds nothing; an open
  PR or a live lease holds only on a lane path, without a model.
- `assessClaimOverlapRisk` tiers an overlap in code (`hard`,
  `no_effective_overlap`, `low`, `uncertain`, `high`) for the replay
  evaluation and the readouts of recorded decisions; the claim route no longer
  calls it.
- Conflict history is judged on intervals, not point rates: a file's summary
  is `insufficient` until it has a sample and an interval narrow enough to
  call (`low` needs every shared file's upper bound at or below
  `LOW_CONFLICT_UPPER_BOUND`).
- A claim that starts alongside an open PR or a live lease on non-lane files
  records a `claim_loop_deferral` `accepted` row, reason `soft_overlap_start`,
  with `decidedBy: 'rule'`.
- Policy changes are measured on the labelled replay set
  (`evaluateClaimRiskPolicy`, synthetic scenarios in
  `packages/core/__tests__/fixtures/claim-risk-scenarios.ts`, frozen
  train/heldout/later splits) against hold-everything and start-unless-hard
  baselines. A held pair is censored; clean merge, Mergiraf resolution and
  rebase are cost, not harm; a real conflict, a CI regression, a human
  intervention and a migration-index collision are harm, each counted apart.
- Creation never stores an overlap of any kind as a `dependsOn` edge or a
  `softOverlaps` entry.
- A claim that starts alongside an open PR on non-lane files acquires its own
  lane paths through the exclusive acquisition primitive before the atomic
  claim. If the claim is then lost, `releaseStartPaths` gives back exactly the
  lease rows that acquisition inserted (`releaseLeaseRows`, by row id,
  manifest untouched), unless a winning claim now owns the task, re-checked
  under the workspace lock. Waiters on a released path are told the task's
  real release reason (`resolveReleaseReasonForTask`).
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

## Live claim learning

Since hold/start was retired no new claim decision is recorded; this loop
reads the history. The feedback loop follows private artifact
`coordination-visibility-map` §8.1–8.3. Its readout separates `jev_start`, `jev_hold`,
`deterministic_hold`, `human_force`, `rule_start_overlap` and `rule_start_clean`
by gate, area (`core/db`, `other`, `unknown`) and prompt fingerprint. Holds are
censored for safety and retain wait/stranded measurements. An applied model
answer is on-policy evidence only when a successful claim records the same
gate, blockers, overlap paths and fingerprint within the decision TTL. A task
that runs later after its blocker clears does not retrospectively validate START.

Every group shows raw risk, attributable unsafe rate, clean-start base rate and
the overlap control separately. Clean deterministic starts are recorded at
successful claims with known scope and no observed coordination blocker.
Only landed runs can be labelled safe. A collision is attributable when its
path or counterparty matches the start-time overlap; base refusal requires
both. Existing conflict-retry records without conflicting file and counterparty
evidence remain unknown, rather than counting every conflict against Jev.
Human outcomes are observational; they never change confidence or allocation.
Stale-blocker outcomes are excluded from learning and reported as ownership
hygiene. Missing evidence, unlanded runs and censored outcomes never count safe.

Cells reuse `decideDialCell`, its allocation steps, events, evidence boundary
and revert cooldown. The policy records delta (default 0.05), minimum sample
per arm (default 20), confidence, fraction, dial state and owner pin. Confidence
is the lowest applied-cohort threshold whose attributable-unsafe Wilson upper
95% bound is at most the clean base rate plus delta, with enough samples on
both arms; below the sample bar it stays 0.85. Thresholds never pool human
forces, stale blockers or different prompt fingerprints. A prompt revision
resets calibration and records a new evidence boundary.

An increase requires both that safety bound and a measured median wait or idle
improvement against held controls with enough timing samples. These timing
comparisons are observational, never causal claims. An observed attributable unsafe-rate breach with sufficient samples
reverts the cell to fraction zero in one evaluation, including a pinned cell.
The existing tier-pools cron runs this evaluation hourly; no scheduler is added.
Every evaluation atomically records its policy revision, evidence summary and
reason alongside the compare-and-set update. Partial reads never lower the
threshold or raise the applying fraction. A failed read changes no policy.

False-hold candidates require a safe human force and a prior Jev HOLD matching
the task, gate, area and blocker/path evidence. False-start candidates require
an attributable unsafe Jev START. Both are prompt-revision candidates only;
neither automatically rewrites a prompt. Revised prompts must bump the prompt
version, which changes the fingerprint and splits the next readout.

The platform-owner operator API exposes this through `claimLearning=1`;
a failed panel read is `claimLearning: null`, and non-owners receive 404.
Owner `claim_learning_pin`, `claim_learning_revert` and
`claim_learning_set_delta` actions require a revision and reason, use the
existing owner-action audit path and write policy changes. A pin cannot
bypass a safety revert or unresolved coordination state. Missing code-area
metadata is distinct from an unresolved coordination state: eligible
scope-undeclared advisory decisions retain their live bootstrap. The companion screen belongs in
the platform admin application; no member UI is added.

**Acceptance criteria**:

- AC-1: GIVEN a gated definition and a requested fraction of 1 WHEN
  `resolveApplyingFraction` finds no matching evidence THEN the granted
  fraction is 0 (the creation-manifest path).
- AC-11: GIVEN a claim whose task overlaps an open PR on an ordinary file
  WHEN a runner polls THEN it is claimed and no `orchestration_claim`
  decision is asked or recorded.
- AC-12: GIVEN a new task whose manifest overlaps an in-flight task's by
  directory prefix, on the same file, or on a migration path WHEN it is
  created THEN no `dependsOn` edge is stored and neither `softOverlaps` nor
  `inferredDependsOn` is written.
- AC-13: GIVEN a candidate carrying a stored same-file soft overlap onto a
  running holder, on a migration path or not, WHEN a runner polls THEN it is
  claimed and no `soft_overlap` deferral is written.
- AC-14: GIVEN an open PR or a live lease on a lane path WHEN a candidate on
  that path polls THEN it defers as `path_overlap`, with no model call.
- AC-15: GIVEN a candidate declaring `apps/web/src/lib/` and `bun.lock` that
  starts alongside an open PR on `apps/web/src/lib/widget.ts` WHEN it claims
  THEN only `bun.lock` is acquired up front; GIVEN that acquisition is refused
  THEN it holds.
- AC-2: GIVEN matching eligible evidence WHEN the deployed definition's
  questions or model differ from the measured one THEN the refusal is
  `fingerprint_mismatch` and the granted fraction is 0.
- AC-3: GIVEN matching eligible evidence WHEN the deployed `minConfidence`
  differs from the measured threshold THEN the refusal is `threshold_mismatch`.
- AC-4: GIVEN matching eligible evidence with a cohort ceiling WHEN a larger
  fraction is requested THEN the granted fraction equals the ceiling.
- AC-5: GIVEN a requested fraction of 0 THEN the granted fraction is 0
  without reading evidence.
- AC-6: GIVEN a granted cohort of 1 WHEN a model with no active measurement
  for the decision (none stored, a retired row, or a row for another prompt
  version) answers START with high confidence THEN the outcome is `suggested`
  with reason `non_jev` and the effective verdict is the rule's HOLD.
- AC-18: GIVEN an active measurement row for a non-Jev model at the
  decision's current prompt version WHEN that model answers START above the
  row's threshold, even below the definition's own threshold THEN the answer
  is applied; WHEN it answers below the row's threshold THEN the outcome is
  `suggested` with reason `below_threshold`.
- AC-7: GIVEN the decision provider returns an error or the deadline passes
  WHEN a decision runs THEN the effective verdict is the rule verdict and the
  row's status is `fallback`.
- AC-8: GIVEN a claim that acquired lane leases WHEN the atomic claim is lost
  and the task is no longer owned by a live claim THEN only the rows that
  attempt inserted are released, and another attempt's leases for the same
  task survive; WHEN the task is now `assigned`, `in_progress` or `review`
  THEN they are kept.
- AC-9: GIVEN only shadow claim decisions (every hold censored) WHEN the
  readout runs THEN the claim verdict is `insufficient_n` with a null
  threshold, and its wait, stranded and throughput figures are still reported.
- AC-10: GIVEN no recorded decisions in the window WHEN the readout runs THEN
  both decisions are `insufficient_n` and the promotion status is `blocked`.

- AC-19: GIVEN human forces and Jev starts in the same window WHEN read out
  THEN actors remain separate and only successful, attributable, non-stale Jev
  starts calibrate confidence or applying fraction.
- AC-20: GIVEN fewer than the minimum samples on either arm WHEN calibrated
  THEN confidence remains 0.85; unknown attribution never supplies a safe label.
- AC-21: GIVEN enough evidence WHEN both safety and timing improve THEN the
  existing dial may raise one step; WHEN observed attributable unsafe exceeds the
  policy budget with enough samples THEN fraction becomes zero in one evaluation, including a pin.
- AC-22: GIVEN an owner read WHEN a panel dependency fails THEN claimLearning
  is null; GIVEN a non-owner THEN the operator route returns 404.
**Code surface**:

- `packages/core/orchestration-decision.ts`: `runOrchestrationDecision`,
  `assignApplyingArm`, `contentFreeLabel`.
- `packages/core/decision-model-measurements.ts`: `measurementFor`,
  `gateOnMeasurement`, the `decision_model_measurements` rows that let a
  model act.
- `packages/core/orchestration-promotion.ts`: `resolveApplyingFraction`,
  `ORCHESTRATION_PROMOTIONS`, `measuredIdentity`, `manifestPickIdentity`.
- `packages/core/orchestration-claim-risk.ts`: `assessClaimOverlapRisk`,
  `wilsonInterval`, `judgeFileHistory`, `CLAIM_RISK_DETERMINISTIC_START`;
  `packages/core/orchestration-claim-risk-eval.ts`:
  `evaluateClaimRiskPolicy`, `riskProfilePolicy`, `holdAllPolicy`.
- `packages/core/orchestration-claim-decision.ts`: `CLAIM_HOLD_DECISION`,
  `CLAIM_HOLD_MIN_CONFIDENCE`, `classifyClaimHoldEligibility`,
  `isGatedStartReachable`.
- `apps/web/src/lib/hard-overlap-surfaces.ts`: `overlapIsHard`,
  `resolveHardOverlapSurfaces` (serialized, generated, hotspot); hotspot list
  validated by PATCH `/api/workspaces/[id]` (`gitConfig.overlapHotspots`).
- `packages/core/orchestration-claim-decision.ts` /
  `orchestration-claim-source.ts`: `deriveHolderStage`,
  `summarizeFileConflictHistory`, `loadSoftOverlapEvidence`.
- `packages/core/path-overlap.ts`: `classifyManifestOverlap`,
  `readSoftOverlaps` (older rows only).
- `apps/web/src/lib/explain-coordination.ts`: `buildCoordinationHolds`, the
  explain answer's `coordination.holds` (edge kind, holder, paths, verdict).
- `packages/core/drizzle/20261008023735_soft_overlap_legacy_edges/migration.sql`: the legacy
  edge conversion (pending tasks only, idempotent).
- `apps/web/src/app/api/workers/claim/start-lease.ts`: `acquireStartPaths`,
  `releaseStartPaths`; wired from `apps/web/src/app/api/workers/claim/route.ts`.
- `packages/core/manifest-prediction.ts` and `manifest-prediction-source.ts`:
  `predictCreationManifest`, `prepareGatedManifest`, `labelManifestPrediction`.
- `packages/core/orchestration-claim-learning.ts`: calibration and the shared dial adapter.
- `packages/core/orchestration-claim-learning-evidence.ts`: conservative attribution.
- `packages/core/orchestration-claim-learning-input.ts`: successful claim/control evidence.
- `packages/core/orchestration-claim-learning-source.ts`: policy CAS, hourly step and operator readout.
- `apps/web/src/lib/admin/data.ts`: owner panel loader; `apps/web/src/app/api/admin/operator/route.ts`: owner reads/actions.
- `apps/web/src/lib/admin/claim-learning-actions.ts`: audited policy overrides.
- `apps/web/src/app/api/cron/tier-pools/route.ts`: existing hourly dial step.
- `packages/core/orchestration-outcomes.ts`: `labelDecisionOutcomes`.
- `packages/core/orchestration-readout.ts`: `buildOrchestrationReadout`,
  `splitWorkUnits`, `replayDecisionEval`, `calibrateAndJudge`; loader
  `packages/core/orchestration-readout-source.ts`; operator command
  `scripts/orchestration-readout.ts`.
- `apps/web/src/lib/orchestration-decision-stats-query.ts`:
  `fetchOrchestrationDecisionStats`, the DB-free evidence count (rows by
  decision group / UTC day / fallback reason, labelled vs unlabelled, opt-in
  state) behind MCP `get_decision_stats` without `capability`; with it, the
  raw ledger (`GET /api/decisions`) of the caller's own team. The readout
  script needs `DATABASE_URL`; this does not.
- Data model: `orchestration_decisions`, `orchestration_touch_labels`,
  `orchestration_manifest_predictions` in `packages/core/db/schema.ts`.

**Out of scope**:

- Any applied creation-manifest decision in production. Promotion is blocked
  pending deployed evidence.
- Asking a model about overlap at claim (retired).
- Early release of dependents before their upstream merges.
- The optional overlap-real decision (design §5c).
- Readout output: it holds workspace data and is a private artifact, never
  committed.

## Renumbered

Suffixed ids did not parse as their own criteria. Old to new:

- was AC-1b, now AC-11
- was AC-1c, now AC-12
- was AC-1e, now AC-13
- was AC-1d, now AC-14
- was AC-1f, now AC-15
- was AC-1g, now AC-16 (retired with hold/start)
- was AC-1h, now AC-17 (retired with hold/start)

New: AC-18, a measured non-Jev model acts at its own threshold.
