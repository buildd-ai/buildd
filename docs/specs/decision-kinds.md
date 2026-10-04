---
title: Decision Kinds (First-Party Adapters and Migration Seam)
status: active
owner: max
last_verified: 2026-10-04
summary: A decision call site MUST target a typed decision kind that owns its features, override, fallback and objective, while routes, ledger rows, outcomes and the readout come from one shared substrate.
domain: tasks
surfaces: [packages/core/decision-kinds.ts, packages/core/decision-policy.ts, packages/core/decision-kind-post-session-triage.ts, packages/core/decision-kind-scout-probe-selection.ts]
related: [orchestration-decisions-shadow, mission-goal-criteria-quality, model-routing-and-tiers]
keywords: [decision policy platform, decision kind, post_session_triage, scout_probe_selection, challenger, escalation, shadow, decision_records, decision_outcomes, readout, collection health]
verified_by: [packages/core/__tests__/decision-kind-adapters.test.ts, packages/core/__tests__/decision-kinds-e2e.test.ts, packages/core/__tests__/decision-policy.test.ts, packages/core/__tests__/decision-readout.test.ts]
assertions:
  - id: "post-session-triage-kind"
    type: "symbol"
    name: "postSessionTriageKind"
    path: "packages/core/decision-kind-post-session-triage.ts"
  - id: "scout-probe-selection-kind"
    type: "symbol"
    name: "scoutProbeSelectionKind"
    path: "packages/core/decision-kind-scout-probe-selection.ts"
  - id: "failure-incident-triage-kind"
    type: "symbol"
    name: "failureIncidentTriageKind"
    path: "packages/core/decision-kind-failure-incident-triage.ts"
  - id: "define-buildd-decision-kind"
    type: "symbol"
    name: "defineBuilddDecisionKind"
    path: "packages/core/decision-kinds.ts"
  - id: "run-buildd-decision"
    type: "symbol"
    name: "runBuilddDecision"
    path: "packages/core/decision-policy.ts"
  - id: "run-buildd-challenger"
    type: "symbol"
    name: "runBuilddChallenger"
    path: "packages/core/decision-policy.ts"
  - id: "decision-comparison-table"
    type: "symbol"
    name: "formatDecisionComparison"
    path: "packages/core/decision-shadow-harness.ts"
  - id: "decision-kinds-e2e-test"
    type: "test_file"
    path: "packages/core/__tests__/decision-kinds-e2e.test.ts"
  - id: "decision-kind-adapters-test"
    type: "test_file"
    path: "packages/core/__tests__/decision-kind-adapters.test.ts"
---

# Decision Kinds

A call site asks a **kind** a question with bounded, typed features and gets a
typed decision back. It never names a provider or a model. The kind is the
contract; everything else (which model answered, whether a richer one was
consulted, what happens when none can answer, how it is recorded and measured)
is the substrate's.

## The substrate (shared)

- `defineBuilddDecisionKind` binds a kind config (features, override,
  questions, threshold, escalation policy, fallback) to a capability, a
  rollout mode (`live` | `shadow`), an optional escalation model, an optional
  challenger and a readout adapter.
- `runBuilddDecision` resolves the routes from the team's inference policy
  and keys, runs `runDecisionKind` (rule → cheap model → escalation slot →
  the kind's fallback) and writes one `decision_records` row per decided call
  through `toDecisionLedgerInput`.
- A bound challenger runs after the answer exists, out of band
  (`runBuilddChallenger`), and is recorded against that row. It never changes
  the applied answer.
- Outcomes arrive later as their own rows (`labelDecisionOutcome`), keyed
  (decision, source). The readout (`computeDecisionReadout`) reports collection
  health before sample size, and scores quality only through the kind's
  objective.

## First-party kinds

Two kinds ship as importable adapters. Their features, outputs and fallbacks
differ on purpose; the request, response, ledger and readout are identical.

| | `buildd.post_session_triage` | `buildd.scout_probe_selection` |
|---|---|---|
| Module | `packages/core/decision-kind-post-session-triage.ts` | `packages/core/decision-kind-scout-probe-selection.ts` |
| Question | Does a finished session deserve a deeper analysis? | Should the scout run this candidate probe? |
| Output | `skip` \| `analyse`, focus in the reason code (`triageFocusOf`) | `run` \| `defer` \| `unsupported` |
| Override | Any hard trigger the feature reports ⇒ `analyse` | No executor ⇒ `unsupported`; must-run ⇒ `run`; no budget ⇒ `defer` |
| Fallback | Fails open: `skip`, `TRIAGE_UNAVAILABLE` when no model answered | Leans toward coverage: `run` if it touches changed paths, else `defer` |
| Rollout | `live` | `shadow` (Scout is advisory in v1) |
| Escalation | None | On low confidence; no model bound yet |
| Outcome source / labels | `post_session_analysis`: `actionable`, `not_actionable` | `scout_probe_result`: `defect_found`, `no_defect` |

A feature imports the kind and calls `runBuilddDecision(postSessionTriageKind, …)`.
It keeps its own fact collection, trigger rules, probe catalogue and
execution; the kind owns only the decision contract. Adding an escalation
model or a challenger after measuring is a binding change
(`POST_SESSION_TRIAGE_BINDING` and its scout counterpart), not a caller change.

A third kind, `buildd.failure_incident_triage`
(`packages/core/decision-kind-failure-incident-triage.ts`), is wired from day
one by the Failure Pattern Sentinel (`apps/web/src/lib/failure-incident-actions.ts`).
It answers `known_noise` \| `monitor` \| `systemic_bug` \| `page_now` with a
`cause_<cause>` reason code, on bounded counters only. A `critical` floor is
`page_now` by rule; the fallback is the decision matching the rule engine's
floor severity. The caller only ever raises severity from the answer, never
lowers it. Capability `failure_incident_triage` (opt-in), rollout `live`, no
escalation or outcome source yet.

`packages/core/decision-shadow-harness.ts` gives a feature an in-memory
ledger (`createSyntheticDecisionLedger`) wired the same way as the database
path, and a side-by-side table (`formatDecisionComparison`) of collection
health, coverage, applied vs suggested vs fallback, decision mix, escalation,
challenger agreement, latency, cost and labelled correctness.

## Invariants

- A kind's override decides without asking any model, in every rollout mode,
  disabled included.
- A kind's fallback answer is always one of its own decisions; the substrate
  never invents one.
- A `shadow` kind never applies a model answer: its ledger row is
  `suggested` when a model answered and `fallback` otherwise, and records both
  the model's verdict and the answer in effect.
- `policyVersion`, `featureSchemaVersion`, the prompt fingerprint, the config
  fingerprint and each attempt's provider and model version are separate
  fields; bumping one leaves the others unchanged.
- Features built against another schema version are refused (fallback
  `invalid_features`), never coerced.
- A challenger never changes the applied answer or the ledger row it reads.
- An outcome label never rewrites a decision row; a second, different label
  from the same source is reported as a conflict and the first stands.

## Acceptance criteria

- AC-1: GIVEN a triage request with any hard trigger WHEN it runs in `live`, `shadow` or `disabled` mode THEN the response is `analyse` with source `rule` and no attempts.
- AC-2: GIVEN no provider route WHEN triage runs THEN the decision is `skip` with reason code `triage_unavailable`.
- AC-3: GIVEN a probe with no executor WHEN scout selection runs THEN the decision is `unsupported`, even if the probe is must-run.
- AC-4: GIVEN the scout kind in shadow mode and a confident cheap answer of `run` on a probe that touches no changed paths WHEN it runs THEN the applied decision is `defer` and the ledger row is `suggested` with verdict `run`.
- AC-5: GIVEN a scout cheap answer below threshold and a bound escalation model WHEN it runs THEN the response's attempt chain is cheap then escalation, with the escalation attempt pointing back at the cheap one.
- AC-6: GIVEN a triage kind bound to a challenger WHEN a model-decided call is recorded THEN a challenger row with its agreement exists for that record, and the applied decision is unchanged.
- AC-7: GIVEN a capability that is switched off WHEN the readout is computed THEN collection state is `disabled`, not `insufficient_sample`.
- AC-8: GIVEN features with an unknown hard trigger or probe kind WHEN either kind runs THEN the fallback cause is `invalid_features` and the feature digest is null.

## Migration seam for existing decisions

The decisions that predate kinds keep working as they are. None is rewritten
for symmetry; each moves only when its own next change would touch the same
code anyway. The seam is the same for all of them:

1. **Wrap, do not move.** Define a kind whose `questions` and `state` are the
   site's existing ones, unchanged, so its prompt fingerprint is continuous
   with what it asks today. The site's existing deterministic rule becomes the
   kind's `override`; its existing safe answer becomes `fallback`.
2. **Rails stay at the call site.** Candidate filtering, write paths and
   gates outside the decision (role candidate sets, lease and migration gates,
   "never replace a value a person set") are features or code around the
   call, not kind logic. The kind decides; the site still decides whether it
   may act.
3. **Swap the transport call, not the caller.** The site replaces its direct
   `decisionCall` (after `resolveDecisionAccess`) with `runBuilddDecision`.
   Its capability id stays the same, so team switches and the inference policy
   are untouched.
4. **Ledger.** Sites already writing `decision_records` through
   `recordDecision` get the same row from `toDecisionLedgerInput`, plus the
   kind columns (policy version, provider, attempt count, escalation, failure
   class, subject). Orchestration's manifest and hold/start decisions keep
   their own `orchestration_decisions` table, cohort gate and promotion guard
   (see the related spec); they adopt a kind only for the attempt chain, and
   only if the readout needs it.

| Existing site | Today | Seam |
|---|---|---|
| Task role routing (`apps/web/src/lib/task-role-decision.ts`, `applyTaskRoleDecision`) | Direct call, applies above threshold, writes the ledger | Kind = role pick over the code-built candidate set; candidate membership and the measured-model check stay in the apply step |
| Orchestration manifest and hold/start (`runOrchestrationDecision`) | Own ledger, cohort-gated apply | Unchanged; optional kind wrapper later for escalation |
| Goal criteria quality, strand choice, task category, question gate | Direct call, advisory or gated apply | Wrap when the next policy change lands |

## Code surface

- `packages/core/decision-kinds.ts` — binding and registry
- `packages/core/decision-policy.ts` — routes, plan, ledger write, challenger
- `packages/core/decision-kind-post-session-triage.ts` — `postSessionTriageKind`, `POST_SESSION_TRIAGE_CONFIG`
- `packages/core/decision-kind-scout-probe-selection.ts` — `scoutProbeSelectionKind`, `SCOUT_PROBE_SELECTION_CONFIG`
- `packages/core/decision-kind-failure-incident-triage.ts` — `failureIncidentTriageKind`, `FAILURE_INCIDENT_TRIAGE_CONFIG`
- `packages/core/decision-shadow-harness.ts` — synthetic ledger and comparison table
- `packages/core/decision-outcomes.ts`, `packages/core/decision-readout.ts` — labels and readout
- `packages/core/inference-policy.ts` — the `post_session_triage`, `scout_probe_selection` and `failure_incident_triage` capabilities

## Out of scope

- Wiring either kind into the post-session loop or the scout: those features import the adapters.
- Thresholds measured on a held-out set; both kinds ship unmeasured placeholders.
- Migrating any existing decision site.
