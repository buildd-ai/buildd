# Task Subject Anchors and Liveness

**Status:** Accepted (§6 partially implemented — see Implementation status)
**Related:** `docs/design/loop-until-verified.md`,
`docs/design/friction-dedup-serialization.md`,
`docs/design/merge-policy.md`, `packages/core/db/schema.ts`,
`apps/web/src/app/api/tasks/route.ts`,
`apps/web/src/app/api/github/webhook/route.ts`,
`apps/web/src/lib/health-watcher.ts`, `apps/web/src/lib/ci-retry.ts`,
`apps/runner/src/error-trace-scanner.ts`,
`apps/web/src/app/api/workers/claim/route.ts`,
`apps/web/src/app/api/workers/claim/held-gate.ts`,
`apps/web/src/app/api/workers/claim/deps-gate.ts`,
`apps/web/src/app/api/workers/claim/pacing-gate.ts`,
`apps/web/src/lib/merge-policy.ts`

## Problem

A task can describe a pull request, failing commit, branch, or recurring error
without the system knowing what the task is *about*. A full GitHub pull-request
URL in human-authored prose is currently just text. System filers use several
incompatible context keys (`pr`, `prNumber`, `headSha`,
`frictionSignature`), while CI retries additionally have dedicated
`ciRetryPrNumber` and `ciRetryHeadSha` columns. Consequently:

- a human can file work for a PR while its webhook retry is already running;
- an organizer, watcher, webhook, or agent can file the same work again;
- retry ancestry is invisible to intake checks that inspect only active
  children;
- a task can remain claimable after its PR closes or its replacement merges;
- two workers can branch from `dev` and produce mutually unmergeable PRs for
  the same change; and
- reconciliation cannot safely distinguish a redundant task from intentional
  follow-up work.

The existing CI-retry guard solves one narrow case correctly. The webhook
inserts `(workspace_id, ci_retry_pr_number, ci_retry_head_sha)` under a partial
unique index, so duplicate deliveries cannot create two retries for one failed
head. `health-watcher.ts`, however, uses a separate
`pr-<number>-<headSha>` event key, and general `POST /api/tasks` intake does not
consult either identity. The result is several local dedupe mechanisms without
a shared subject model.

## Current state

- `tasks.context` carries loosely named PR, branch, failure, and retry fields.
  `tasks.parentTaskId` links only an immediate retry parent.
- `tasks.ciRetryPrNumber` and `tasks.ciRetryHeadSha` exist solely for the
  webhook retry uniqueness constraint.
- `POST /api/tasks` deduplicates friction reports by
  `(workspaceId, context.frictionSignature)` and infers a `pathManifest`, but
  other origins do not share that gate.
- `error-trace-scanner.ts` defines stable, high-signal slugs such as
  `bwrap_namespace_denied` and `sandbox_mount_gap`. Those slugs are the
  canonical error identities; titles and excerpts are not.
- The claim route's SQL eligibility gates currently apply pending/start-time,
  active-worker, held-mission, dependency, workspace-concurrency, and cooldown
  checks. In-loop gates then apply path overlap, mission budget, mission
  concurrency, pacing, routing, and account budget.
- Pull-request webhooks stamp worker `prLifecycleStatus`; merged PRs also stamp
  `mergedAt`. A closed unmerged dependency no longer blocks forever, but tasks
  whose *own subject* is closed remain eligible.
- `resolvePolicy()` governs merge authority. Subject reconciliation must not
  bypass a workspace or mission's human merge policy.

## Proposal

The crux is to give every task a normalized, immutable identity for the
external or internal subject it acts on, separate from the task's own output
PR. Dedupe, liveness, branch lineage, and recall must use that identity. A PR
number alone is insufficient because a new head SHA is new CI evidence; a head
SHA alone is insufficient across repositories and workspaces; a title is never
an identity.

### 1. Data model

Add a nullable `tasks.subjectAnchor` JSONB column:

```ts
type TaskSubjectAnchor = {
  version: 1;
  kind: 'pull_request' | 'error' | 'mission' | 'branch';
  prNumber?: number;
  headSha?: string;
  branch?: string;
  errorSignature?: string;
  failingCheckNames?: string[];
  subjectMissionId?: string;
  source: 'context' | 'url' | 'text' | 'system' | 'backfill';
  confidence: 'exact' | 'derived';
};
```

`missionId` remains the task's orchestration container.
`subjectMissionId` means “this task acts on that mission” and may differ from
the container. The distinction prevents a task linked to mission A but
investigating mission B from deduplicating against every task in A.

Normalize before storage:

- `headSha` is lowercase hexadecimal, 7–64 characters. When GitHub supplies a
  full SHA, store the full value. A short SHA may enrich a task but cannot form
  an automatic PR dedupe key until resolved to the PR's full current head.
- `branch` has an optional `refs/heads/` prefix removed and is otherwise
  case-sensitive.
- `errorSignature` must be a known scanner slug, or a separately namespaced
  system signature registered in the same central catalog. Free-form error
  text is rejected as an identity.
- `failingCheckNames` are trimmed, case-preserving, deduplicated, sorted, and
  bounded to 50 names of 200 characters each. They refine context but do not
  replace the PR/head key.
- a PR anchor requires the repository workspace plus `prNumber`; automatic
  actions requiring head certainty also require `headSha`.

Add relational columns for hot lookup and constraints:

```text
subject_kind
subject_pr_number
subject_head_sha
subject_branch
subject_error_signature
subject_mission_id
subject_dedupe_scope   // active | retry_chain | none
subject_superseded_by_task_id
subject_resolution    // attached | superseded | filed_anyway | reconciled
```

`subjectAnchor` is the API shape and audit snapshot; generated or
write-through columns hold the indexed values. `subject_dedupe_scope = none`
is the explicit “file anyway” escape hatch, not a missing anchor.

Add a `task_subject_reports` table for attachments instead of appending
unbounded prose:

```text
id, task_id, reporting_task_id?, origin, reporter_id?, note,
anchor_snapshot, created_at
```

It preserves every report, supports events, and lets `create_task` return the
canonical task without manufacturing a sibling.

### 2. Extraction and precedence

`POST /api/tasks` calls one pure `extractSubjectAnchor()` before friction
dedupe, path-overlap inference, or insertion. Precedence is:

1. trusted system context written by webhook, watcher, organizer, or retry
   code;
2. explicit public API `subjectAnchor`;
3. exact GitHub PR URLs in title or description;
4. conservative text patterns; and
5. no anchor.

Higher-precedence fields may enrich lower-precedence evidence but conflicts
are rejected with `422 subject_anchor_conflict`. System callers must pass
`origin` and a server-issued creation source; a client cannot self-declare
trusted system context.

Extraction rules:

- Parse only exact URLs of the form
  `https://github.com/<owner>/<repo>/pull/<positive integer>`. The repository
  must match the workspace repository. Strip query strings and fragments.
- Accept `PR #123` or `pull request #123` only when the workspace has exactly
  one repository. Do not infer from a bare `#123`.
- Parse a branch only from an explicit `branch:`, `head branch:`, or trusted
  context field. Do not treat arbitrary slash-containing text as a branch.
- Parse a SHA only from `head SHA:`/`commit:` labels or trusted context. Resolve
  it through GitHub before granting `exact` confidence.
- Map legacy `context.pr`, `context.prNumber`, `context.headSha`,
  `context.baseBranch`, `context.resumeBranch`, and
  `context.frictionSignature` into the normalized anchor. New writers emit the
  normalized shape while legacy reads remain during rollout.
- CI retry and watcher filers pass PR number, full head SHA, branch, and
  failing check names directly. Organizer-created work passes
  `subjectMissionId` and any inherited PR/error subject. Friction filing passes
  the scanner slug as `errorSignature`.
- If prose names multiple different PRs, store no inferred anchor and return a
  non-blocking ambiguity warning. Explicit context is required to select one.

The anchor describes the subject at creation and is immutable once a worker is
claimed. Before claim, enrichment may fill missing fields but cannot change a
known PR, SHA, error signature, or subject mission. A materially new head is a
new subject generation, not an in-place mutation.

#### Backfill

Do not bulk-infer anchors from all historic prose. False anchors could cancel
or close valid human work. Backfill only:

1. exact CI retry columns;
2. exact legacy structured context;
3. workers with a stored PR number/branch where the task is a known retry of
   that worker's task; and
4. exact same-repository PR URLs, initially in report-only mode.

Terminal tasks are backfilled for recall only and get
`subject_dedupe_scope = none`. Open human-authored tasks inferred from prose
receive `confidence = derived` and can only run with context until a human or
GitHub lookup confirms them. Record extraction version and reason for every
backfilled row.

### 3. Identity and origin taxonomy

The primary PR generation key is:

```text
PrGenerationKey = (workspaceId, prNumber, fullHeadSha)
```

The PR lineage key is `(workspaceId, prNumber)`. It groups successive heads
but must not collapse a legitimate new failure on a new head. Pre-PR error
work uses:

```text
ErrorKey = (workspaceId, errorSignature, subjectMissionId-or-null)
```

Adding `subjectMissionId` prevents a broad platform error from merging
unrelated mission-specific remediation when the filer explicitly scopes it.
Workspace-wide friction leaves it null and deduplicates workspace-wide.
Organizer generation uses:

```text
MissionIntentKey =
  (workspaceId, subjectMissionId, normalizedIntentId)
```

`normalizedIntentId` is a planner-issued stable step ID, never a fuzzy title
hash. Branch-only work uses `(workspaceId, branch)` for linkage and
run-with-context, not automatic cancellation.

| Origin | Catching layer | Exact key | Default resolution |
|---|---|---|---|
| (a) Human files while auto-retry is in flight | General intake checks active tasks and the full retry ancestry | `PrGenerationKey`; lineage fallback only proposes | Attach a report to the active retry and show “work is already in flight.” Human may file anyway with a link; never silently cancel the human filing. |
| (b) Organizer double-runs from stale client state | Organizer supplies stable intent ID; DB conflict is authoritative | `MissionIntentKey` | Attach the second run event to the canonical task. If intent IDs differ, run with sibling context rather than fuzzy-deduping. |
| (c) Watcher and webhook file one CI failure | Both use general intake; unique subject claim arbitrates | `PrGenerationKey` | One canonical task; second origin becomes a report. Watcher event uniqueness remains delivery idempotency, not task identity. |
| (d) Agent re-files an existing task | MCP/API intake plus retry-ancestry lookup | PR key, `ErrorKey`, or `MissionIntentKey` by subject | Attach by default; permit `fileAnywayReason` and link both tasks. |
| (e) Friction bypasses manifest serialization | Error anchor intake runs before existing manifest inference and overlap logic | `ErrorKey` | Attach on hit. On miss, create once, infer `pathManifest`, then use existing dependency/overlap gates. |
| (f) Worker branches from `dev` instead of the open PR | Pre-claim lineage check, create-PR guard, then PR reconciliation | Exact subject key plus canonical task/retry lineage | Rebase/continue the canonical branch before a competing PR exists. If a competing worker PR opens, select a successor, close only the buildd-authored loser, and transfer escalations. |

Failing check names are not part of `PrGenerationKey`: GitHub can deliver
partial suites in different orders for one head. Store their union on the
canonical report stream. A new full head SHA creates a new generation even
when the check names are identical.

### 4. Intake dedupe and retry-chain lookup

Intake resolves the anchor against:

- tasks in `pending`, `assigned`, or `in_progress`;
- completed tasks with an open/unmerged worker PR;
- all ancestors and descendants reachable through `parentTaskId`; and
- subject reports already attached to those tasks.

The canonical task is the newest nonterminal member of the retry chain. If all
members are terminal, use the latest member only as prior context and create a
new task unless reconciliation proves a merged successor already resolved the
subject.

The API returns one of four explicit outcomes:

```ts
type SubjectIntakeOutcome =
  | { action: 'attached'; taskId: string; reportId: string }
  | { action: 'superseded'; taskId: string; successorTaskId: string }
  | {
      action: 'filed_anyway';
      taskId: string;
      relatedTaskId: string;
      reason: string;
    }
  | { action: 'created'; taskId: string };
```

- **Attach** when the new filing is another observation or instruction for the
  same live subject generation.
- **Supersede** when a trusted system filer creates the next bounded retry or
  a successor already owns the resolution. Preserve the retry edge and mark
  the old canonical member; do not create a parallel active owner.
- **File anyway with link** only on an explicit human or agent request with a
  nonblank reason. The new task uses `subject_dedupe_scope = none`, retains the
  anchor for liveness and recall, and links bidirectionally.

Read-then-write is insufficient. Introduce `task_subject_claims` with one
active row per dedupe key:

```text
workspace_id, key_type, key_hash, canonical_task_id, generation,
state, created_at, released_at
UNIQUE (workspace_id, key_type, key_hash) WHERE state = 'active'
```

The server first attempts the subject claim with `INSERT ... ON CONFLICT`.
The winner creates the task; the loser reads `canonical_task_id` and attaches.
Because Neon HTTP does not support interactive transactions, use a
reservation/finalization protocol: a short-lived reservation contains a
request id, task insertion writes the canonical id, and stale reservations are
recoverable. Never fall back to an unguarded insert when finalization fails.
The existing CI retry partial unique index remains during migration, then
becomes a defense-in-depth constraint over the same key.

### 5. Reconciliation and dead-PR shutdown

`pull_request.closed`, `pull_request.reopened`, `pull_request.synchronize`,
`pull_request.merged`, retry completion, and periodic repair enqueue an
idempotent `reconcileSubject(workspaceId, prNumber)` job. Webhooks persist facts
and enqueue; the reconciler owns cross-task decisions. Each decision is guarded
by the observed PR head/lifecycle version so an older delivery cannot undo a
newer state.

Reconciliation finds every anchored task and retry-chain member, identifies
the live successor, and emits a structured proposal:

```ts
type SubjectCompletionProposal = {
  taskId: string;
  proposedAction: 'cancel' | 'supersede' | 'keep';
  reasonCode:
    | 'subject_closed'
    | 'subject_merged'
    | 'successor_merged'
    | 'superseded_pr'
    | 'conflict_dead';
  successorTaskId?: string;
  successorPrNumber?: number;
  evidence: Record<string, unknown>;
  defaultAfter?: string;
};
```

This follows Cue's `propose_complete_item` principle: automation records a
reasoned, reversible proposal and a default; it does not force ambiguous
completion. The proposal appears in the task timeline and escalation inbox.

Confidence tiers:

- **Auto:** the subject is terminal *and* a verified successor PR has merged.
  System-filed redundant tasks are cancelled, retry members are superseded,
  and subject claims are released. Human-filed tasks are never silently
  cancelled; they receive the proposal and default notification.
- **Propose with default:** the subject closed/merged without a proven merged
  successor, the anchor is derived, or intent may remain useful. The workspace
  default applies after its grace period only to system-filed tasks.
- **Run with context:** the subject is still live, branch-only, or evidence is
  ambiguous. Keep the task and inject current/prior work at claim.

#### Unmergeable PR tiers

Unmergeable PRs must reach a terminal operational state:

1. **Closed or explicitly superseded:** immediately auto-close a still-open
   buildd-authored loser with a comment naming and linking the successor. Mark
   its worker `prLifecycleStatus = 'closed'`, record
   `supersededByPrNumber`, and supersede only open escalation notes.
2. **Conflict-dead for more than `conflictDeadDays` with a green successor:**
   auto-close the buildd-authored loser with the same successor comment and
   stamps. “Green” means all required checks pass on the successor's current
   head, using persisted GitHub facts.
3. **Conflict-dead without a successor:** create or update one escalation and
   hold dependent work. Do not close; a human chooses rebase, abandon, or a
   successor.

The default `conflictDeadDays` is 7. Repeated observations update one proposal
or escalation keyed by `(workspaceId, loserPrNumber, successorPrNumber-or-0)`.

Never auto-close a human-authored branch. A PR is safe for automatic closure
only when its head branch is recorded on a buildd worker and repository
metadata confirms the branch/PR was created by the configured GitHub App or
buildd service identity. Unknown ownership is human-owned. Merge policy may
further reduce automation but cannot expand this ownership boundary.

Closing a loser is ordered:

1. verify ownership, successor identity, successor current head, and tier;
2. post the successor comment idempotently;
3. close through GitHub;
4. stamp worker lifecycle and supersession fields conditionally;
5. supersede open escalations; and
6. reconcile anchored tasks and dependencies.

If GitHub closure fails, keep the PR and escalation open and retry. Never stamp
`closed` optimistically.

### 6. Pre-claim subject-liveness gate

Add `subjectStillLive()` as a SQL eligibility gate with cached persisted
subject state. Do not call GitHub in the claim loop.

The cheap gate order becomes:

1. workspace, `pending`, lease, and `startAt`;
2. no active worker;
3. held mission;
4. **subject liveness**;
5. dependencies;
6. workspace concurrency and runner cooldown.

The in-loop order becomes:

1. subject repair check when cached state is stale;
2. path overlap;
3. mission budget;
4. mission concurrency;
5. pacing;
6. connector/provider/account-budget routing; and
7. atomic claim.

Subject liveness precedes dependency, pacing, and budget because terminal work
should not occupy those queues or produce misleading blocked reasons. The
final atomic `UPDATE ... WHERE` repeats the liveness predicate alongside
`status = 'pending'`; a prefilter alone leaves a claim race.

Failure semantics:

- **terminal with merged successor, system-filed:** skip, conditionally cancel,
  and enqueue reconciliation;
- **terminal without merged successor or human-filed:** skip and place in
  `subject_review` hold with a proposal; do not repeatedly poll or silently
  cancel;
- **live:** continue;
- **unknown/stale:** skip this poll, enqueue refresh, and expose
  `subject_liveness_unknown`. Fail closed for spawning, but do not change task
  status.

A force-start may acknowledge a proposal but cannot bypass a confirmed
terminal subject without recording `fileAnywayReason`; it then runs with
context and cannot trigger automatic closure of human PRs.

#### Implementation status (2026-08-29)

The liveness half of this section is **shipped and now specified as a contract**:
see `docs/specs/subject-anchor-liveness.md`. That spec is authoritative for
binding classification (source AND confidence), fail-open semantics, terminal
cancellation, and the `/start` override. Do not restate those rules here — update
the spec instead.

What shipped differs from the proposal above in three ways worth recording:

- **`subject_review` was never built.** A dead subject on a binding anchor
  cancels the task (this section's "conditionally cancel" branch). Cancellation
  is load-bearing rather than cosmetic: `cancelled` satisfies the dependency
  gate, so terminating the dead task is what releases its dependents.
- **Force-start uses `bypassSubjectGate`**, matching the sibling
  `bypassDepsGate` / `bypassHeldGate` keys, rather than the `fileAnywayReason`
  recording proposed above.
- **Fail-open on absent data**, where this section says fail closed for
  `unknown/stale`. A missing anchor means the gate cannot make a claim about
  liveness and must not invent one. A genuinely stale-but-present anchor remains
  out of scope — the refresh path is still unbuilt.

Two production incidents motivated the contract: tasks `aeb80faf` (5 days
unclaimable) and `640e7da2` (24 days), both killed by a PR number cited in prose.
Both are recorded in the spec's rationale section.

### 7. Prior-work injection

For every surviving anchored task, claim builds a bounded
`Subject prior work` section from the same anchor:

- active and terminal task titles/statuses across retry ancestry;
- worker branches, PR numbers, lifecycle, and current head;
- relevant subject reports and completion proposals;
- up to five recall results queried by exact anchor tokens; and
- the canonical warning, for example:
  “Retry for PR #1437 claims to fix this head; verify its branch and CI before
  rediscovering or reimplementing.”

Exact structured lookup runs first. Semantic recall supplements it but never
drives dedupe, cancellation, or PR closure. The payload is capped by item count
and characters, redacts secrets, and includes stable task/PR links. Injection
is `run-with-context`, not proof that prior work is correct.

### 8. Tenant-facing configuration and defaults

Add optional `subjectPolicy` under `WorkspaceGitConfig`:

```ts
type SubjectPolicy = {
  mode?: 'observe' | 'propose' | 'enforce';
  dedupe?: 'suggest' | 'attach-system' | 'attach-all';
  proposalGraceHours?: number;
  conflictDeadDays?: number;
  autoCloseBuilddSupersededPrs?: boolean;
  priorWorkInjection?: boolean;
};
```

Safe defaults for all teams:

```ts
{
  mode: 'observe',
  dedupe: 'attach-system',
  proposalGraceHours: 24,
  conflictDeadDays: 7,
  autoCloseBuilddSupersededPrs: false,
  priorWorkInjection: true
}
```

`observe` extracts anchors and reports matches, but does not change intake,
claim, cancellation, or PR lifecycle behavior.
`propose` enables proposals and defaults for system tasks.
`enforce` enables atomic intake attachment and eligible buildd-authored PR
shutdown. No setting permits silent cancellation or automatic branch closure
for human-authored work. Mission policy may choose a stricter mode but cannot
weaken workspace ownership and confidence floors.

### 9. Race analysis

| Race | Required invariant |
|---|---|
| Human/API filing races webhook retry | The partial subject-claim uniqueness chooses one canonical task; the loser attaches or files explicitly linked. |
| Watcher and webhook insert concurrently | Both reserve `PrGenerationKey`; watcher-event uniqueness only suppresses repeated watcher delivery. |
| Two organizer heartbeats use stale task lists | Stable planner intent ID plus unique `MissionIntentKey` admits one task. |
| PR closes after claim prefilter but before worker insert | Atomic claim repeats subject liveness. Webhook state update wins first, or worker creation is compensated: worker is stopped before runner dispatch and task enters subject review. |
| PR closes after worker dispatch | Reconciliation proposes stop/cancel; automatic worker interruption is limited to system tasks with confirmed terminal subject and merged successor. |
| New commit arrives after a failed-head task is queued | `synchronize` creates a new generation. Old generation becomes propose/supersede; stale head can never be treated as current. |
| Successor goes green, then receives a new commit during loser shutdown | Conditional check includes successor head SHA. Head mismatch aborts closure and re-enqueues reconciliation. |
| Two reconcilers close the same loser | Conditional lifecycle update and idempotent comment marker make the second a no-op. |
| Reopened PR follows a close proposal | A higher lifecycle version withdraws an unexecuted proposal and releases `subject_review`; executed cancellation is not silently reversed. |
| Subject reservation winner crashes before task insert | Reservation expiry permits repair/finalization, never an unguarded second task. |
| Legacy task has no anchor | Existing claim behavior remains unchanged; path/dependency gates still apply. |

The claim route must not rely solely on a separate pre-read. Its final worker
creation/update statement includes task status, lease, `startAt`, held state,
dependency state, and subject-live version. Losing claimers skip without
creating a worker.

### 10. Rollout

1. **Observe:** add anchor types, extraction, subject reports/claims, persisted
   lifecycle version, metrics, and UI. Dual-write legacy fields. Backfill exact
   structured sources. No dedupe behavior or PR closure changes.
2. **Unify system intake:** route CI retry, watcher, organizer, and friction
   creation through the subject claim. Keep the CI partial unique index.
   Default duplicate system reports attach; human matches are suggestions.
3. **Claim backstop:** enable the repeated atomic liveness predicate for exact
   system anchors, then derived/human anchors as review holds. Add prior-work
   injection.
4. **Proposals:** enable reconciliation proposals and grace periods. Measure
   false-positive withdrawals and manual file-anyway use before defaults fire.
5. **Dead-PR shutdown:** opt-in per workspace, then enable by default only
   after ownership detection and idempotent closure audits pass. Start with
   explicit supersession; add aged conflict-dead closure later.
6. **Consolidate:** stop legacy context writes after all readers migrate.
   Retain compatibility reads and the CI unique index as defense in depth.

Every phase has a kill switch back to observe-only. Metrics distinguish
extracted, matched, attached, held, proposed, cancelled, PR-close attempted,
and PR-close failed outcomes by origin and confidence without storing prose.

## Acceptance checklist

### Origin (a): human filing during auto-retry

- [ ] Exact PR URL plus head resolves to the same `PrGenerationKey` as the
      webhook retry.
- [ ] UI offers attach and file-anyway-with-link; it never silently cancels the
      human filing.
- [ ] A concurrent submit/retry race creates at most one canonical active
      subject claim.

### Origin (b): organizer stale double-run

- [ ] Two runs with one stable planner intent ID create one task and two
      reports/events.
- [ ] Different intent IDs with similar titles are not fuzzy-deduplicated.
- [ ] A stale read cannot bypass the unique `MissionIntentKey`.

### Origin (c): watcher plus webhook

- [ ] Both pass identical PR number/full head SHA and failing checks.
- [ ] Concurrent filings produce one canonical task with both origins and the
      union of check names.
- [ ] A new head SHA is admitted as a new generation.

### Origin (d): agent re-filing

- [ ] Intake searches active tasks and the complete parent/child retry chain.
- [ ] Default attachment returns the canonical task ID and a report ID.
- [ ] Explicit file-anyway requires a reason and creates bidirectional links.

### Origin (e): friction without a manifest

- [ ] Scanner slug maps to `errorSignature`; raw excerpts never form a key.
- [ ] Same-workspace/same-scope reports attach by `ErrorKey`.
- [ ] A miss still runs existing manifest inference before overlap/dependency
      serialization; different workspaces do not deduplicate.

### Origin (f): competing PR from `dev`

- [ ] Pre-claim context identifies the canonical open PR branch and prevents an
      unaware worker from starting on `dev`.
- [ ] A buildd-authored loser is closed only after successor verification, with
      an idempotent comment naming the successor, superseded open escalations,
      and persisted `prLifecycleStatus`.
- [ ] Closed/superseded and aged-conflict-with-green-successor tiers terminate;
      conflict without a successor escalates and remains open.
- [ ] A human-authored or ownership-unknown branch is never auto-closed.

### Cross-cutting

- [ ] Closed/merged events and retry completion sweep every anchored task and
      retry-chain member.
- [ ] Auto-cancel requires a terminal subject and merged successor; human-filed
      tasks always receive a visible proposal.
- [ ] Final atomic claim repeats subject liveness and cannot spawn a worker on
      a dead subject even when reconciliation lags.
- [ ] Surviving claims receive bounded, redacted exact-anchor prior work plus
      supplemental recall results.
- [ ] Default workspace configuration is observe-first and reversible.
- [ ] Tasks without anchors retain current intake and claim behavior.

## Safety properties

- One active canonical task owns a structured subject generation unless a
  user explicitly files anyway with a recorded reason.
- No worker is spawned after the atomic claim observes a terminal subject.
- No task is auto-cancelled solely because its subject closed; automatic
  cancellation additionally requires a verified merged successor and
  system-authored ownership.
- No PR is auto-closed unless both the loser and its branch are verified as
  buildd-authored.
- Every automatic cancellation, supersession, escalation transfer, and PR
  closure is attributable, idempotent, and reversible where GitHub permits.
- Semantic similarity and model output may add context but never authorize
  dedupe, cancellation, or destructive lifecycle action.

## Non-goals

- Replacing `pathManifest` overlap or dependency serialization.
- Deduplicating unrelated tasks by title, embedding similarity, or changed-file
  overlap alone.
- Treating every new commit on a PR as the same CI failure.
- Automatically rebasing conflict-dead work without an explicit retry or
  successor.
- Closing human-authored PRs or branches.
- Changing merge-policy approval thresholds or granting new merge authority.
- Making semantic recall an authoritative state or identity store.

## Open questions

1. Should exact same-repository PR URLs on open historic human tasks be
   confirmed automatically after a GitHub lookup, or require one user
   confirmation? The safer initial choice is confirmation because liveness
   gating changes execution.
2. Should `subjectMissionId = null` error work deduplicate against an otherwise
   identical mission-scoped error? The proposal keeps them separate; the
   workspace-wide task can still be shown as prior work.
3. Which service identity signals are sufficient to prove buildd ownership
   across GitHub App and user-token PR creation? Auto-close remains disabled
   until this is answered with repository metadata, not naming conventions.
4. Should a closed-without-successor human task remain held indefinitely or
   receive periodic reminders? The proposal leans toward one proposal plus
   configurable reminders, never an automatic cancellation.
