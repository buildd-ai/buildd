---
title: Orchestration Decisions (Shadow and Promotion Guard)
status: active
owner: max
last_verified: 2026-10-15
summary: Creation-manifest decisions MUST stay record-only without a committed promotion; claim hold/start MAY apply a measured model's confident START to its three advisory gates; both fall back to the rule.
domain: tasks
surfaces: [packages/core/orchestration-decision.ts, packages/core/orchestration-promotion.ts, packages/core/orchestration-readout.ts, apps/web/src/app/api/workers/claim/hold-start-shadow.ts]
related: [model-routing-and-tiers, mission-task-lifecycle, live-sibling-conflict-probe]
keywords: [jev, shadow, gated, applying fraction, cohort, propensity, orchestration_decisions, orchestration_manifest, orchestration_claim, readout, insufficient_n, soft overlap, softOverlaps, partitionOverlapEdges, hold start]
verified_by: [packages/core/__tests__/orchestration-claim-learning.test.ts, packages/core/__tests__/orchestration-claim-learning-input.test.ts, packages/core/__tests__/orchestration-claim-learning-evidence.test.ts, packages/core/__tests__/orchestration-claim-learning-source.test.ts, apps/web/src/app/api/admin/operator/route.test.ts, packages/core/__tests__/orchestration-claim-risk.test.ts, packages/core/__tests__/orchestration-claim-risk-eval.test.ts, apps/web/src/lib/hard-overlap-surfaces.test.ts, packages/core/__tests__/orchestration-decision.test.ts, packages/core/__tests__/orchestration-promotion.test.ts, packages/core/__tests__/orchestration-readout.test.ts, packages/core/__tests__/orchestration-claim-decision.test.ts, packages/core/__tests__/path-overlap-edges.test.ts, apps/web/src/app/api/workers/claim/hold-start-shadow.test.ts, apps/web/src/app/api/workers/claim/soft-overlap-gate.test.ts]
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
# Orchestration Decisions (Shadow, Promotion Guard and Live Hold/Start)

**Capability statement**: Buildd MAY ask a decision model two orchestration
questions, which files a scope-less task will edit (at creation) and whether
an advisory-deferred task should start (at claim). It MUST record every answer
content-free. The creation-manifest answer MUST NOT change behaviour unless a
committed, evidence-backed promotion grants an applying cohort. The claim
hold/start answer MAY apply, but only a confident START from a model measured
for that decision, only to the three advisory gates, and never past a
deterministic rail.

The creation-manifest decision is **shadow-only** as shipped: no promotion is
recorded, so its applying fraction resolves to zero. See
`knowledge-base: buildd/design/conflict-aware-orchestration.md` "Rollout status".

**Claim hold/start is live by owner decision** (tasks 7eb191b9, d0db21dd and 1141e62e),
reversing the earlier "stays evidence-gated" exception: it ships `gated` at a
conservative starting threshold (`CLAIM_HOLD_MIN_CONFIDENCE`) with every
eligible deferral in the applying arm, and does not go through the promotion
guard. Every call is logged so the threshold can be recalibrated from labelled
outcomes. Each gate × area cell now has one persisted applying fraction; zero returns
that cell to deterministic HOLD. The committed fraction remains the bootstrap
ceiling. The existing model-policy dial evaluates and records each cell hourly.

**Hard vs soft path overlap**: a stored `dependsOn` edge blocks until the
upstream completes and merges, and is never re-checked. At creation (and on a
conflict retry) `partitionOverlapEdges` makes an inferred edge only for a
migration or schema path, or a workspace hard surface (`overlapIsHard`): a
serialized surface for any overlap, and, for a same-file overlap only, a
generated file (built-in regenerable or `gitConfig.derivedFiles`) or an
explicit hotspot (`gitConfig.overlapHotspots`). Every other overlap, same-file
or prefix-only, is SOFT: recorded as `pathDeclaration.softOverlaps` (the pair,
the overlapping paths, kind `same_file` or `prefix`), never an edge, and
decided at claim by hold/start (`soft_overlap` gate). Same-file overlap went
soft because most task pairs whose merged PRs touched the same file did not
actually conflict, so a hard hold wasted most of the wait.
Hardness is judged on the pair's FULL intersection: a pair that shares a file
and also a serialized directory (`seq-dir/` against `seq-dir/0042.ts`) is
hard. At most `MAX_SOFT_OVERLAPS_PER_TASK` soft pairs are stored, same-file
pairs first; an overlap past that budget becomes a hard edge rather than
running unheld with no evidence (fail closed).
Migration 0267 moved the pending tasks' pre-split inferred edges into
`softOverlaps` (kind `legacy_inferred`), reclassified at each claim against the
current manifests.

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
- Claim hold/start boots at `CLAIM_HOLD_APPLYING_FRACTION` (1) and 0.85,
  then serves the persisted gate × area cell fraction and threshold. Unresolved coordination
  state or a failed policy read holds. The already-live scope-undeclared
  advisory gate retains its conservative bootstrap in the unknown-area cell. Every lookup rechecks the current
  fraction's deterministic assignment and current confidence threshold, so an
  older applied START cannot escape a revert, reduced cohort or raised threshold.
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
- At claim, only advisory overlap deferrals are asked about: `open_pr_overlap`
  (every overlapping PR's worker ended) and `soft_overlap`. Undeclared scope is
  not a deferral and is never asked about (`claim-overlap-scheduling` I-42).
  `classifyClaimHoldEligibility` refuses a forced claim, an unresolved lease
  read, a live lease, a serialized surface, a migration path and (open-PR
  overlap) a live PR holder before any model sees the task. Declared
  dependencies, pacing, concurrency, caps, budgets and auth are never asked
  about.
- An applied START is honoured only for the same claim-time state digest and
  within its TTL; a ledger read error holds.
- A soft overlap holds only while its holder is in flight. Reclassified at
  claim (`evaluateSoftOverlaps`): a migration path or a workspace hard surface
  is a deterministic hold the decision model never sees; a hard-surface check that throws, or
  a malformed surface config, holds (fail closed); a failed holder read holds
  every soft entry (fail closed); a finished holder or a vanished overlap
  releases.
- For a soft overlap the decision model sees the overlap kind (`same_file` or `prefix`), each
  shared file's conflict history (merged PRs in the last 90 days whose task
  touched it, and how many needed a conflict retry; `no_history` when none),
  the holder's stage (`queued`, `just_started`, `working`, `in_review`,
  `approved`) and the candidate's predicted change size. The overlap kind is
  part of the state digest. A failed evidence read is a decision error: the
  decision falls back to the rule's HOLD without calling the model.
- Every claim-time advisory deferral is tiered in code first
  (`assessClaimOverlapRisk`): `hard` (a rail above), `no_effective_overlap`,
  `low`, `uncertain` or `high`, with a one-sentence rationale, the evidence
  source and age, and what would change it (`reevaluateOn`). Code decides:
  a soft overlap whose holder never started, or whose holder's current
  effective scope (PR diff at the current head, or live leases, read within
  `EFFECTIVE_SCOPE_MAX_AGE_MS`) is disjoint, is `no_effective_overlap`; a
  directory-only soft overlap is `low`. Both START without a ledger read or a
  model call (`rule_start`), still through the exclusive acquisition and every
  later gate. A fresh pair probe conflict (`PAIR_PROBE_MAX_AGE_MS`, heads
  current) or file history whose 95% Wilson lower bound is at least
  `HIGH_CONFLICT_LOWER_BOUND` on at least `MIN_FILE_HISTORY_SAMPLE` merged PRs
  is `high`: HOLD with no model call, recorded as a `fallback` row with reason
  `rule_decided`. Missing or stale evidence is `uncertain`, never `high`. Only
  `uncertain` and `low` same-file, open-PR and scope-undeclared deferrals
  reach the decision model, which sees the tier and its reasons, never the rationale prose.
  `CLAIM_RISK_DETERMINISTIC_START = false` sends the deterministic STARTs back
  to the model.
- Conflict history is judged on intervals, not point rates: a file's summary
  is `insufficient` until it has a sample and an interval narrow enough to
  call (`low` needs every shared file's upper bound at or below
  `LOW_CONFLICT_UPPER_BOUND`).
- Per claim response at most `CLAIM_HOLD_MAX_PER_CLAIM` decisions run,
  longest-waiting task first, out of up to `CLAIM_HOLD_MAX_NOTES` notes; a
  note skipped as recently asked does not use a slot.
- A START past a soft overlap that wins its claim records a
  `claim_loop_deferral` `accepted` row, reason `soft_overlap_start`, with
  `decidedBy` (`rule` or `jev`) and the tier. A held one records `riskTier`,
  `rationale` and `reevaluateOn` on its `soft_overlap` deferral.
- Policy changes are measured on the labelled replay set
  (`evaluateClaimRiskPolicy`, synthetic scenarios in
  `packages/core/__tests__/fixtures/claim-risk-scenarios.ts`, frozen
  train/heldout/later splits) against hold-everything and start-unless-hard
  baselines. A held pair is censored; clean merge, Mergiraf resolution and
  rebase are cost, not harm; a real conflict, a CI regression, a human
  intervention and a migration-index collision are harm, each counted apart.
- Creation never stores a prefix-only overlap, or a same-file overlap off the
  hard surfaces, as a `dependsOn` edge.
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

## Live claim learning

The feedback loop follows private artifact `coordination-visibility-map`
§8.1–8.3. Its readout separates `jev_start`, `jev_hold`,
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
- AC-11: GIVEN the shipped claim hold/start definition WHEN Jev (with no
  measurement row) answers START at or above the threshold THEN the row is applied with `experiment_arm`
  `apply`; below the threshold, or on a provider error, the effective verdict
  is HOLD.
- AC-12: GIVEN a new task whose manifest overlaps an in-flight task's by
  directory prefix, or on the same ordinary file, WHEN it is created THEN no
  `dependsOn` edge is stored and the pair is recorded in
  `pathDeclaration.softOverlaps` (kind `prefix` or `same_file`); GIVEN a
  migration path, or the same generated or hotspot file on both sides, THEN
  the edge is stored and listed in `inferredDependsOn`.
- AC-13: GIVEN a same-file soft overlap whose file has no merged-PR conflict
  history WHEN the decision model answers START at or above the threshold THEN the claim
  proceeds; GIVEN the same file is a migration path THEN the claim holds
  deterministically and no model is asked; GIVEN the evidence read fails THEN
  the effective verdict is HOLD with status `fallback`.
- AC-14: GIVEN a soft overlap with an in-flight holder WHEN no applied START
  exists THEN the claim defers with reason `soft_overlap` naming the holder,
  paths and verdict; WHEN one exists THEN the declared paths are acquired
  exclusively and the claim proceeds; WHEN the holder holds a live lease on
  the files THEN the claim defers regardless.
- AC-15: GIVEN a soft overlap that shares only a directory, or whose holder
  never started, WHEN the claim runs THEN it starts with no ledger lookup and
  no model call, its declared paths acquired exclusively; GIVEN that
  acquisition is refused THEN it holds; GIVEN a live lease on the files THEN
  it is `hard` and holds.
- AC-16: GIVEN a same-file soft overlap whose files' history has a 95% lower
  bound at or above `HIGH_CONFLICT_LOWER_BOUND` WHEN the decision runs THEN no
  model is called and the row is `fallback` / `rule_decided` with effective
  HOLD.
- AC-17: GIVEN more eligible deferrals than `CLAIM_HOLD_MAX_PER_CLAIM`, some
  recently asked, WHEN the decisions run THEN the recently asked ones are
  skipped without using a slot and the rest are asked longest-waiting first.
- AC-2: GIVEN matching eligible evidence WHEN the deployed definition's
  questions or model differ from the measured one THEN the refusal is
  `fingerprint_mismatch` and the granted fraction is 0.
- AC-3: GIVEN matching eligible evidence WHEN the deployed `minConfidence`
  differs from the measured threshold THEN the refusal is `threshold_mismatch`.
- AC-4: GIVEN matching eligible evidence with a cohort ceiling WHEN a larger
  fraction is requested THEN the granted fraction equals the ceiling.
- AC-5: GIVEN a requested fraction of 0 THEN the granted fraction is 0 and
  the gated START path is unreachable (no ledger lookup).
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
- AC-23: GIVEN a reverted cell or a raised threshold WHEN a previously applied
  START is looked up THEN the current policy still determines whether it applies.

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
  `partitionOverlapEdges`, `readSoftOverlaps`; callers POST /api/tasks and
  `apps/web/src/lib/conflict-retry.ts`.
- `apps/web/src/app/api/workers/claim/soft-overlap-gate.ts`:
  `evaluateSoftOverlaps`; holder read in `soft-overlap-store.ts`.
- `apps/web/src/lib/explain-coordination.ts`: `buildCoordinationHolds`, the
  explain answer's `coordination.holds` (edge kind, holder, paths, verdict).
- `packages/core/drizzle/20261008023735_soft_overlap_legacy_edges/migration.sql`: the legacy
  edge conversion (pending tasks only, idempotent).
- `apps/web/src/app/api/workers/claim/hold-start-shadow.ts`:
  `ClaimHoldCollector`, `scheduleClaimHoldShadow`, `grantedFraction`,
  `gatedStartApplies`, `acquireGatedStartPaths`, `releaseGatedStartPaths`;
  wired from `apps/web/src/app/api/workers/claim/route.ts`.
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
- Widening hold/start beyond its three advisory gates.
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
- was AC-1g, now AC-16
- was AC-1h, now AC-17

New: AC-18, a measured non-Jev model acts at its own threshold.
