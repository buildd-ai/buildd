# Mission task handoff

**Status:** Proposed
**Related:** `apps/web/src/app/api/workers/claim/context-injection.ts`,
`apps/web/src/app/api/workers/claim/route.ts`, `apps/runner/src/prompt-builder.ts`,
`apps/web/src/lib/task-dependencies.ts`, `apps/web/src/lib/mission-context.ts`,
`apps/web/src/lib/workspace-state-context.ts`, `apps/web/src/app/api/workers/[id]/route.ts`,
`apps/web/src/lib/gate-ledger.ts`, `packages/core/db/schema.ts` (`tasks`, `missionNotes`),
`packages/shared/src/types.ts` (`TaskResult`, `GoalCriteriaState`),
`docs/specs/mission-task-lifecycle.md`, `docs/design/spec-to-build-pattern.md`

## Problem

A task with `dependsOn: [taskA, taskB]` is unblocked the moment `taskA`/`taskB` reach
`completed` (`resolveCompletedTask`, `apps/web/src/lib/task-dependencies.ts`, AC-2 of
`docs/specs/mission-task-lifecycle.md`), but nothing hands the newly-claimable task
what its dependencies actually did. The only sibling-result-injection paths that exist
today are keyed on `parentTaskId`, not `dependsOn`:

- **Aggregation.** `task-dependencies.ts`'s aggregator-creation code builds a brand-new
  `taskClass: 'bookkeeping'` task whose `context.childTasks` carries
  `{ taskId, title, status, result }` for each sibling under one `parentTaskId`, and
  `apps/runner/src/prompt-builder.ts` renders it verbatim as `## Aggregation Context`
  when `context.aggregation === true`. This is fan-in synthesis across siblings, never
  triggered by an ordinary `dependsOn` edge.
- **Rollup enrichment.** `apps/web/src/app/api/workers/claim/route.ts` has a block
  immediately after the five `resolvedContextProviders` injectors that enriches a
  claimed worker when its task carries `parentTaskId` — again keyed on the parent/child
  relationship, not on `dependsOn`.
- **Sibling path manifests** are surfaced through the mission's workspace-state and
  knowledge-context blocks (`apps/web/src/lib/workspace-state-context.ts`,
  `apps/web/src/lib/mission-context.ts`'s path-based knowledge lookup), which report
  *what paths are claimed*, never *what a specific upstream task concluded*.

A task claiming after its `dependsOn` cleared today gets exactly what any other claimed
task gets: the five-injector rail (external providers, knowledge, subject-prior-work,
discrepancy context, task-area scope — `context-injection.ts`'s own header comment
states the order is the contract) plus, if it is a mission task, whatever
`mission-context.ts`/`workspace-state-context.ts` renders into the mission's own prompt.
None of that is "here is what the task you depend on actually built." An agent that
depends on an interface, a decision, or a gotcha from an upstream task has to go
discover it itself — by reading the upstream PR, if it even knows the PR number, which
nothing hands it either.

Symmetrically, nothing on the *producing* side asks a task "what should your
dependents know." `result.summary` (`packages/shared/src/types.ts` `TaskResult`) is
free text, and per the completion-gate lineage documented in
`docs/specs/mission-task-lifecycle.md` AC-3c, a non-trivial share of completions carry
`summarySource: 'fallback'` — the runner's own end-of-session capture of the SDK's last
assistant message, not an authored outcome. A downstream task reading `result.summary`
today has no way to tell "the agent told me what it built" from "the session ended
mid-sentence and this is a stray aside."

## Current state (recon)

### Injector rail order and mechanics

`context-injection.ts`'s header comment is explicit that call order is the contract:
"external providers, then retrieved knowledge, then subject-anchor prior work" — and
`route.ts` extends this to five calls, in this order:
`attachExternalContextProviders` → `attachKnowledgeContext` → `attachSubjectPriorWork` →
`attachDiscrepancyContext` → `attachTaskAreaScope`. Every one is best-effort: a thrown
error inside any attach function is caught, logged, and attaches nothing — the claim
itself never fails because a context block could not be built. All five append to the
same `resolvedContextProviders` array on the claimed worker and mirror into
`task.context.resolvedContextProviders`, which `apps/runner/src/prompt-builder.ts`
concatenates in array order into the dispatch prompt.

### Completion shape

`tasks.result` (`packages/core/db/schema.ts:1053`, jsonb, typed `TaskResult | null`) is
the only place a completed task's outcome lives. Relevant fields today
(`packages/shared/src/types.ts:535-570`): `summary` (free text), `structuredOutput`
(`Record<string, unknown>`, whatever the task's `outputSchema` requested),
`summarySource` (`'agent' | 'fallback'`), `prUrl`/`prNumber`, `nextSuggestion`. There is
no `handoff`-shaped field anywhere in `TaskResult` today — this design adds one, inside
`structuredOutput`, not a new top-level `TaskResult` field or a new column.

### Output-requirement gate

The `outputReq === 'auto' | 'pr_required' | 'artifact_required' | 'none'` completion
gate lives in the PATCH handler of `apps/web/src/app/api/workers/[id]/route.ts` (see
`docs/specs/mission-task-lifecycle.md` AC-3/AC-3a–AC-3i for the full acceptance
criteria this design must not regress). It already has the two properties a handoff
gate needs to reuse: (1) a persisted refusal path —
`persistRejectedCompletionPayload` writes the agent's `summary`/`structuredOutput`
onto `workers.rejectedCompletionPayload` *before* returning the 400, so a refused
completion's work is never silently discarded; (2) up-front prompt announcement —
`apps/runner/src/prompt-builder.ts` renders the obligation into the `## Output
Requirement` section before the agent starts work, specifically so the constraint is
never learned for the first time from a 400 on the last call.

### Gate ledger

`apps/web/src/lib/gate-ledger.ts` exports `fireGateEvent` / `fireDeferralEvent` and a
`GATE_SLUGS` registry, consumed throughout `claim/route.ts` and the completion PATCH
handler with a uniform shape: `{ gate, surface, outcome: 'rejected'|'deferred'|
'bypassed', reason, taskId?, workspaceId?, missionId?, callerOrigin, detail? }`. A new
gate registers one more `GATE_SLUGS` entry and calls `fireGateEvent` at the point of
refusal — the same seam the output-requirement gate and every claim-loop gate already
use, per `docs/specs/mission-task-lifecycle.md`'s "Claim-gate legibility contract"
(CG-1..CG-6).

### Mission/task schema available with no migration

`tasks.dependsOn` (jsonb `string[]`, default `[]`), `tasks.context` (jsonb,
default `{}`), `tasks.result` (jsonb, typed `TaskResult | null`),
`tasks.missionPhaseIndex`/`missionPhaseLabel` (paired int/text, DB-checked to be
both-null or both-set), `tasks.pathManifest` (jsonb `string[] | null`) all already
exist and are all the storage this design needs. `missionNotes`
(`packages/core/db/schema.ts:1855`) has `type: 'decision'|'question'|'warning'|
'suggestion'|'update'|'reply'|'guidance'|'reviewer_*'`, `status: 'open'|'answered'|
'dismissed'|'superseded'`, and is already scoped by `missionId`/`taskId` — the
"open mission_notes of type decision/question relevant to this task" section (§2d
below) is a straight query against this table, no new column. `missions.goalCriteriaState`
(`GoalCriteriaState`, `packages/shared/src/types.ts:1528`) already carries a
per-criterion `verdict: CriterionVerdict` (`'pass'|'fail'|'UNVERIFIED'|'PENDING'|
'NOT_EVALUATED'`) plus `label`/`evidence` — the mission-brief section (§2b) reads this
verbatim rather than re-deriving it.

## Proposal

**Crux:** add one more best-effort injector, `attachMissionHandoff`, to the same rail
`context-injection.ts` already defines — same shape (pure builder function, SELECT-only
data sources, string block output, own unit tests), same call convention (append to
`resolvedContextProviders`, mirror into `task.context`), same failure discipline (a
thrown error attaches nothing, the claim still succeeds). Get the placement wrong —
inject it as a mission-context concept instead of a claim-time injector, or key it off
`parentTaskId` instead of `dependsOn` — and it silently misses every plain dependent
task, which is the exact gap this design exists to close. Get it right and a dependent
task's prompt gains one new, small, deterministic section with no behavior change for
every task that has no `dependsOn` edges (the overwhelming majority today).

### 1. Injector contract

`attachMissionHandoff(claimedWorkers, claimedTasks)`, same signature shape as
`attachDiscrepancyContext`. For each claimed task with a non-empty `dependsOn`, it:

1. Batch-fetches the named dependency tasks in ONE query
   (`inArray(tasks.id, allDependsOnIds)` across the whole claimed batch, not one query
   per task — see §9), selecting `id, title, status, result, missionId,
   missionPhaseLabel, pathManifest`.
2. Batch-fetches the latest `workers` row per dependency task (for `prUrl`/`prNumber`/
   `mergedAt`/`prLifecycleStatus`) in one query.
3. For mission-linked tasks, batch-fetches the mission row once per distinct
   `missionId` in the claimed batch (outcome sentence, `goalCriteriaState`,
   `missionPhaseLabel`... see §2b) and the artifact/`missionNotes` rows once per
   mission (§2c/§2d).
4. Renders one string block per task via `renderMissionHandoff(...)` (pure function,
   unit-testable with no DB) and appends it with the existing `appendContextBlock`
   helper.

The KnowledgeStore (`PgVectorStore`/`buildKnowledgeContext`) is never a data source
here — everything this injector renders is a direct-SELECT, structured fact (a task
row, a PR number, a criterion verdict, a note row), not a retrieval hit. This mirrors
`workspace-state-context.ts`'s own split: causes that need "what landed" render inline
from already-known rows with zero retrieval calls.

### 2. Sections and scoping

**(a) Upstream edges.** One entry per `dependsOn` id, each rendering: the dependency's
title; its `handoff.delivered` line if `result.structuredOutput.handoff.delivered` is
present (§5), else a labelled fallback — `(no handoff — raw summary) <result.summary
truncated>`, and if `result.summarySource === 'fallback'`, the label reads
`(no handoff — unauthored session end)` instead, so a dependent is never told a stray
conversational aside is an authored outcome; the dependency's PR number and merge state
(open / merged / closed-unsuperseded, reusing the same vocabulary
`docs/specs/mission-task-lifecycle.md`'s `awaitingMergeDetails` already uses); and
"observed touches" — the dependency's own `pathManifest`, labelled as declared scope,
not a diff (nothing here re-reads git).

Transitive upstream (depth > 1, i.e. the dependency's own dependencies) is **excluded**.
Decision, not oversight: `dependsOn` is a DAG, not a tree, and rendering transitive
closure risks unbounded fan-in on a task with a long upstream chain for a benefit that
degrades fast — a task cares what it directly depends on, and a two-hop-removed
decision is exactly the kind of thing the direct dependency's own handoff should have
already summarized if it mattered. A retry/attempt task (`taskClass: 'attempt'`, e.g. a
CI/conflict/reviewer retry) inherits the **same** `dependsOn` set as the task it
retries (no code change needed — a retry is created with the original task's own
fields, `dependsOn` included, per existing retry-creation call sites), so it renders
the same upstream section unchanged; it does not additionally see the failed prior
attempt's own handoff, because an attempt's failure is exactly what
`failureContext`/retry-context rendering already carries in the prompt
(`prompt-builder.ts`'s existing retry-iteration block), a separate concern from what
upstream *dependencies* delivered.

**(b) Mission brief.** Only when the task has a `missionId`: one outcome sentence
(`missions.description`'s first line, or a stated mission summary field if one
exists — reuse whatever `mission-context.ts` already treats as the mission's one-line
identity, no new field), the live `goalCriteriaState.criteria[].{label, verdict}` list
verbatim (never re-evaluated here — this reads the stored verdict, exactly as
`canCompleteMission` does when it reads rather than computes), and the task's own
`missionPhaseLabel` position stated as "phase N of M" using the mission's own
distinct `missionPhaseIndex` values.

**(c) Authoritative artifacts.** Mission-scoped artifacts (`list_artifacts`-shaped
query, `missionId` scope), rendered as `key + id + one line` — reusing the exact
truncation pattern `mission-context.ts`'s own artifact block already uses (a 120-150
char preview, "Use `get_artifact` to fetch full content"). Never bodies: an artifact's
content can be arbitrarily large, and the fact that the artifact exists (the "authority"
this section names) is a pointer, not a place to inline a report.

**(d) Open mission_notes.** `missionNotes` rows where `missionId` matches,
`type IN ('decision', 'question')`, `status = 'open'`, ordered newest-first, capped
(shares the section's overall character budget, §4) — rendered as
`[decision|question] <title>: <body truncated>`. A `question` with a
`defaultChoice` set renders the default alongside it, since that is the working
assumption the mission is currently operating under, not an unresolved unknown.

**Retry/attempt inheritance** (stated once, applies to all four sub-sections): an
`attempt`-class retry of a task inherits exactly what that task would have rendered —
same `dependsOn`, same `missionId`, same `missionPhaseLabel` — because it is created
from the original task's own fields. No special-casing needed in the injector itself;
this falls out of retries already copying those columns forward.

### 3. Rail ordering and dedupe

`attachMissionHandoff` runs **first**, before `attachKnowledgeContext`, changing the
five-call sequence in `route.ts` to: `attachExternalContextProviders` →
**`attachMissionHandoff`** → `attachKnowledgeContext` → `attachSubjectPriorWork` →
`attachDiscrepancyContext` → `attachTaskAreaScope`. Ordering rationale: external
providers are the caller's own explicit context and outrank everything server-derived;
handoff is structured, high-precision, and cheap to read, so it should frame the
prompt before the fuzzier retrieval-based knowledge section arrives.

**Dedupe:** `attachKnowledgeContext` (retrieval) must not re-surface a hit whose
source is a task/PR the handoff section already rendered. Implementation: after
`attachMissionHandoff` computes its set of rendered task/PR ids for this claimed
worker, pass that set into `attachKnowledgeContext` (new optional parameter,
default empty set — no behavior change for a task with no `dependsOn`) and have it
filter retrieval hits whose `source_id` matches `task:<id>` or `pr:<number>` in that
set before rendering. This is a filter on already-fetched hits, not a second query.

**Order-contract update:** `context-injection.ts`'s header comment and `route.ts`'s
own "ORDER IS THE CONTRACT" comment both get the new six-call list; this design does
not touch the contract's *enforcement* (there isn't one beyond the comment and the
call-site order today), so no test currently pins the five-call order and none needs
to newly pin six — consistent with the existing contract being documentation, not code.

### 4. Budget

Hard character caps per section, mirroring `workspace-state-context.ts`'s existing
`BUDGET_*` constants pattern (that file already caps "what landed" at 400 chars,
sibling missions at 600, etc.) rather than inventing a new budgeting idiom:

| Section | Cap (chars) |
|---|---|
| Upstream edges (total, across all `dependsOn` entries) | 1200 |
| Mission brief | 400 |
| Authoritative artifacts | 400 |
| Open mission_notes | 400 |

Truncation is deterministic: within the upstream-edges cap, nearest-edge-first is not
meaningful (there is no proximity ordering on `dependsOn`, which is an unordered set),
so upstream edges truncate by **declaration order** (the order `dependsOn` lists the
ids) and, once the total budget is spent, the remaining edges are omitted with an
explicit `... and N more upstream task(s), not shown (budget)` line — never silently
dropped. Mission notes and artifacts truncate newest-first (matching
`workspace-state-context.ts`'s own newest-first convention for bounded lists) with the
same explicit omitted-count line when the cap cuts the list short.

### 5. Handoff schema

A `handoff` object inside `result.structuredOutput`, requested the same way any other
`outputSchema` field is — added to the task's `outputSchema` when the task has
`dependsOn` set OR has at least one *known* dependent at creation time (this is a
schema hint, not a completion gate; see §6 for enforcement). Shape:

```ts
interface TaskHandoff {
  /** One-line, always present when `handoff` exists at all. */
  delivered: string;
  /** Interfaces/exports added — function/type/route/table names, not prose. */
  interfaces?: string[];
  /** Decisions made, each with the one-line why. */
  decisions?: Array<{ decision: string; why: string }>;
  /** Non-obvious traps a consumer of this work would otherwise re-discover. */
  gotchas?: string[];
  /** Named, explicitly — not "everything else". */
  leftUndone?: string[];
}
```

Every field but `delivered` is optional — a task with nothing notable to report still
satisfies the gate with just `{ handoff: { delivered: "..." } }`. This composes with a
task's own `outputSchema` by being ADDED as one more top-level property alongside
whatever the task already requests (a JSON-Schema `properties.handoff` entry merged
into the existing schema object, not a replacement) — a task that also has a domain
`outputSchema` (say, a criteria-evaluator's verdict shape) gets both `handoff` and its
own fields in the same `structuredOutput` object. For a `mode: 'planning'` task, the
composition is with `PlanningStructuredOutput` (`summary`/`plan`/`goalCriteria`) the
same way: `handoff` is one more optional top-level key a planning task MAY also
populate (e.g., a spec task's plan-emission summarizes what the plan proposes), never
required for a task whose deliverable is a plan rather than a build.

### 6. Completion gate

A task with **any** dependent — any other task whose `dependsOn` names it, checked
live at completion time via `EXISTS (SELECT 1 FROM tasks WHERE dependsOn @> id AND
status NOT IN ('cancelled'))`, not a stored flag — cannot complete without
`result.structuredOutput.handoff.delivered` being a non-empty string. Enforced at the
exact same seam as the output-requirement gate in
`apps/web/src/app/api/workers/[id]/route.ts`'s PATCH handler: a new check alongside the
existing `outputReq` branches, running after structured-output is parsed and before
the completion is committed. On refusal:

- `persistRejectedCompletionPayload` fires exactly as it does for every other gate
  refusal (AC-3h/AC-3i) — the agent's summary/structuredOutput is never discarded.
- A `handoff_required` `GATE_SLUGS` entry fires `fireGateEvent` with
  `outcome: 'rejected'`, giving this gate the same ledger visibility
  (`get_failure_analytics family=gate`) every other gate already has.
- The 400 response carries `hint: 'handoff_required'` (a new hint value, alongside the
  existing `hint: 'create_pr'`), so a retrying agent gets an actionable signal distinct
  from "open a PR."

**Announced up front, not late:** `prompt-builder.ts` gains a new conditional section,
sibling to the existing per-`outputReq` blocks, that states "N task(s) depend on this
one; you must include `handoff.delivered` in your structured output before
completing" whenever the completion-time check above would apply. This mirrors the
existing `auto` output-requirement's own up-front announcement — the exact pattern
this design is told to reuse rather than reinvent.

**Sub-cases with no code-level lever, argued explicitly:**

- **A task acquires a dependent *after* it already started running.** The gate is
  evaluated at completion time from live `dependsOn` state, so a task that had zero
  dependents when it was dispatched (and so was never told to produce a handoff) can
  be gated retroactively by a dependent filed mid-flight. There is no code-level fix
  that both (a) keeps the check live (required — a stored "has dependents" flag on the
  task itself would go stale the moment a new dependent is filed, and staleness here
  fails open, not closed) and (b) guarantees the agent was told before it started. The
  prompt announcement is necessarily best-effort: it is accurate as of claim time, and
  a mid-flight new dependent is a real but rare race this design accepts rather than
  solves — an agent whose task gains a late dependent and closes with a genuine
  one-line summary can always retroactively satisfy the gate (`delivered` needs no new
  work, just a structured restatement of what already happened), so the gate is
  never actually unsatisfiable, only occasionally surprising.
- **A task with `outputRequirement: 'none'` and `taskClass: 'bookkeeping'`.** Per
  AC-3g's carve-out, a bookkeeping row is exempt from the deliverable checks entirely.
  This design does not exempt bookkeeping rows from the *handoff* gate the same way,
  because a bookkeeping row can still have real dependents (a criteria-verification
  task's dependent wants to know the verdict) — but a bookkeeping row's completion is
  overwhelmingly machine-authored (a command's exit code, a verdict object) rather
  than free-text summary, so `handoff.delivered` for these rows SHOULD be populated
  by the calling code that dispatches them (e.g., the verification-task creation site
  sets a template `handoff` alongside its `loopConfig`), not by an agent narrating.
  Left as an implementation note on the relevant creation sites, not a design decision
  this document can settle without touching each site individually.

### 7. Organizer side

`mission-context.ts`'s completed-tasks rendering (the "Last 10 completed tasks" query
and its per-task summary line) and `workspace-state-context.ts`'s `renderWhatLanded`
(the `task_completed`/`pr_merged` cause path) both switch to preferring
`result.structuredOutput.handoff.delivered` over `result.summary` when present,
labelling which was used inline (`[handoff]` vs `[summary]` prefix) so a reader — human
or the next organizer cycle — can tell an authored one-line outcome from whatever
`result.summary` happened to contain. This is a pure read-order change (`handoff.
delivered ?? summary`, falling through to the existing fallback-summary handling
unchanged when neither exists) — no schema change, no new query, since both fields
already live on the same `result` object already being read.

### 8. Heartbeat prompt diet

Proposed direction: move the heartbeat's static checklist/protocol/direct-action text
— the boilerplate re-sent on every cycle regardless of mission content — from the
per-cycle task `description` (built fresh by `buildHeartbeatContext` /
`mission-context.ts` on every heartbeat dispatch) into the Organizer role's own prompt
content (`apps/web/src/lib/default-roles.ts`), which is attached once per worker via
`attachRoleConfig` rather than re-rendered into every task body.

**This document does not carry a measured character saving** — the task brief asks for
a number "measured on a real heartbeat," which requires instrumenting an actual
heartbeat dispatch and diffing the description before/after, not a static count from
reading the template code. That measurement is deferred to the implementation step
(§ Implementation sketch, step 4) rather than asserted here without evidence.

**Behaviour risk, named:** role-prompt content is attached once at claim time and does
not vary per cycle, so moving cause-specific instructions (anything that currently
branches on `cause`/`causeData`, e.g. `workspace-state-context.ts`'s per-cause
rendering) into the static role prompt would be a regression — those must stay in the
per-cycle description. Only the checklist/protocol text that is byte-identical across
every cycle regardless of `cause` is safe to hoist. The implementation step must
diff a sample of heartbeat descriptions across different `cause` values before
choosing what qualifies as "static."

### 9. Degrade rules

Every one of the four sub-sections (§2a-d) is wrapped independently, matching
`workspace-state-context.ts`'s own per-section try/catch discipline: a failure in the
mission-brief fetch does not prevent upstream-edges from rendering, and vice versa. A
task with no `dependsOn` and no `missionId` renders nothing (`attachMissionHandoff`
returns immediately) — byte-identical to today's behavior for the common case. Assembly
never blocks a claim, matching every other injector on the rail.

**No N+1, asserted in tests:** the injector issues at most 4 queries total per claim
batch, regardless of how many claimed tasks in the batch have `dependsOn` or
`missionId` set — (1) one `inArray` fetch across every dependency id in the whole
batch, (2) one `inArray` fetch for the latest worker row per dependency task, (3) one
`inArray` fetch for mission rows across every distinct `missionId` in the batch, (4)
one combined artifacts+notes fetch per distinct mission (batched via `inArray` on
`missionId`, not one query per mission). A unit test asserts the query count is
constant as the number of claimed tasks with `dependsOn` grows, the same assertion
style `workspace-state-context.ts`'s own querier-injection tests already use.

## Open questions

- **Whether a `command`/mechanical `goalCriteria` re-evaluation should be triggered by
  this injector reading `goalCriteriaState`, or must always read the stored value.**
  Leaning toward: always read stored, never trigger evaluation — `canCompleteMission`
  is the one place that re-evaluates, and a claim-time injector re-triggering
  evaluation would add unbounded latency (a `command` criterion dispatches a whole
  verification task) to every claim of a mission task. A slightly stale verdict in a
  prompt is a much smaller cost than a claim endpoint that can block on a subprocess.
- **Whether `handoff_required` should also become a claim-loop gate** (deferring a
  *new* task from ever being claimed until an upstream handoff exists) rather than
  only a completion-time gate on the upstream task. Leaning toward no: the upstream
  task's own completion gate (§6) already guarantees a handoff exists by the time its
  dependent is unblocked (`resolveCompletedTask` only flips a dependent to `pending`
  after the upstream task reaches `completed`, and `completed` is now gated on having
  a handoff when dependents exist) — a second claim-loop gate would be redundant with
  the completion gate that already ran first, in DAG order, by construction.
- **Character budget tuning (§4).** The numbers here mirror
  `workspace-state-context.ts`'s existing scale (200-600 chars per section) rather
  than being derived from real handoff content, since no `handoff` payload exists yet
  to measure against. Expect these to move once real usage exists, the same posture
  `spec-to-build-pattern.md` took on its own token-budget open question.

## Non-goals

- Re-deriving or re-evaluating mission goal criteria from this injector — it reads
  `goalCriteriaState` verbatim (§2b, open question above).
- Transitive (depth > 1) upstream rendering — explicitly excluded, §2a.
- A new `dependsOn` semantics or claim-gating change — `docs/specs/mission-task-
  lifecycle.md`'s AC-1/AC-2 (dependency satisfaction, unblocking) are unchanged by
  this design; it only adds a *content* rail alongside the existing gate mechanics.
- Fixing the aggregation (`parentTaskId`/`context.childTasks`) or rollup-enrichment
  mechanisms this document surveys — both continue to exist unchanged, serving the
  fan-in case this design does not address.
- Making bookkeeping-row `handoff` population automatic across every dispatch site —
  named as a per-site follow-up in §6, not solved here.
- Any UI/dashboard rendering of `handoff` content — this design is claim-time prompt
  injection and completion-gate/organizer-read-order only.

## Implementation sketch

1. **Load-bearing: handoff schema + completion gate + prompt announcement.** Add
   `TaskHandoff` to `packages/shared/src/types.ts`; wire the `handoff_required` gate
   into `apps/web/src/app/api/workers/[id]/route.ts`'s PATCH handler alongside the
   existing `outputReq` checks, reusing `persistRejectedCompletionPayload` and
   `fireGateEvent`/`GATE_SLUGS`; add the up-front announcement to
   `apps/runner/src/prompt-builder.ts`. Nothing else in this document is reachable
   without this, since it is the only thing that makes `handoff.delivered` a real,
   populated field to read.
2. **`attachMissionHandoff` injector + rail ordering + dedupe.** New module
   `apps/web/src/app/api/workers/claim/mission-handoff-injection.ts` (mirrors
   `context-injection.ts`'s per-injector shape); wire into `route.ts`'s call sequence
   before `attachKnowledgeContext`; add the dedupe parameter to
   `attachKnowledgeContext`. Depends on (1) only for realistic non-empty test
   fixtures — the injector itself can be built and tested against a
   `result.structuredOutput.handoff`-shaped fixture without (1) having shipped.
3. **Organizer rendering prefers handoff.** `mission-context.ts`'s completed-tasks
   render and `workspace-state-context.ts`'s `renderWhatLanded`. Depends on (1) for
   real `handoff.delivered` values to prefer.
4. **Heartbeat prompt diet.** Measure a real heartbeat description's static-vs-cause-
   specific split first (instrumentation, not a code change), then hoist the
   byte-identical portion into `default-roles.ts`'s Organizer content. Independent of
   (1)-(3); can land in parallel. The measurement step is a prerequisite for the
   character-saving number this design does not yet have (§8) — do not skip straight
   to the move without it.

Suggested order: 1 → 2 → {3, 4 in parallel}.
