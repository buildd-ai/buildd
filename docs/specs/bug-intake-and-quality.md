---
title: Bug Intake and Quality
status: draft
owner: max
last_verified: 2026-10-11
summary: Every defect report MUST land as one report on one failure incident, every incident above noise MUST have exactly one owner, and every resolved defect MUST trace to the change, release and agent that introduced it.
domain: tasks
surfaces: [apps/web/src/lib/failure-incident-actions.ts, apps/web/src/lib/failure-pattern-sweep.ts, apps/web/src/lib/failure-incident-store.ts, packages/core/release-attribution.ts]
related: [decision-kinds, living-specs, subject-anchor-liveness, path-claim-ownership, release-flow, model-policy-cells, model-routing-and-tiers]
keywords: [bug intake, friction, frictionSignature, gate refusal, incident_reports, failure_incidents, Failure Pattern Sentinel, reconciliation, attach_to, new_pattern, noise, needs_owner, intake_reconcile, Jev, fix task, introducing release, release_tasks, escape rate, defect rate, recurrence, time to resolve, report a problem, duplicate friction tasks]
verified_by: []
supersedes: []
assertions:
  - id: failure-incident-triage
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: symbol
    name: triageIncident
    path: apps/web/src/lib/failure-incident-actions.ts
  - id: failure-incidents-table
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: symbol
    name: failureIncidents
    path: packages/core/db/schema.ts
  - id: release-attribution
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: symbol
    name: attributeRelease
    path: packages/core/release-attribution.ts
---

# Bug Intake and Quality

**Capability statement**: Every report that something is broken, from any
source, MUST be recorded as one report row attached to at most one failure
incident. Each incident above noise MUST have exactly one owner within one
sweep, and at most one live fix task. The incident MUST move through a
derived lifecycle that ends only when a stated check passes after the fix
shipped. Each defect MUST be traced, with a recorded confidence, to the
change, task, PR, mission and release that introduced it, so that defect
rates per role, model tier and mission are computed from facts.

**Status: draft.** Nothing here is built. This spec depends on
`docs/specs/failure-incident-recovery.md` as it stands on the integration
branch of mission `ecea17f3` (not yet on `dev`). Symbols from that branch
(`assessIncident`, `planRecovery`, `assessDueIncidents`, the `recovery`
column) are cited as if they had landed. Build slices (§14) start only after
both this spec and that mission have merged.

## 0. The short answer

Most of this extends machinery that already exists. The Failure Pattern
Sentinel's `failure_incidents` ledger is already the "pattern" object. It has
a stable signature, counts, refs, one deduped fix task, paging on transitions
only, and (from the recovery spec) a versioned assessment that resolves on a
passing check. The friction dedupe, subject anchors, the decision substrate,
the release ledger and Living Spec verdicts all exist too. What is missing is
the glue:

1. **One door.** Each reporting source has its own dedupe today, or none. The
   friction dedupe matches exact signatures on task titles, subject anchors
   match on task columns, the release watcher dedupes on `context.releaseId`,
   post-session findings have their own ledger, and the Sentinel has its own.
   None of them attaches a report to the others' objects.
2. **A judgement step for the remainder.** Exact keys miss the same bug
   described in different words. A small typed decision kind closes that gap,
   and outcomes label it.
3. **Ownership and closure.** Most open high incidents have no fix task and
   no family that resolves them. Only `path_overlap_stall` resolves itself.
4. **A backward link.** Nothing records which release or task introduced a
   defect, so no defect rate exists.

New storage is one append-only table (`incident_reports`), one nullable jsonb
column (`failure_incidents.trace`) and one new rule value (`reported`).
Everything else reuses existing writers.

---

## 1. Prior art and boundary

### 1.1 What the recovery spec owns and what this spec adds

| Concern | `failure-incident-recovery` owns | This spec adds |
|---|---|---|
| The incident row | `failure_incidents`, its CAS, `upsertIncident` / `mergeIncident`, reopen with `recurrenceCount + 1` | The `reported` rule for incidents opened from reports, and the `trace` column (§10) |
| What Buildd is doing now | The `recovery` assessment: state, owner, next check, repair budget, typed person options | The fix-task stage (open → … → verified), derived from the fix task, its PR and the release ledger, and cached in `trace.stage` |
| Resolution | The rule that an incident resolves only on a decidable check, never on "no new occurrence lately" (§7); the path-overlap check | A resolve check for each of the other seven rules plus `reported` (§5.5). No repair policies for them. |
| Fix task | "At most one per incident" through `createDbFixTaskPort` | "Exactly one owner above noise"; a collision check against in-flight missions, path claims and open PRs before filing; a budget of two fix tasks per generation (§5) |
| Escalation and surfaces | The gate, the Needs You projection, the incident page, the push | One new person decision (`needs_owner`, §4.4), routed through the same gate and the same `needs_decision` state; the owner's "Report a problem" reply (§9) |
| Reports | none (detectors only) | `incident_reports`, the intake function, reconciliation and its decision kind (§3, §4) |
| Attribution and metrics | none | `trace.introducedBy`, escape, defect rate, time to resolve, recurrence (§6, §7) |
| Specs | none | Mapping an incident to a Living Spec criterion verdict or a repo-spec discrepancy (§8) |

Nothing in this spec changes a recovery-spec invariant. Where the two touch,
the recovery spec wins: `recovery.state` stays the only source of who is asked,
and `trace.stage` never causes a page by itself.

### 1.2 Everything else this builds on

| Piece | Where | What it does today | Role here |
|---|---|---|---|
| Friction dedupe | `apps/web/src/app/api/tasks/route.ts`, `toFrictionSignature` | It appends a duplicate `[friction]` report to an open task that has the same `context.frictionSignature`, matching exactly. | It becomes one call into intake. The exact-signature rule (§4.1 R1) keeps its semantics. |
| Gate refusal key | `gateFrictionSignature`, `apps/web/src/lib/gate-ledger.ts` | A gate 400 body carries a `gate:<stem>_<hash>` key for the agent to forward. | The key arrives at intake with source `gate_refusal` and is matched exactly. |
| Error normalizer | `normalizeErrorSignature` in `apps/web/src/lib/error-signature.ts` | Collapses ids, times and quoted slugs out of error text. | Computes the report fingerprint (§4.1 R2). |
| Subject anchors | `extractSubjectAnchor`, `subjectMatchPredicate`, `task_subject_claims` | Task-level dedupe on identifying keys (`pr_generation`, `error`). | The anchor rule (§4.1 R3). An anchor's PR also feeds attribution (§6). |
| Sentinel rules | `detectFailurePatterns` in `apps/web/src/lib/failure-pattern-sentinel.ts` | Eight deterministic rules turn structured facts into incidents. | Unchanged. Each new Sentinel incident also writes one `sentinel` report, so all sources share one index (§3.3). |
| Triage kind | `buildd.failure_incident_triage` | Returns `known_noise`, `monitor`, `systemic_bug` or `page_now`, using the rule severity as a floor. | Unchanged. It still decides whether an incident is above noise. The new kind decides which incident a report belongs to. |
| Decision substrate | `defineBuilddDecisionKind`, `runBuilddDecision`, `runBuilddChallenger`, `labelDecisionOutcome`, `decision_records`, `decision_outcomes` | Runs rule, then cheap model, then fallback; keeps a ledger, challenger rows and outcome labels. | Hosts `buildd.intake_reconcile` (§4.2). No new decision machinery. |
| Release ledger | `releases`, `release_tasks`, `attributeRelease` | Maps each release's commit range to its PRs and tasks. | The forward map that attribution reads backwards (§6). |
| Release health | `autoFileDegradationTask` in `apps/web/src/lib/release-health-watcher.ts` | Files one `[degraded]` task per degraded release. | Becomes a `release_health` report (§3.2). |
| Reverts | `pr_reverts`, `parseRevertReferences` | Records which PR reverted which. | Exact attribution evidence (§6.1). |
| Post-session findings | `post_session_findings`, `apps/web/src/lib/post-session-findings.ts` | Keeps its own signature ledger and can file an action task. | Its `file_task` action becomes a `post_session` report. The findings ledger keeps its analysis role. |
| Trunk incidents | `trunk_incidents`, workflow kernel | The kernel repairs a red trunk itself. | Out of scope. The kernel keeps them. Only escalated PR CI and post-merge integration failures become reports. |
| Living Spec verdicts | `recordSpecVerdict`, `recordSpecConflict`, `specCriteria`, `spec_discrepancies` | Records per-criterion verdicts on pinned tasks, and conflicts between criteria. | Target of the spec mapping (§8). |
| Routing telemetry | `recordTaskOutcome` (`task_outcomes`), `computeExperimentReadout`, model-policy cells | Grades each run on merged, review ok and no rework. | Gains a late "no attributed defect" signal (§7.3). |

---

## 2. Evidence: the clusters this is written against

These come from a read of the incident ledger (all statuses) and the gate
ledger (30 days) on 2026-10-11. Only shapes and small counts are given. The
figures themselves are in the knowledge base.

1. **One cause, two incidents.** Two `repeated_failure` incidents were open
   for the subscription session limit. Their normalized texts differ only in
   a trailing "[work preserved: …]" note. Both were medium, unalerted and had
   no fix task. Under this spec, the fingerprint rule (§4.1 R2) folds the
   second report into the first incident, and triage classes the cause as
   `budget_or_quota`, which files no fix task.
2. **An infrastructure cause with a person-owned remedy.** One
   `repeated_failure` incident (high) was open for an expired Codex
   credential across several unrelated tasks, with no fix task. Code cannot
   fix it. The owner reconnecting can. §5.1 routes it to the existing
   RECONNECT chip as its owner. Attribution is `infrastructure` with
   confidence `exact` (§6.3), so it adds nothing to anyone's defect rate.
3. **Correctly separate incidents that look alike.** Dozens of
   `path_overlap_stall` incidents exist, one per blocker PR, and almost all
   were resolved by the recovery assessment. They are distinct episodes, and
   reconciliation MUST NOT merge them (§4.1: Sentinel signatures are never
   rewritten). The recovery spec's `causeGroup` already groups them for the
   operator.
4. **High, open and owned by nobody.** Several `stranded_gate` incidents
   (claim deferral on path overlap, on dependencies blocked and on budget
   paused; landing on protected paths; base moving under an approved PR) were
   open for days with no fix task and no resolve check. Under §5, each gets an
   owner within one sweep. A recovery family owns the path-overlap one. The
   rest get a fix task or a check. A stranded-gate incident resolves when no
   task is currently stranded at that gate and reason (§5.5).
5. **Stale retry-fork and lineage incidents.** Several `retry_fork` and
   `lineage_multi_pr` incidents from early October were still open, though
   the fork bug was fixed. Their families have no check, so nothing closes
   them. §5.5 gives each a check that the sweep can decide.
6. **A symptom incident with its own fix task.** The single critical incident
   was a `failure_rate_spike`. It was the only incident with a fix task, and
   its failures were largely the session-limit and credential failures from
   items 1 and 2. A spike is a symptom. §5.2 makes a spike whose failures are
   mostly explained by other open incidents point at those incidents, not
   file its own fix.
7. **Free-text reasons explode the key space.** In the gate ledger,
   `pr_landing` alone carried hundreds of distinct reason strings over 30
   days, and most were the same few states with numbers in them. Exact keys
   on raw text would make each one its own pattern. That is why the
   fingerprint rule runs `normalizeErrorSignature` before matching. It is
   also why intake takes only `rejected` and `stranded` gate outcomes, never
   `deferred` or `warned` (§3.2).
8. **The history of friction filings.** An earlier audit (task `58e4c841`)
   found one bug filed ten times under ten titles, and zero of about eighty
   friction reports deduped, because a gate refusal gave the agent no key.
   The gate key fixed the exact-match half. A `create_pr` branch-mismatch
   cluster then filed four tasks for one bug, because the branch name sat
   inside the error text. Normalization fixed that one. Each fix closed one
   shape. The judgement step in §4.2 exists for the shapes nobody has seen
   yet.

---

## 3. Intake: one door for every source

### 3.1 The entry point

One server function, `intakeReport(input)` in
`apps/web/src/lib/incident-intake.ts` (new), is the only writer of
`incident_reports`. Every source calls it. It:

1. computes the fingerprint and extracts the anchor;
2. writes the report row, idempotent on `(workspace_id, idempotency_key)`;
3. reconciles the report (§4) and writes the decision onto the row;
4. folds the report into its incident (`upsertIncident` for a new
   `reported` incident, or a CAS bump of `lastSeenAt` and refs for an
   existing one);
5. runs the existing action layer (`actOnIncidentResults`) only when the
   incident changed state.

It never throws to its caller. A failure after step 2 leaves the report with
`decision = null`. The next sweep picks it up (§5.4, step 1).

### 3.2 Sources

| Source (`source`) | Caller | When it reports | Supplied key |
|---|---|---|---|
| `agent_friction` | `POST /api/tasks`, `[friction]` title | An agent files friction | `context.frictionSignature` if present |
| `gate_refusal` | `POST /api/tasks`, `[friction]` title with a `gate:` key | An agent forwards a gate 400 key | The `gate:<stem>_<hash>` key |
| `sentinel` | the sweep, after `upsertIncident` opens an incident | A new Sentinel incident opens | The rule's discriminator signature (§3.3) |
| `ci` | `escalateCiRedHead`; the post-merge integration result handler | A PR's CI cannot be fixed within its retries, or advisory integration on `dev` fails | `ci:` + the failing check names + the normalized first error line |
| `reviewer` | the reviewer's completion (structured field) | A reviewer finds a defect outside the PR's own scope, or in already-merged work | Anchor on the merged PR, if the reviewer named one |
| `release_health` | `autoFileDegradationTask` | A release degrades | `release:<releaseId>` |
| `post_session` | `apps/web/src/lib/post-session-findings.ts` | A finding's action is to file a task | The finding's `signature` |
| `spec_verdict` | `recordSpecVerdict` | A `fail` verdict lands on a task whose PR already merged | `spec:<specId>:<criterionId>` |
| `owner` | Home "Report a problem", chat (§9) | A person describes a problem | none, or an error line they pasted |

Request-changes review rounds, ordinary CI retries on an open PR, and gate
outcomes `deferred`, `warned` and `bypassed` are normal workflow, not reports.
They never enter intake. Their own ledgers stay the place to read them.

### 3.3 The record

```
incident_reports {
  id                 uuid pk
  workspace_id       uuid  → workspaces
  incident_id        uuid? → failure_incidents   // null while undecided, and for noise
  source             text  // §3.2
  signature          text? // key the source supplied, as given
  fingerprint        text? // toFrictionSignature(normalizeErrorSignature(excerpt), 'report')
  subject_anchor     jsonb? // TaskSubjectAnchor snapshot (extractSubjectAnchor)
  title              text   // ≤ 120 chars
  excerpt            text?  // ≤ 2000 chars, redacted like friction excerpts
  refs               jsonb  // { taskId?, workerId?, prNumber?, headSha?, missionId?, releaseId?,
                            //   paths?: string[≤20], criterion?: { specId, specRevisionId, criterionId } }
  reporter_task_id   uuid?
  reporter_account_id uuid?
  decision           text?  // attach_to | new_pattern | noise | needs_owner
  decided_by         text?  // rule | model | fallback | person | operator
  reason_code        text?  // §4.3
  confidence         numeric(4,3)?
  decision_record_id uuid? → decision_records
  moved_from_incident_id uuid?, moved_at timestamptz?   // set when a later correction moves it
  idempotency_key    text   // source-specific; unique per workspace
  created_at         timestamptz
}
index (workspace_id, signature), (workspace_id, fingerprint), (incident_id, created_at)
unique (workspace_id, idempotency_key)
```

A Sentinel incident writes one `sentinel` report when it opens, carrying its
discriminator as `signature`:

- the friction signature for `repeated_failure`;
- the gate key for `stranded_gate`;
- `pr:<n>` for retry forks;
- the signature itself for the rest.

With that report in place, a later friction report about the same failure
matches it through the same index (§4.1 R1). No second matching path exists
for detector incidents.

### 3.4 Why a new table, and why only this one

The pattern is the incident row. The question is where the individual reports
live.

- **Not another incident table.** The recovery spec (§13) forbids a second
  incident service or table, and with reason. Paging, the gate, recovery, the
  incident page and Home all read `failure_incidents`. A parallel "bugs" table
  would need all of them twice.
- **Not `failure_incidents.affectedRefs` or `impact`.** Both are bounded
  summaries. A report needs its own excerpt, reporter, decision and
  decision-record link, and it must be movable when a decision is corrected.
- **Not task context or the task description.** This is today's friction
  behaviour: append text to the task. It cannot be queried by signature
  across reports, and it is lost when the task closes. A report must also be
  able to exist before any task does, which is the case for noise and for a
  low incident that has no task.
- **Not `task_subject_reports`.** Its `task_id` is required and names the
  canonical task. Here the canonical object is the incident, and many
  incidents have no task.
- **Not `gate_events`.** That is a gate ledger, with `detail` capped and a
  meaning per gate. A report is not a gate outcome.
- **Not `decision_records`.** It records the decision, not the thing decided
  about. It holds one row per decided call, and rule-decided reports often
  have none.

So one narrow table. It is append-only except for the decision fields and
the move fields, and it is the index that reconciliation reads.

---

## 4. Reconciliation: rules first, then a decision kind

### 4.1 Rules (deterministic, in order; the first match decides)

The candidate incidents are the workspace's incidents that are `open` or
`acknowledged`, plus those `resolved` within the last 30 days. A match on a
resolved incident reopens it through `mergeIncident` (a recurrence).

- **R1, exact signature.** Some report already attached to a candidate has
  the same `signature`. Decision `attach_to`, reason `exact_signature`.
- **R2, fingerprint.** Some report already attached to a candidate has the
  same `fingerprint`, and the fingerprint is not one of the generic stems
  (`KNOWN_ERROR_SLUGS` alone, such as a bare `timeout`, never matches on
  fingerprint). Decision `attach_to`, reason `fingerprint`.
- **R3, subject anchor.** The report's anchor is identifying
  (`pr_generation`, or `error` with an exact anchor), and `subjectMatchPredicate`
  matches it against a report already attached to a candidate. Decision
  `attach_to`, reason `subject_anchor`.
- **R4, symptom.** Applies only to `failure_rate_spike` reports. If at least
  60% of the failed tasks in the spike window are subjects of other open
  incidents, the spike attaches to the largest of them. Reason `symptom_of`.
  The spike incident keeps its row, and `trace.owner` points at that
  incident.
- **R5, never merge Sentinel episodes.** A `sentinel` report is always
  `new_pattern` on its own incident. Detector signatures are already the
  pattern key, and rewriting them would break the recovery spec's episodes.
  Reason `detector_signature`.

When two candidates match the same rule, the incident with the newest
`lastSeenAt` wins, and the other is recorded in the decision's
`alternatives`.

### 4.2 The decision kind `buildd.intake_reconcile`

Reports that no rule decides go to one typed kind, defined with
`defineBuilddDecisionKind` in `packages/core/decision-kind-intake-reconcile.ts`
(new) and run with `runBuilddDecision`.

- **Features** (bounded, `featureSchemaVersion` 1):
  - the report: `source`, `title`, an excerpt truncated to 600 chars after
    normalization, the anchor kind, up to 10 `paths`, and whether
    `refs.prNumber` is merged;
  - up to 5 candidates, chosen by `knowledgeStore.nearDupeCheck` over
    incident titles and attached report titles, each with its `rule`, title,
    `lastSeenAt` age bucket, report count bucket, and the refs it shares with
    the report (same PR, same task, same mission, overlapping paths).
  - No raw diffs, no logs. Arithmetic stays in code.
- **Question:** one `choice` over `attach:<k>` for each candidate,
  `new_pattern`, `noise` and `needs_owner`.
- **Output:** `{ decision, targetIncidentId?, confidence, reasonCode }`.
- **Thresholds:**

  | Answer | Applied when confidence is at least | Otherwise |
  |---|---|---|
  | `attach_to` | 0.75 | fallback |
  | `noise` | 0.85 | fallback |
  | `needs_owner` | 0.90, and source in {`reviewer`, `spec_verdict`, `agent_friction`} | fallback |
  | `new_pattern` | any | — |

- **Fallback:** `new_pattern`. It is never `noise` and never `needs_owner`. A
  wrong `new_pattern` costs one extra incident, which the scheduled review
  (§4.5) or a later report can merge. A wrong `noise` loses a bug. A wrong
  `needs_owner` spends the owner's attention.
- **Rollout:** binding mode `live` from day one, with no shadow period.
  `FEATURE_EFFECT` registers capability `intake_reconcile` as `acts`. It is
  not in the owner-switchable set in v1. Rolling back means binding the kind
  in `shadow` mode, so the fallback applies and model answers are recorded
  only.
- **Unavailable model** (no key, timeout, malformed answer): fallback, reason
  `fallback_unavailable`. Intake never waits on a model for more than the
  substrate's deadline.

`needs_owner` exists for one case: a report that may describe intended
behaviour, where only the owner can say whether it is a bug. An owner's own
report can never be `needs_owner`, because the owner already said it is a
problem.

### 4.3 Reason codes (closed set, v1)

Rules: `exact_signature`, `fingerprint`, `subject_anchor`, `symptom_of`,
`detector_signature`.
Model: `model_same_cause`, `model_same_subject`, `model_distinct`,
`model_noise_transient`, `model_noise_expected`, `model_intent_unclear`.
Fallback: `fallback_low_confidence`, `fallback_unavailable`,
`fallback_invalid_features`, `fallback_no_candidates`.
People: `person_moved`, `operator_moved`.

### 4.4 What each decision does

| Decision | Incident effect | Task effect | Who hears |
|---|---|---|---|
| `attach_to` | `lastSeenAt`, refs and a report-count bump; reopens it if resolved | The fix task's context is touched (existing `touch`); no new task | The reporter gets the incident and its fix task (§9) |
| `new_pattern` | `upsertIncident` with rule `reported`, signature `reported\|ws=<id>\|key=<signature ?? fingerprint ?? report:<reportId>>`, and a severity floor by source (§5.1) | The action layer decides on a fix task (§5) | Nobody is paged unless triage says so |
| `noise` | no incident; the report keeps `incident_id = null` | none | nobody |
| `needs_owner` | `upsertIncident` as for `new_pattern`, then `recovery.state = needs_decision` with options "It's a bug, fix it", "Working as intended, close it" and "Not now" | none until answered | The owner, once, through the existing gate |

Noise is not permanent. If three distinct reporters file reports with the
same fingerprint within 7 days, the next report skips the model and becomes
`new_pattern`, reason `fallback_low_confidence`.

### 4.5 Sample capture and the scheduled review

- **Capture.** The kind binds a challenger (`runBuilddChallenger`) at
  fraction 0.1. Capture is forced to 1.0 for model answers within 0.1 above
  their threshold, and for every `noise`. The challenger is a richer model
  from a different vendor family. It runs out of band and never changes the
  applied answer (decision-kinds invariant).
- **Review.** Once per 24 h, the existing sentinel cron's full sweep reads
  the last day of `intake_reconcile` rows. The watermark is kept in
  `system_cache`. The sweep writes one readout artifact covering: rule versus
  model versus fallback share; challenger agreement per answer; outcome-label
  accuracy (§4.6); and the reports it proposes to move. No new cron is added.
- **Proposed moves are applied** only when the challenger and an outcome
  label agree. They are applied as `operator_moved`, with the move fields
  set. Anything else stays a proposal in the readout.
- **Disagreement alarm.** When challenger disagreement on `attach_to` goes
  above 25% over at least 40 sampled rows, one `reportOps` warning goes to
  the platform owner. It is not a Needs You item.

### 4.6 Learning from outcomes

Jev does not train on our data. "Learning" means two concrete things:
outcome labels that drive threshold re-tuning, and confirmed attachments that
turn into rule matches.

**Labels.** These are written with `labelDecisionOutcome`. The `source`
values are new, and the first label from each source stands.

| Source | Written when | Label on the decision that attached or created the report |
|---|---|---|
| `incident_fix_resolved` | The incident reaches `verified` (§5) and no attached report's signature or fingerprint reappears within 14 days | `correct` |
| `report_outlived_fix` | After `verified`, a new report matches (by R1 or R2) a report that was model-attached to this incident. One fix fixed everything but this, so it was a different bug. | `wrong_attach` |
| `incident_merged` | The review or a person merges incident B into A | `missed_attach` for the `new_pattern` that created B |
| `noise_resurfaced` | A `noise` report's fingerprint later lands on an incident above noise | `wrong_noise` |
| `human` | The existing override route moves a report | `person_moved` |

**Re-tuning.** The thresholds in §4.2 are re-tuned only by the existing eval
(`runDecisionEval` even/odd split) on labelled rows. A change is a binding
change with a new `policyVersion`, never an edit in place. Thresholds do not
carry over between models.

**Rules learn by construction.** Once a model-attached report on incident I
is labelled `correct`, its `signature` and `fingerprint` are already in the
index (§3.3). The next report with the same key attaches by R1 or R2 with no
model call. So the model is asked once per new shape of a bug, not once per
report. A report labelled `wrong_attach` is moved off the incident, which
takes its key out of that incident's index.

**Recurrence labels the fix, not the decision.** When an incident recurs
after a released fix and the recurring reports match by rule, the fix was
incomplete. The label goes on the fix (`trace.fixes[n].outcome = recurred`,
§5) and feeds the quality metrics (§7). It does not mark the reconcile
decisions wrong.

---

## 5. Fix-task ownership and the incident lifecycle

### 5.1 Above noise, and who owns it

An incident is **above noise** when either:

- its triage decision (`buildd.failure_incident_triage`) is `systemic_bug` or
  `page_now`; or
- it is a `reported` incident whose floor is medium or higher.

Floors by source:

| Floor | Sources |
|---|---|
| medium | `owner`, `reviewer`, `spec_verdict`, `release_health`, `ci` |
| low, raised to medium at 2 distinct reporting tasks | `agent_friction`, `gate_refusal`, `post_session` |

Severity only rises, as today.

Every incident above noise MUST have exactly one owner within one sweep,
recorded in `trace.owner`:

| Owner kind | When | Example |
|---|---|---|
| `recovery` | A recovery family owns the cause (path overlap today, infrastructure failure under recovery §16) | the path-overlap stall incidents |
| `remedy` | The remedy is an existing person surface: a reconnect, an access grant, a budget change | expired credential → the RECONNECT chip; quota → the budget surface |
| `incident` | R4 made it a symptom of another incident | the failure-rate spike |
| `fix_task` | Otherwise | everything else above noise |
| `person` | Only through `needs_owner` or the recovery spec's `needs_decision` | intended behaviour unclear |

The existing exclusions in `failure-incident-actions.ts` (no task for a
`transient_infra` or `budget_or_quota` cause) stay as they are. They now
resolve to owner `remedy` or `recovery` instead of leaving the incident with
no owner.

### 5.2 One fix task, with a collision check first

At most one non-terminal task carries `context.failureIncidentId` for an
incident. This is the existing `findOpenByIncident` plus the claim key
`failure-incident-fix:<id>`. Before `createDbFixTaskPort.create` runs, the
filer predicts the fix's paths, in this order:

1. the introducing PR's changed files, if attribution is `exact` or `high`
   (§6);
2. `inferFrictionManifest` on the incident's signature and newest excerpt;
3. the union of reports' `refs.paths`;
4. none.

It then checks, in this order, and the first match decides:

| Check | Then |
|---|---|
| The introducing PR is still open | **Attach to the PR.** File nothing. Send the finding to the PR's task as review feedback (the existing reviewer-feedback path), and set `trace.owner` to `{kind: 'fix_task', taskId: <that task>}`. The fix ships in the PR that caused it. |
| The introducing task's mission has an unmerged integration branch | **File in that mission.** Set `missionId` and the mission's branch as base, because the defect is not on trunk yet. |
| An open fix task, or a non-terminal task whose subject anchor names the same PR or error, already exists | **Adopt it.** Set `linkedFixTaskId` to that task and record the adoption in `trace.fixes`. |
| The predicted paths overlap a live path claim or an open PR | **File behind it.** File on trunk with the predicted `pathManifest`. The claim route defers it behind the holder, as for any task. A long wait becomes a `path_overlap_stall` incident with its own recovery. Recovery never orders tasks. |
| None | **File on trunk** with the predicted `pathManifest`, or none. |

The fix task draft is the existing `buildFixTaskDraft`, plus:

- the predicted `pathManifest`;
- `roleSlug` builder;
- a subject anchor `error` on the incident's signature, so a later dedupe
  matches it;
- `context.specSource` when §8 finds a pinned spec;
- a description that requires a failing regression test first, and asks the
  task to report its `verificationCommand`.

**Budget.** Two fix tasks per incident generation. When the second ends
without the incident reaching `released`, the owner becomes `operator`, the
recovery state becomes `needs_operator` with
`capabilityGap = { capability: 'fix_incident', reason }`, and a `reportOps`
warning is sent. A fix that will not land is not the workspace owner's
question.

### 5.3 State machine

`trace.stage` is derived from facts every sweep and cached with its history.
It is never set by hand.

```
                      noise ◄────────── (reconcile: noise / triage: known_noise)
                        │ 3 reporters in 7 days
                        ▼
  report/detector ──► open ──(owner assigned within 1 sweep)──► owned
                        ▲                                        │ fix worker started
                        │ fix task failed/cancelled              ▼
                        │ (budget left)                       fixing
                        │                                        │ fix PR opened
                        │                                        ▼
                        ├──────────── PR closed unmerged ────── pr
                        │                                        │ fix PR merged AND shipped (§5.3 note)
                        │                                        ▼
       recurred ◄───────┼──────── new occurrence ──────────── released
          │             │                                        │ resolve check passes (§5.5)
          │             │                                        ▼
          └─► open (generation+1, prior fix kept)            verified  ═ status resolved
                                                                 │ new occurrence (≤ 30 d window)
                                                                 └──► recurred
  owner = recovery | remedy | incident | person: open ──► owned ──► verified when the check passes (no fix stages)
```

| `trace.stage` | Fact it is derived from | `failure_incidents.status` | `recovery.state` (recovery spec) |
|---|---|---|---|
| `open` | above noise, no owner yet | `open` | `observing` |
| `owned` | an owner is set; the fix task (if any) is pending | `open` | `waiting` or `recovering` |
| `fixing` | the fix task has a running worker | `open` | `recovering`, delegated |
| `pr` | the fix worker has an open PR | `open` | `recovering`, delegated |
| `released` | the fix PR merged and shipped | `open` | `waiting` on the check |
| `verified` | the resolve check passed on evidence after `released` | `resolved` | `recovered` |
| `recurred` | a new occurrence after `released` or `verified` | `open` (reopened, generation +1) | re-assessed |
| `noise` | reconcile `noise` or triage `known_noise` | `acknowledged` | `observing` |

**"Shipped" depends on how the workspace releases:**

- A workspace with a release ledger: the fix task is in `release_tasks` for a
  release whose `state` is `healthy`.
- A no-release workspace: the PR merged to the default branch.
- A fix on a mission branch: `loadMissionProductionStatus` reports
  `in_production`.

**Rules:**

- Merging to a mission branch alone is still `pr`.
- `trace.stage` never triggers a page. Paging stays with the recovery
  assessment and the gate.

### 5.4 What the sweep reconciles each run

This runs inside the existing backstop (`assessDueIncidents` in
`runFailurePatternSweep`). There is no new cron. For each incident that is
not resolved and was touched in the last 30 days:

1. **Undecided reports.** Re-run intake reconciliation for reports with
   `decision = null` that are older than 5 minutes.
2. **Stage.** Derive the stage from the fix task, its worker's PR columns,
   `release_tasks` and `releases`. If it changed, one CAS appends
   `{stage, at, fixTaskId}` to `trace.stages` (bounded to 30).
3. **Owner.** If the incident is above noise and `trace.owner` is unset,
   assign one (§5.1, §5.2).
4. **Failed fix.** If the fix task ended `failed` or `cancelled` with no
   merged PR: close its `trace.fixes` entry as `failed`, clear
   `linkedFixTaskId`, and go back to step 3 within the budget (§5.2).
5. **Released.** Run the family check (§5.5) on observations taken after the
   release time. A pass resolves the incident through the recovery spec's
   single CAS (status `resolved`, `recovery.state = recovered`,
   `trace.stage = verified`).
6. **Recurrence.** An occurrence or a rule-matched report after `released`
   reopens the incident (`mergeIncident`) and marks the last fix
   `recurred`. The next fix task's description names the previous fix PR and
   says it did not hold.
7. **Noise re-check.** Apply the three-reporter rule from §4.4.

Each step is idempotent per (incident, generation, step). It reuses the
recovery spec's lease and action keys, with step names as actions.

### 5.5 Resolve checks for every rule

The recovery spec requires each family's check to be decidable from facts,
and never "no new occurrence lately". Here are the checks for the families
that have none yet. **Opportunities** means events that could have produced
the failure, counted after the release time. A check without enough
opportunities is `inconclusive`, and inconclusive never resolves.

| Rule | Check passes when |
|---|---|
| `path_overlap_stall` | Unchanged (recovery spec §7). |
| `retry_fork` | The PR has at most one non-terminal retry child per (kind, stage, iteration), and its newest iteration is not forked. |
| `lineage_multi_pr` | The lineage has at most one open PR. |
| `stranded_gate` | No task is currently stranded at that gate and reason. |
| `repeated_failure` | At least 20 worker runs of the affected backend and role completed since release with no failure matching the signature. |
| `failure_rate_spike` | The failure rate over the last 2 hours with at least 20 terminal tasks is under 2× the baseline. |
| `provider_attribution_mismatch` | The last 20 runs that charged a provider ran on the provider they were charged to. |
| `output_unmet_boundary` | At least 10 completions crossed that boundary since release with no unmet-output rejection. |
| `reported` | The fix task's reported `verificationCommand` (or the regression test named in its PR) passes on the released head, **and**, where the signature is a gate or worker-failure key, the opportunity check for that key passes. An owner report with no key resolves on the test alone. |

Under these checks, the stale retry-fork and lineage incidents in §2 item 5
resolve on the next sweep after this lands, and the stranded-gate incidents
resolve once nothing is stranded.

---

## 6. Traceability: which change introduced it

### 6.1 Methods, in order of strength

`trace.introducedBy` is written once the evidence exists, and rewritten only
by a stronger method:

| Method | Evidence | Confidence |
|---|---|---|
| `revert` | A `pr_reverts` row reverts PR X, and the incident's reports stop after the revert or name X | `exact` |
| `anchor_pr` | A report's binding anchor names a merged PR. This includes reviewer and spec-verdict reports on merged work. | `exact` |
| `fix_overlap` | The fix PR's changed files intersect exactly one task's PR in the suspect window (below) | `high`; `medium` when 2–3 tasks intersect |
| `release_window` | Occurrences start after release R became healthy, none matched in the 14 days before R, and R's `release_tasks` touch the predicted paths | `medium` with one candidate; `low` with more |
| `none` | Nothing above applies | `none` |

The **suspect window** is the release, or for no-release workspaces the
merges to the default branch, between the last time the check would have
passed and the first occurrence. It is computed from `release_tasks` and
`releases`, or from workers' `mergedAt` when there is no ledger.
`attributeRelease` is not re-run. Attribution only reads its rows.

Candidates are kept in `trace.introducedBy.candidates`, up to 5, each with
its task, PR, mission and release. The chosen one is set only at `medium` or
above.

### 6.2 What is recorded

```
introducedBy: {
  kind: 'change' | 'infrastructure' | 'pre_existing' | 'unknown',
  method: 'revert' | 'anchor_pr' | 'fix_overlap' | 'release_window' | 'none',
  confidence: 'exact' | 'high' | 'medium' | 'low' | 'none',
  taskId?, prNumber?, missionId?, releaseId?, roleSlug?, modelTier?, model?,
  candidates?: Array<{ taskId, prNumber, missionId?, releaseId? }>,   // ≤ 5
  escaped: boolean | null,      // the introducing change reached a healthy release before detection
  decidedAt: string,
}
```

`roleSlug`, `modelTier` and `model` are copied from the introducing task and
its `task_outcomes` row at attribution time. Metrics then never join through
a task that may since have changed.

### 6.3 No clear introducing change

- **`infrastructure`.** The cause is Buildd's own environment or a credential:
  recovery `cause.ownership = infrastructure`, triage cause
  `transient_infra`, or the owner is `remedy`. Confidence is `exact` when the
  cause is typed (a credential expiry, a typed capture failure), `low` when
  inferred.
- **`pre_existing`.** A matching occurrence or report exists from before the
  oldest release in the 30-day lookback, or the regression test written by
  the fix fails on a head older than every candidate.
- **`unknown`.** Everything else. This is a valid end state, not an error.

Only `kind = change` at `exact` or `high` counts toward a task's, role's,
tier's or mission's defect rate. `medium` and `low` appear only as "possible"
in the readout. They are never summed into a rate.

---

## 7. Quality metrics

### 7.1 Definitions

All of these are computed in one module,
`apps/web/src/lib/quality-metrics.ts` (new), over a window of 7, 30 or 90
days.

- **Shipped task.** A task whose PR merged in the window, or, for the release
  views, one in `release_tasks` for a healthy release.
- **Attributed defect.** An incident above noise with `introducedBy.kind =
  change` and confidence `exact` or `high`.
- **Defect rate.** Attributed defects introduced by shipped tasks in the
  group, divided by shipped tasks in the group. Groups: task kind ×
  complexity, `roleSlug`, model tier, model, and mission. Only tasks shipped
  at least 14 days before the end of the window count, so recent work is not
  scored before its defects could surface.
- **Escape rate.** Attributed defects with `escaped = true`, divided by all
  attributed defects.
- **Time to resolve.** From the incident's first occurrence (or the episode
  start, for recovery families) to `verified`, as p50 and p90. It is split by
  stage from `trace.stages`: to owned, owned to PR, PR to released, and
  released to verified.
- **Recurrence rate.** Incidents whose last fix ended `recurred`, divided by
  incidents with a released fix.
- **Reconcile health.** Rule, model and fallback share; challenger
  agreement; outcome-label accuracy (§4.5).

### 7.2 Where each is read

| Metric | MCP | Health (workspace) | Platform-owner API |
|---|---|---|---|
| Defect rate by role, tier, mission, kind × complexity | `buildd_analytics` action quality_stats (new, NOT IMPLEMENTED) | "Quality" section on `/app/health/insights` | Cross-team rollup by role and tier |
| Escape rate | quality_stats | Quality section | rollup |
| Time to resolve, by stage | quality_stats | Quality section | rollup |
| Recurrence rate | quality_stats | Quality section | rollup |
| Reconcile health | `get_decision_stats` (existing, capability `intake_reconcile`) | — | the daily readout artifact (§4.5) |

Everything is computed on read from `failure_incidents`, `incident_reports`,
`tasks`, `task_outcomes`, `release_tasks` and `releases`. A 10-minute
`system_cache` entry is allowed. There is no materialized metrics table and
no new cron. Each group carries `n`. Below 30 shipped tasks, a rate reads
"not enough work to say", not a number.

### 7.3 Feeding routing without favouring cheap work

Raw defect rate favours whatever does the easiest work. A small tier given
only copy edits will look safest. The rules:

- **Stratify.** Tiers and models are compared only within the same task kind ×
  complexity cell (the `task_outcomes` keys). A cross-cell average is never
  used for a routing choice.
- **Late grade, not a new loop.** A coding run with an attributed defect is
  graded on a fourth model-policy-cell signal, "no attributed defect".
  `merged` alone would miss defects that only show up after merge. The signal
  is graded only once the run is 14 days past merge. It joins the cell's
  existing threshold arithmetic, so the dial, tolerance and revert rules are
  unchanged. A run with an `infrastructure`, `pre_existing` or `unknown`
  incident is not graded on it.
- **Experiments.** `computeExperimentReadout`'s `classifyRow` treats a row
  with an attributed defect as `unclean`, and a row younger than 14 days past
  merge as `pending` for this signal.
- **No automatic routing change from this module.** It produces readouts.
  Only the policy-cell dial, with its own sample-size floor and recorded
  revert, moves traffic.

---

## 8. Living Specs

### 8.1 The mapping rule

When an incident gets an introducing task (`exact` or `high`) or a fix task,
the sweep looks for a governing spec, in this order:

1. **A pinned Living Spec.** The introducing task carries
   `context.specSource.specId` with an approved revision. The criteria are
   that revision's `specCriteria`.
2. **A repo spec.** A `docs/specs/*.md` file whose frontmatter `surfaces`, or
   whose code-surface paths, intersect the fix's predicted or actual changed
   paths.
3. **None.**

The criterion itself is never guessed by a model. It is named by:

- a `spec_verdict` report, which already carries one;
- the fix task's completion: the fix task is filed pinned to the same spec
  (via `pinSpecSource`) and its description asks it to name the violated
  `R-n` or `AC-n` in its structured output.

### 8.2 What it becomes

| Case | Record |
|---|---|
| Pinned Living Spec, criterion named | A `fail` verdict through `recordSpecVerdict` on the **introducing** task, at its merged head, with evidence `[{kind: 'incident', ref: <id>}]`. Its governed outcome then reads fail. This verdict is written server-side by the sweep (recorder `system`); a task still never grades itself. |
| Pinned Living Spec, no criterion fits | A `conflict`-style discrepancy is **not** created. `trace.specs.coverage = 'gap'` is set, and the readout lists it as "spec does not cover this". |
| Repo spec, criterion named | A `spec_discrepancies` row: direction `contradicted`, `spec_path` the file, `assertion_id` `incident:<incidentId>:<criterion>`, `evidence` the incident link. The existing discrepancy flow (accept or doc-fix task) handles it. |
| Repo spec, no criterion fits | `coverage = 'gap'`, as above. |
| No spec | `coverage = 'none'`. No task and no Needs You. It is counted in the Quality readout as "incidents in areas with no spec". |

The fix task's reviewer already records verdicts against its pin. That
remains the only path to a pass, which needs a passing verdict on the fix
head (living-specs §7).

---

## 9. The owner's surface

### 9.1 Filing

- **Home.** A "Report a problem" composer: one text box, an optional link or
  screenshot, and the workspace. It posts to the intake route (proposed: POST
  /api/intake, NOT IMPLEMENTED), which calls `intakeReport` with source
  `owner`.
- **Chat.** When `buildd.chat_routing` returns intent `act` and the turn
  describes something broken, the chat preview card is the same report
  (`apps/web/src/lib/chat/previews.ts`), not a `createTask` preview. Confirming
  it posts the same route. Chat's in-process API keeps forcing
  `creationSource: 'dashboard'`.
- Both paths go through reconciliation like any other source. There is no
  owner-only fast path, except that an owner report cannot be `noise` from
  the model alone and cannot be `needs_owner` (§4.2). A model `noise` answer
  on an owner report falls back to `new_pattern`.

### 9.2 What the owner sees

There is one reply line, and no question:

- attached: "Added to a known problem: *<incident title>*. 4 reports. Fix in
  PR #N, checks again after it ships."
- new, fix filed: "Recorded as a new problem. Buildd filed a fix task."
- new, owned by a remedy: "This needs a reconnect. It's on Home under
  Reconnect."
- recurred: "This came back after the fix in PR #N. Buildd filed a second
  fix."

Each reply has one link to the incident page, plus one secondary action,
"Not the same problem". That action moves the report to a new incident as
`person_moved` and labels the decision (§4.6). There is no "fix it now"
button: priority comes from severity.

### 9.3 Needs You stays small

Exactly two things from this spec can reach Needs You. Both go through the
existing gate and the recovery spec's `needs_decision` state, once per
generation:

1. `needs_owner` (§4.4): "is this intended?"
2. Nothing else new. Every other end state (fix budget spent, inconclusive
   check, attribution unknown, spec gap) is owned by Buildd or the operator,
   and appears only in readouts.

Remedies that already have their own chip (RECONNECT, ACCESS, budget) keep
that chip. An incident does not add a second card for them.

---

## 10. Data model (one place)

- **New table `incident_reports`** (§3.3). It is the only new table. One
  migration.
- **New nullable jsonb `failure_incidents.trace`**, written only through the
  incident CAS (a new `trace` member of the store's state actions). Same
  migration. NULL reads as "no trace yet".

```
trace: {
  v: 1,
  origin: 'detector' | 'report',
  stage: 'open' | 'owned' | 'fixing' | 'pr' | 'released' | 'verified' | 'recurred' | 'noise',
  stages: Array<{ stage, at, fixTaskId? }>,                  // ≤ 30, append-only
  owner: { kind: 'fix_task' | 'recovery' | 'remedy' | 'incident' | 'operator' | 'person', ref?: string } | null,
  fixes: Array<{ taskId, prNumber?, mergedAt?, releaseId?, releasedAt?,
                 outcome: 'open' | 'resolved' | 'recurred' | 'failed', generation }>,   // ≤ 5
  introducedBy: { … §6.2 } | null,
  specs: { coverage: 'pinned' | 'repo' | 'gap' | 'none', specId?, specRevisionId?, specPath?,
           criterionId?, verdictId?, discrepancyId? } | null,
  reportCount: number,          // cached COUNT of attached reports, for list views
}
```

- **Type changes.**
  - `FailureIncidentRule` gains `reported`.
  - `packages/shared/src/types.ts` gains the report and trace types.
  - The detector version does not change, because no detector signature
    changes.
- **Why `trace` is not inside `recovery`.** The recovery assessment is
  rewritten every assessment and versioned by generation. The trace has to
  last across generations: fix history, attribution, stage durations. The
  recovery spec's argument for a column applies here too, because stage and
  status must change in one CAS.
- **Why the stage is cached even though it is derived.** Metrics need the
  time each stage started. Re-deriving the times later from mutable task and
  worker rows would be wrong once a task is retried.

---

## 11. Invariants

- I-1. Every row in `incident_reports` has `decision` set, or is younger than
  one sweep plus 5 minutes.
- I-2. A report has `incident_id = null` only when its decision is `noise`
  or null.
- I-3. At most one non-terminal task carries `context.failureIncidentId = X`
  for any incident X.
- I-4. A `sentinel` report never attaches to an incident other than the one
  that wrote it.
- I-5. A model answer below its threshold is never applied. The fallback is
  never `noise` or `needs_owner`.
- I-6. `trace.stage = verified` if and only if `status = resolved` with a
  passing check recorded after `released`, for incidents with a fix task.
- I-7. No metric rate includes an attribution below `high`, or of a kind
  other than `change`.
- I-8. Intake never blocks or fails the caller's request. Task creation, gate
  responses, CI handling and reviewer completion behave the same when intake
  errors.
- I-9. Nothing in this spec writes `tasks.status`, `path_claims`,
  `workflow_deliveries` or the dispatch outbox except through their existing
  writers.

---

## 12. Requirements and acceptance criteria

### Requirements

- R-1: All report sources in §3.2 MUST write through one intake function, and a repeat call with the same idempotency key MUST NOT create a second report.
- R-2: Reconciliation MUST apply the rules in §4.1 before any model call, and MUST NOT call a model for a report a rule decided.
- R-3: The `buildd.intake_reconcile` kind MUST run live from its first deploy, apply only answers at or above their threshold, and fall back to `new_pattern`.
- R-4: Every model-decided reconcile MUST be recorded in `decision_records`, and sampled rows MUST carry a challenger answer.
- R-5: Outcome labels in §4.6 MUST be written by the sweep without a person.
- R-6: Every incident above noise MUST have `trace.owner` set within one sweep, and at most one live fix task.
- R-7: Before filing a fix task, the filer MUST run the §5.2 collision check and record which branch of it decided.
- R-8: Each Sentinel rule and `reported` MUST have a resolve check from §5.5, and no check MAY pass on the absence of occurrences without counted opportunities.
- R-9: Each attributed incident MUST record method and confidence, and an incident with no clear introducing change MUST say `infrastructure`, `pre_existing` or `unknown`.
- R-10: Quality metrics MUST be computed in one module, read by MCP, Health and the platform-owner API, and stratified by kind × complexity before any tier comparison.
- R-11: An incident attributed to a task pinned to an approved Living Spec, with a named criterion, MUST produce a `fail` verdict on that task.
- R-12: Owner reports from Home and chat MUST go through the same intake and reconciliation, and MUST NOT produce a Needs You item.
- R-13: Only `needs_owner` and the recovery spec's `needs_decision` MAY reach Needs You from this capability.

### Acceptance criteria

- AC-1: GIVEN an open friction-born incident with a report of signature S WHEN an agent files `[friction]` with `frictionSignature` S THEN no task is created, one report is attached with reason `exact_signature`, and the response names the incident and its fix task, if any.
- AC-2: GIVEN two error texts that differ only in an id, a quoted branch name or a trailing "[work preserved: …]" note WHEN both are reported THEN they share one incident through reason `fingerprint`.
- AC-3: GIVEN the same intake call replayed with the same idempotency key WHEN it runs twice THEN exactly one report row exists.
- AC-4: GIVEN a report no rule matches and a model answer of `attach_to` at confidence 0.6 WHEN reconciled THEN the decision is `new_pattern` with reason `fallback_low_confidence`, and a `decision_records` row stores the model's verdict.
- AC-5: GIVEN no decision key is configured WHEN a report needs the model THEN it is `new_pattern` with reason `fallback_unavailable`, and the caller's request succeeds.
- AC-6: GIVEN a model answer of `noise` at 0.95 on an `owner` report WHEN reconciled THEN the applied decision is `new_pattern`.
- AC-7: GIVEN a `needs_owner` answer at 0.95 on an `agent_friction` report WHEN reconciled THEN one incident exists with `recovery.state = needs_decision`, and Home shows one card for it.
- AC-8: GIVEN a new Sentinel `path_overlap_stall` incident for blocker PR B and an open one for blocker PR A WHEN the sentinel report is reconciled THEN it stays on its own incident with reason `detector_signature`.
- AC-9: GIVEN a `failure_rate_spike` whose failed tasks are 70% subjects of one open `repeated_failure` incident WHEN reconciled THEN the spike's `trace.owner` is that incident, and no fix task is filed for the spike.
- AC-10: GIVEN a high incident with no fix task and no recovery family WHEN one sweep runs THEN exactly one fix task carries its id, and a concurrent second sweep files none.
- AC-11: GIVEN an incident whose introducing PR is still open WHEN its fix owner is decided THEN no task is filed, and the finding reaches that PR's task as review feedback.
- AC-12: GIVEN an incident attributed to a task in a mission with an unmerged integration branch WHEN a fix task is filed THEN it carries that `missionId` and the mission branch as its base.
- AC-13: GIVEN a fix task that fails twice in one generation WHEN the sweep runs THEN no third fix task is filed, the recovery state is `needs_operator`, and no Needs You item exists.
- AC-14: GIVEN a fix PR merged to a buildd-style gated workspace whose release has not yet become healthy WHEN the sweep runs THEN `trace.stage` is `pr`, not `released`.
- AC-15: GIVEN a `retry_fork` incident whose PR now has one non-terminal retry child per stage WHEN the sweep runs THEN it is resolved with `trace.stage = verified`.
- AC-16: GIVEN a `repeated_failure` incident with a released fix and only 5 runs of the affected backend since release WHEN checked THEN it stays open as `inconclusive`.
- AC-17: GIVEN a `verified` incident WHEN a report matches it by rule 10 days later THEN it reopens with `recurrenceCount + 1`, its last fix reads `recurred`, and the next fix task names the earlier fix PR.
- AC-18: GIVEN a model-attached report labelled `correct` WHEN a later report carries the same fingerprint THEN it attaches by rule, and no model call is made.
- AC-19: GIVEN a `pr_reverts` row that reverts PR X and incident reports that stop after the revert WHEN attributed THEN `introducedBy` names X's task, with method `revert` and confidence `exact`.
- AC-20: GIVEN an incident whose cause is a typed credential expiry WHEN attributed THEN `introducedBy.kind = infrastructure`, and it adds nothing to any defect rate.
- AC-21: GIVEN 10 shipped tasks for a role in a window WHEN quality metrics are read THEN the role's defect rate reads "not enough work to say".
- AC-22: GIVEN a tier with fewer defects than another but only in a different kind × complexity cell WHEN compared THEN no comparison is produced between them.
- AC-23: GIVEN an incident attributed (`exact`) to a task pinned to an approved Living Spec, and a fix that names AC-3 of that spec WHEN the sweep maps it THEN a `fail` verdict for AC-3 exists on the introducing task's merged head.
- AC-24: GIVEN an incident in an area no spec covers WHEN mapped THEN `trace.specs.coverage = 'none'`, and no task or Needs You item is created.
- AC-25: GIVEN an owner report from Home that attaches to an incident with an open fix PR WHEN it returns THEN the reply names the incident and the PR, and the badge count is unchanged.
- AC-26: GIVEN intake throws during reconciliation WHEN an agent files `[friction]` THEN the request still answers 200, the report exists with `decision = null`, and the next sweep decides it.

---

## 13. Rejected alternatives

- **Just stricter dedupe.** The exact-key dedupe is already correct (task
  `58e4c841` established this). The misses are the same bug described in
  different words. Fixing that by loosening the key either:
  - keeps missing (exact), or
  - merges distinct bugs (fuzzy). A wrong merge hides a bug behind another's
    fix, which is worse than a duplicate.

  Dedupe also stops at the filing. It does not give an owner, close the loop
  after release, or record who introduced the defect. Normalization does stay
  as R2.
- **Just more Sentinel rules.** Rules need structured facts. Owner, reviewer
  and spec reports are prose. A rule per observed cluster is whack-a-mole, and
  §2 item 8 is the history of exactly that. Rules also do not give ownership,
  attribution or metrics. They stay the first layer for detector facts.
- **A separate bugs table and service.** It would duplicate paging, the gate,
  recovery, the incident page and Home. The recovery spec forbids it (§13).
- **Model-first reconciliation.** It costs money on every report, and makes
  the obvious cases nondeterministic. Rules decide most reports for free, and
  the model only sees what they cannot.
- **A shadow period before the kind applies.** The task rules it out, and the
  fallback makes it safe to skip. A low-confidence or absent answer reproduces
  today's behaviour (a new pattern) exactly.
- **Reports stored on the fix task.** Many incidents have no task, and some
  never should. The pattern outlives any one fix task across recurrences.
- **A stored, hand-set lifecycle status.** It would drift from the task, PR
  and release facts it summarises. The stage is derived every sweep. Only
  its start times are cached.
- **Routing tiers directly on defect rate.** That rewards models that get
  easy work. Routing changes stay with the policy-cell dial, which stratifies,
  has a sample floor and reverts itself.
- **Attribution by blame on lines.** It is costly through the GitHub API and
  unreliable after squash merges. Changed-file overlap with the fix, plus
  reverts and anchors, gives a recorded confidence at much lower cost.

---

## 14. Rollout: build slices

One build task per slice, filed after this spec merges. Each slice's
pathManifest is listed. Files marked (new) do not exist yet. All slices also
depend on mission `ecea17f3` having landed on `dev`, since S4 and S5 edit
files it creates.

**S1. Data model and intake core (§3, §10).**
pathManifest: `packages/core/db/schema.ts`, `packages/core/drizzle/` (one
migration; check the next free index against `origin/dev` first),
`packages/shared/src/types.ts`, `apps/web/src/lib/incident-intake.ts` (new),
`apps/web/src/lib/incident-intake.test.ts` (new),
`apps/web/src/lib/failure-incident-store.ts`,
`apps/web/src/lib/failure-incident-store.test.ts`.
Covers R-1, AC-3, AC-26.

**S2. Reconciliation rules and decision kind (§4.1–§4.4).**
pathManifest: `packages/core/decision-kind-intake-reconcile.ts` (new),
`packages/core/__tests__/decision-kind-intake-reconcile.test.ts` (new),
`apps/web/src/lib/incident-intake-reconcile.ts` (new),
`apps/web/src/lib/incident-intake-reconcile.test.ts` (new),
`packages/core/decision-feature-modes.ts`.
Covers R-2, R-3, R-4, AC-2, AC-4–AC-9.

**S3. Wire the sources (§3.2).**
pathManifest: `apps/web/src/app/api/tasks/route.ts`,
`apps/web/src/app/api/tasks/route.test.ts`, `packages/core/mcp-tools.ts`
(the `create_task` reply), `apps/web/src/lib/release-health-watcher.ts`,
`apps/web/src/lib/ci-failure-retry.ts`,
`apps/web/src/lib/post-session-findings.ts`,
`apps/web/src/lib/failure-pattern-sweep.ts` (the sentinel report),
`apps/web/src/lib/specs/outcome.ts` (the `spec_verdict` source),
`.claude/skills/buildd-mcp-consumer/SKILL.md`, `CLAUDE.md` (Issues &
Friction).
Covers AC-1.

**S4. Ownership, collision check and stage sweep (§5).**
pathManifest: `apps/web/src/lib/failure-incident-actions.ts`,
`apps/web/src/lib/failure-incident-actions.test.ts`,
`apps/web/src/lib/failure-incident-fix-stage.ts` (new),
`apps/web/src/lib/failure-incident-fix-stage.test.ts` (new),
`apps/web/src/lib/failure-pattern-sweep.ts`,
`apps/web/src/lib/failure-incident-recovery.ts`,
`apps/web/src/lib/failure-incident-checks.ts` (new, the §5.5 table),
`apps/web/src/lib/failure-incident-checks.test.ts` (new).
Covers R-6, R-7, R-8, AC-10–AC-17.

**S5. Attribution (§6).**
pathManifest: `apps/web/src/lib/incident-attribution.ts` (new),
`apps/web/src/lib/incident-attribution.test.ts` (new),
`apps/web/src/lib/failure-pattern-subscribers.ts` (a `pr.closed`
re-attribution hook).
Covers R-9, AC-19, AC-20.

**S6. Outcome labels and the daily review (§4.5, §4.6).**
pathManifest: `apps/web/src/lib/intake-reconcile-outcomes.ts` (new),
`apps/web/src/lib/intake-reconcile-outcomes.test.ts` (new),
`apps/web/src/lib/failure-pattern-sweep.ts`.
Covers R-5, AC-18.

**S7. Quality metrics and routing feed (§7).**
pathManifest: `apps/web/src/lib/quality-metrics.ts` (new),
`apps/web/src/lib/quality-metrics.test.ts` (new),
`packages/core/mcp-tools.ts`,
`apps/web/src/app/app/(protected)/health/insights/page.tsx`,
`packages/core/experiment-readout.ts`.
The policy-cell signal goes in a follow-on task, with the model-policy-cells
spec updated in the same PR.
Covers R-10, AC-21, AC-22.

**S8. Living Spec mapping (§8).**
pathManifest: `apps/web/src/lib/incident-spec-mapping.ts` (new),
`apps/web/src/lib/incident-spec-mapping.test.ts` (new),
`apps/web/src/lib/specs/outcome.ts`.
Covers R-11, AC-23, AC-24.

**S9. Owner surface (§9).**
pathManifest: the intake route (new, at apps/web/src/app/api/intake/route.ts)
with a co-located route test, `apps/web/src/lib/chat/previews.ts`,
`apps/web/src/app/app/(protected)/home/` (the composer),
`apps/web/src/lib/incident-view.ts`.
Proof: phone and desktop screenshots through `visual-qa.yml`.
Covers R-12, R-13, AC-25.

```
S1 ──► S2 ──► S3
 │      └───► S6
 ├──► S4 ──► S5 ──► S7
 │            └───► S8
 └──► S9 (after S2)
```

S3 and S4 both edit `failure-pattern-sweep.ts`, and S6 does too. They MUST
NOT run in parallel. Path claims will serialize them.

---

## 15. Code surface (existing)

- `apps/web/src/lib/failure-incident-store.ts`: `upsertIncident`, `mergeIncident`, `updateIncidentState`
- `apps/web/src/lib/failure-incident-actions.ts`: `actOnIncidentResults`, `buildFixTaskDraft`, `createDbFixTaskPort`, `RAISE_MIN_CONFIDENCE`, `FIX_TASK_MIN_CONFIDENCE`
- `apps/web/src/lib/failure-pattern-sweep.ts`: `runFailurePatternSweep`
- `apps/web/src/lib/failure-pattern-sentinel.ts`: `detectFailurePatterns`
- `apps/web/src/lib/failure-incident-escalation.ts`: `createGatedIncidentSender`
- `packages/core/decision-kind-failure-incident-triage.ts`
- `packages/core/decision-kinds.ts`: `defineBuilddDecisionKind`
- `packages/core/decision-policy.ts`: `runBuilddDecision`, `runBuilddChallenger`
- `packages/core/decision-outcomes.ts`: `labelDecisionOutcome`
- `packages/core/decision-feature-modes.ts`: `FEATURE_EFFECT`
- `packages/core/failure-friction-signature.ts`: `toFrictionSignature`
- `packages/core/gate-friction-signature.ts`: `gateFrictionSignature`
- `apps/web/src/lib/error-signature.ts`: `normalizeErrorSignature`
- `packages/core/subject-anchor-extractor.ts`: `extractSubjectAnchor`
- `packages/core/subject-anchor-observe.ts`: `subjectMatchPredicate`
- `packages/core/friction-manifest.ts`: `inferFrictionManifest`
- `packages/core/release-attribution.ts`: `attributeRelease`
- `apps/web/src/lib/release-health-watcher.ts`: `autoFileDegradationTask`
- `apps/web/src/lib/mission-production-status.ts`: `loadMissionProductionStatus`
- `packages/core/pr-reverts.ts`: `parseRevertReferences`
- `apps/web/src/lib/ci-failure-retry.ts`: `escalateCiRedHead`
- `packages/core/routing-analytics.ts`: `recordTaskOutcome`
- `packages/core/experiment-readout.ts`: `computeExperimentReadout`, `classifyRow`
- `apps/web/src/lib/specs/outcome.ts`: `recordSpecVerdict`, `recordSpecConflict`
- `packages/spec-contract/src/requirements.ts`: `specCriteria`
- `apps/web/src/lib/specs/pin.ts`: `pinSpecSource`
- `apps/web/src/app/api/tasks/route.ts`: the `[friction]` dedupe branch
- `apps/web/src/app/api/health/incidents/route.ts`: the incident list
- `packages/core/db/schema.ts`: `failureIncidents`, `decisionRecords`, `gateEvents`, `releases`, `releaseTasks`, `specDiscrepancies`

## 16. Out of scope

- Recovery repair policies for families other than path overlap and
  infrastructure. This spec adds resolve checks only.
- `trunk_incidents` and the kernel's trunk repair.
- Changing who may merge, or any rule of the PR escalation gate.
- Per-workspace tuning of the thresholds and windows here.
- Automatic routing or tier changes from quality metrics (§7.3).
- Filing tasks for spec gaps (§8.2). They are counted, not acted on.
