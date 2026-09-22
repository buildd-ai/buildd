---
status: implemented
# Promoted from `proposed` — the human-editorial call the prior drafting pass
# deliberately deferred (see git history for that suppression comment). All
# four assertions below pass against the current tree: Proposal §1
# (emitsPlan), §2 (forced requiresPlanApproval), §3 (specSource traceability)
# and §4 (renderSpecConformanceGuidance) are shipped, independently verified
# by reading the cited files, not inferred from this frontmatter. The doc's
# own "Current state (recon)" section is retained but annotated as a
# drafting-time snapshot rather than rewritten, per docs/design/DESIGN-FORMAT.md
# rule 5. `emits-plan-gate-in-tasks-route` is unsuppressed below now that
# `implemented` no longer contradicts an all-pass ledger.
assertions:
  - id: "emits-plan-gate-in-tasks-route"
    type: "symbol_reachable"
    symbol: "emitsPlan"
    entry: "apps/web/src/app/api/tasks/route.ts"
    as: "assign"
  - id: "spec-source-context-type"
    type: "symbol"
    name: "SpecSourceContext"
    path: "apps/web/src/lib/approve-plan.ts"
  - id: "spec-conformance-reviewer-guidance"
    type: "symbol"
    name: "renderSpecConformanceGuidance"
    path: "apps/web/src/lib/reviewer.ts"
  - id: "emits-plan-mcp-allowlist"
    type: "config_key"
    key: "emitsPlan"
    file: "packages/core/mcp-tools.ts"
---

# Spec-to-build as a first-class pattern

**Status:** Implemented
**Related:** `apps/web/src/lib/approve-plan.ts`, `apps/web/src/lib/task-dependencies.ts`
(`shouldAutoApprovePlan`/`resolveCompletedTask`), `packages/shared/src/planning.ts`,
`apps/web/src/app/api/tasks/route.ts`, `packages/core/mcp-tools.ts` (`create_task`),
`apps/web/src/app/api/discrepancies/[id]/dispatch-doc-fix/route.ts`,
`packages/core/spec-doc-fix.ts`, `apps/web/src/lib/reviewer.ts`,
`apps/web/src/lib/criteria-reviewer-findings.ts`, `apps/web/src/lib/mission-invariants.ts`,
`docs/design/plan-first-missions.md` (PR #2377), `docs/design/spec-conformance.md`
(implemented), `docs/design/merge-policy.md`

## Problem

Spec-before-code is doctrine in this workspace — every spec task's brief ends with
"propose an implementation breakdown, do NOT file those tasks" — but until this design
shipped, the platform had no supported path from "a spec task's proposed breakdown" to
"claimable child tasks a human approved, that a reviewer later checks the built PR
against." Concretely, at drafting time:

- A spec task ran as an ordinary `mode: 'execution'` task and its breakdown was prose in
  a PR body. A human re-typed each line into `create_task`. (Still true when a caller
  doesn't opt in — `emitsPlan` defaults `false`, see Proposal §6.)
- `mode: 'planning'` — the task mode whose completion is auto-materialized into child
  tasks via `approvePlan` — had no path through the public task-creation surface at all.
  `POST /api/tasks` hardcoded `mode: 'execution'` on every insert and never read a `mode`
  field from the request body; the MCP `create_task` tool's own allow-list had no `mode`
  entry either. **Closed by Proposal §1**: the `emitsPlan` opt-in now provides the one
  narrow, explicit path (`apps/web/src/app/api/tasks/route.ts`,
  `packages/core/mcp-tools.ts`). The raw `mode` field itself remains unexposed, by design
  (Non-goals).
- Once a plan existed, nothing connected an approved child task back to the spec document
  that authorized it, except by title text a human wrote. **Closed by Proposal §3**:
  `context.specSource` (`apps/web/src/lib/approve-plan.ts`).
- Once a PR opened from that child task, the review pass (`createReviewerTask`,
  `apps/web/src/lib/reviewer.ts`) checked diff hygiene and path-manifest conformance
  only — it had no way to see the spec the task claimed to implement, so "does the PR
  match what the spec said" was never checked mechanically or by an agent. **Closed by
  Proposal §4**: `renderSpecConformanceGuidance` (`apps/web/src/lib/reviewer.ts`).

The important finding of this recon is that **almost none of this needs to be invented**.
A structurally identical pattern — a task that emits an optional plan, gated behind the
same dead-looking approval flag, traced back to a spec document, collapsed to exactly the
work it authorizes — already ships today for one narrow case: reconciling a stale
`docs/design/*.md` status against shipped code
(`apps/web/src/app/api/discrepancies/[id]/dispatch-doc-fix/route.ts`, shipped as part of
`docs/design/spec-conformance.md` §12.1). This design generalizes that mechanism from
"one ledger-linked doc fix" to "any spec task," rather than building a second one.

## Current state (recon, with citations)

*This section is the recon snapshot from drafting time, kept as the evidence trail for
the Problem statement above — it is not rewritten wholesale post-ship, per
`docs/design/DESIGN-FORMAT.md` rule 5. Items 1, 3, 5 and 6 describe mechanisms this
design didn't change and still read as current. Items 2 and 4 describe the blocker this
design closed; each carries an inline note pointing at what shipped.*

### 1. `approvePlan` — what persists, what doesn't

`apps/web/src/lib/approve-plan.ts`'s child-task insert (lines 252-312) persists, per
`PlanStep` (`packages/shared/src/planning.ts:31-57`):

| `PlanStep` field | Persisted onto the child? | Evidence |
|---|---|---|
| `title`, `description`, `dependsOn`, `baseBranch`, `roleSlug`, `requiredCapabilities`, `outputRequirement`, `priority` | Yes | `approve-plan.ts:259-274` |
| `kind` | **Yes, as of PR #2454.** | `approve-plan.ts:278-283`: `...(step.kind && !intentInfo ? { kind: step.kind, classifiedBy: 'organizer' as const } : {})`. Before that PR, `kind` was schema-required but silently dropped on the floor — the exact failure mode this design must not repeat. |
| `phase` | Yes, via `computePlanPhases` | `approve-plan.ts:242-245,254,276-277` |
| `pathManifest` | **No — not from `step.pathManifest`, ever.** The only `pathManifest` write in the whole insert is `...(docFix?.specPath ? { pathManifest: task.pathManifest ?? [docFix.specPath] } : {})` (`approve-plan.ts:273`) — a doc-fix-only override that ignores whatever the step itself declared. A `PlanStep.pathManifest` emitted by any other planning task (an ordinary mission organizer cycle, for instance) is validated by the SDK schema and then dropped, identically to the pre-#2454 `kind` bug. |
| `complexity` | **No.** `grep` for `step.complexity` or `complexity` in `approve-plan.ts` returns nothing. Declared in the type (`planning.ts:52`) and the SDK schema (`planning.ts:168-171`), still dropped on the floor. Memory f1ea7de2's finding stands, unchanged. |

**Lesson this design must not re-trip:** a field's presence in `planningOutputSchema`
proves the SDK will emit it; it proves nothing about persistence. Every field this design
adds gets its `approvePlan` insert-side change specced in the same paragraph as its
schema-side change — see Proposal §1.

### 2. `shouldAutoApprovePlan` — the gate is not dead code, but it is not the mission-org
   gate the sibling design intended either

`apps/web/src/lib/task-dependencies.ts:106-113` is unchanged since PR #2377: it checks
`task.context?.requiresPlanApproval === true` first, unconditionally, before any
mission-scoped `BUILDD_REQUIRE_PLAN_APPROVAL` logic. That much is exactly as documented.

What has changed since #2377 was written: **the flag now has one real writer.**
`apps/web/src/app/api/discrepancies/[id]/dispatch-doc-fix/route.ts:211` sets
`context.requiresPlanApproval: true` on every doc-fix planning task it creates, so a
doc-fixer's optional net-enhancement proposal is never auto-dispatched. The comment at
`task-dependencies.ts:101` ("Nothing sets this today, so it cannot change existing
behaviour") is now stale prose, not stale logic — the logic is unaffected, but the claim
is false. This design's own writer (Proposal §2) is now the second, live in
`apps/web/src/app/api/tasks/route.ts`'s `emitsPlan` gate.

Separately: `docs/design/plan-first-missions.md`'s own proposal — flip
`requiresPlanApproval` on a mission's first organizer cycle from `POST /api/missions` —
is **not implemented**. Checked directly:

- `orchestrationMode`'s type union in `packages/core/db/schema.ts:819` is still
  `'auto' | 'manual'`; no `'auto-dispatch'` member exists anywhere in the codebase as a
  literal.
- `POST /api/missions`'s `runMission` call (`apps/web/src/app/api/missions/route.ts:445`)
  passes only `{ manualRun: true }` — no `requiresPlanApproval`.
- `reject-plan/route.ts` destructures only `{ feedback }` from its body — no `editedPlan`
  field exists anywhere in that file.
- `mission-invariants.ts` still has one undivided `plan_produced_no_children` key
  (`mission-invariants.ts:358,729-745`); no `requiresPlanApproval`-scoped split and no
  timeout-to-auto-dispatch invariant exist.

The only two pieces of `plan-first-missions.md` that did land — `PlanStep.pathManifest`
(`planning.ts:42`) and `PlanningStructuredOutput.goalCriteria`
(`planning.ts:78,199-229`) — landed as shared-contract additions, independent of the
mission-organizer wiring the rest of that design specifies. **The honest delta against
PR #2377 is: almost all of it, still unbuilt.** This document does not depend on any of
plan-first-missions.md's unshipped mission-organizer behavior. It depends only on the
piece that is actually live: the `requiresPlanApproval` read in `shouldAutoApprovePlan`,
and the `PlanStep` shape both designs share.

### 3. `resolveCompletedTask` plan extraction

Unchanged since PR #2129, confirmed by reading `apps/web/src/lib/task-dependencies.ts:41-74,121-258`.
`extractPlan()` accepts a real array or a JSON-stringified array; anything else is
`invalid`. An `invalid` shape on a mission-linked planning task posts a `warning`-type
mission-feed event (`plan-shape-rejected`, `task-dependencies.ts:231-251`) with a
365-day collapse window — effectively once per task. A missing `structuredOutput`
entirely (the runner never requested it) logs a `console.error`
(`planning-contract-violation`, lines 216-221) but posts nothing to the feed — this is
an infra failure, not something an approver would otherwise miss, so it does not need a
feed surface. This machinery is sufficient as-is for spec tasks; §5 below explains why
no changes are needed here.

### 4. Is `mode: 'planning'` reachable from `create_task`? — the primary blocker

**Resolved by Proposal §1 (shipped).** At drafting time the answer was no, on both
surfaces cited below; `emitsPlan` (`packages/core/mcp-tools.ts`'s allow-list,
`apps/web/src/app/api/tasks/route.ts`'s `mode: emitsPlan ? 'planning' : 'execution'`
ternary) is now the one narrow, explicit path this section's closing paragraph called
for. The recon below is preserved as the evidence for why the gap existed:

No, on both the MCP surface and the REST route underneath it — at drafting time:

- MCP `create_task`'s `allowedCreateTaskParams` set (`mcp-tools.ts:2163-2171`) has 33
  entries and no `mode`. Passing `mode` throws `Unknown create_task parameter(s): mode`.
- Even bypassing MCP and calling `POST /api/tasks` directly, the insert at
  `apps/web/src/app/api/tasks/route.ts:1077` writes the literal `mode: 'execution'` —
  it does not read `mode` from the parsed body at all. There is no hidden way in.

Every `mode: 'planning'` task in the codebase is created by one of five call sites, none
of them the generic task-creation route: the mission auto-start block
(`apps/web/src/app/api/missions/route.ts:423`), the mission detail page's manual
run/edit paths (`apps/web/src/app/api/missions/[id]/route.ts:567`), the "Run now" action
(`apps/web/src/app/api/missions/[id]/run/route.ts`), a plan rejection's revised replan
(`apps/web/src/app/api/tasks/[id]/reject-plan/route.ts:125`), and the doc-fix dispatch
already cited above (`dispatch-doc-fix/route.ts:189`). Each does its own
`db.insert(tasks)` with `mode: 'planning'` set directly — none goes through
`POST /api/tasks`.

This is deliberate, not an oversight: `mode: 'planning'` tasks get special handling
throughout `resolveCompletedTask`, the mission loop, and heartbeat prepass that assumes
mission-organizer provenance (a `missionId`, a place in the mission's cadence). Opening
`mode` as a bare `create_task` parameter would let any caller mint a task the rest of the
mission machinery doesn't expect. The doc-fix dispatch route sidesteps this by not going
through `create_task`/`POST /api/tasks` at all — its own narrow, purpose-built route owns
the insert and sets exactly the fields that call site needs. **This design proposes the
same shape of fix: one more narrow, explicit, server-validated opt-in — not a generally
open `mode` parameter.** See Proposal §1.

### 5. Spec-conformance review machinery — what's automatic, what needs a human

`docs/design/spec-conformance.md` carries `status: implemented` with five passing
assertions (`evaluateAllDocs`, the `specDiscrepancies` table, checker regression tests,
delta-gate tests, `promote_discrepancy` reachability) — this machinery is real and
shipped, not aspirational:

- **Automatic, no human:** Tier 1 pre-commit frontmatter validation; Tier 2 CI's
  mechanical ripgrep-based checker on every PR touching the watch set, including the
  delta gate that skips a no-op run; the ledger upsert itself
  (`INSERT ... ON CONFLICT (workspace_id, spec_path, assertion_id)`).
- **Needs a human (or an agent acting on their behalf):** authoring the assertion
  frontmatter in the first place (nothing infers it); `adjudicate_discrepancy`
  (accept / flip-direction); `promote_discrepancy`; and — the piece this design plugs
  into — dispatching the doc fix itself, today only reachable by a human clicking the
  "Dispatch doc fix" action on a `code_ahead` card.
- **The weekly Tier-3 LLM cron** only ever touches zero-assertion (`unverified`) specs,
  proposing assertion stanzas for review — it does not evaluate `spec_compare`-style
  drift on specs that already have assertions, and it never writes `spec_ahead` from any
  tier but itself (`spec-conformance.md` §8).
- **`verified_by`** is human-authored, not computed. `scripts/check-specs.ts:568-584`
  only validates it: an `active` spec's `verified_by` must be non-empty (error, with a
  `VERIFIED_BY_DEBT` grandfather set for pre-existing specs), every path must exist
  (error if not), and every path should look like a test file (warning if not). No
  script infers which tests cover which spec.
- **`spec_compare`** computes no verdict — it is retrieval only, both sides shown for a
  human or agent to judge (`packages/core/mcp-tools.ts` tool description, and
  `spec-conformance.md`'s own text: "It is a retrieval aid being asked to act as a
  conformance test").

None of this is the mechanism this design needs for "does this PR match its spec" —
that check is prose-level judgment (did the implementation follow the design's
decisions), not a ripgrep-checkable assertion. §4 below extends the reviewer, not the
Tier-2 checker.

### 6. The reviewer-role blocker — confirmed still live

Live-queried via `manage_workspaces action=get` (not inferred from code, since the value
is a per-workspace DB column): the buildd workspace's
`gitConfig.mergePolicy.agentReview.reviewerRole` is `"builder"` right now, not
`"reviewer"`, even though `reviewer` is a registered role
(`list_skills isRole=true` returns it, seeded by PR #2454). Per the fresh (2-day-old)
team memory on this exact question: no runner advertises the `reviewer` skill under its
local role directories, and `POST /api/workers/claim` filters strictly on advertised
skills (`or(isNull(tasks.roleSlug), inArray(tasks.roleSlug, availableSkills))`) — flipping
the policy today would make every review task permanently unclaimable, silently. This
design does not depend on that flip (the review it adds runs as whatever role
`reviewerRole` already resolves to — today, `builder`), but if the workspace ever does
flip `reviewerRole` to `reviewer`, provisioning the runner role directory first is a
hard prerequisite, independent of this design. Named here, not filed, per the task's own
out-of-scope instruction.

## Proposal

*Shipped — §1-4 below are all live in the code cited inline; see the assertions in this
doc's frontmatter and the Implementation sketch below for the mapping. Left in the
present/imperative tense in which it was drafted rather than rewritten retrospectively,
per `docs/design/DESIGN-FORMAT.md` rule 5.*

**Crux:** a spec task requests plan-emission through one new, explicit, narrow opt-in —
`emitsPlan: true` on `create_task` — rather than through a generally-open `mode`
parameter. Get this wrong by opening `mode` itself and any task, spec or not, can mint a
`mode: 'planning'` task the mission machinery doesn't expect (§4 above explains why that
machinery assumes organizer provenance). Get it right and a spec task looks, to every
existing system that branches on `mode`, exactly like the doc-fix dispatch route's tasks
already do today — because it's the same code path, generalized.

### 1. How a spec task emits a plan

Add one boolean, `emitsPlan`, to `create_task`'s parameter surface (MCP allow-list at
`mcp-tools.ts:2163-2171`, and the body reader in `apps/web/src/app/api/tasks/route.ts`).
Default `false` everywhere — every existing caller, human or agent, is byte-identical.
When `true`:

- `POST /api/tasks`'s insert sets `mode: 'planning'` instead of the hardcoded
  `'execution'` (the one line at `route.ts:1077` becomes a ternary on `emitsPlan`).
- The route forces `context.requiresPlanApproval = true` onto the new task's `context`,
  **after** merging the caller's own `context` (so a caller cannot pass
  `context: { requiresPlanApproval: false }` and undo it) — see Proposal §2 for why this
  is non-negotiable rather than a caller-settable default.
- The route requires a non-empty `pathManifest` naming at least the spec document this
  task will author (400 otherwise: "a spec task (`emitsPlan: true`) must declare
  `pathManifest` naming the spec document it authors"). This reuses the existing
  `pathManifest` param verbatim — no new field — and gives the dispatch-time
  spec-discrepancy injection (`spec-conformance.md` §11) and this design's traceability
  write (§3 below) the same anchor to key off.
- `resolveOutputFormat` (`planning.ts:249-256`) already requests `planningOutputSchema`
  for any `mode: 'planning'` task with no explicit `outputSchema` — nothing changes
  there. A spec task's structured output is exactly `PlanningStructuredOutput`: a
  `summary`, optionally `plan: PlanStep[]`, optionally `goalCriteria`. Whatever prose
  breakdown the task would otherwise have written into a PR body becomes that `plan`
  instead — the same content, structured instead of free text.

No new task type, output schema, or approval vocabulary. A spec task is a `mode:
'planning'` task exactly like an organizer's, indistinguishable to `approvePlan`,
`resolveCompletedTask`, or the dashboard's `PlanReviewPanel`, except for how it was
created and the one extra context field below.

### 2. The approval gate

Reuse `context.requiresPlanApproval` verbatim — no second gate. Unlike an organizer's
plan (where `plan-first-missions.md`, once built, would make approval the *default* but
still overridable per mission), a spec task's plan is **always** gated: the route sets
`requiresPlanApproval` itself and does not accept a caller override, because the entire
point of "spec before code" is that nobody — human or agent — authorizes their own
breakdown by writing it. This mirrors the doc-fix dispatch route's own unconditional
`requiresPlanApproval: true` at `dispatch-doc-fix/route.ts:211`, generalized from "one
call site always sets it" to "one parameter always forces it."

`shouldAutoApprovePlan` (`task-dependencies.ts:106-113`) needs no code change — it
already checks this flag first and unconditionally. This design adds a second writer to
a mechanism that already had one live writer (§ recon item 2); it adds no new reader.

### 3. Traceability

Every child task materialized from a spec-authored plan carries
`context.specSource: { specPath: string, planningTaskId: string }`, written by
`approvePlan`. This is new code, but it is the doc-fix pattern's own traceability field
generalized rather than a new design: `approve-plan.ts:296-305` already writes
`context.specDocFix` (and `finalizesProposal: true`) onto the one child a doc-fix
proposal collapses to. `specSource` is the same idea — "which document authorized this
task" — without the doc-fix-specific `assertionIds`/`discrepancyIds` (a fresh spec task
has no ledger rows to name) and without collapsing to one child (§ Non-goals: a spec
plan's whole point is decomposing into several tasks, unlike a doc-fix proposal, which
exists to land alongside the one PR that already fixes the document).

Concretely, in `approvePlan`'s per-step insert (`approve-plan.ts:296-305`), add:
`...(task.mode === 'planning' && emitsPlanSpecPath ? { specSource: { specPath:
emitsPlanSpecPath, planningTaskId } } : {})`, where `emitsPlanSpecPath` is read off the
*planning* task's own `pathManifest[0]` (the field Proposal §1 required non-empty at
creation). No new column: this is a `context` field, exactly like `specDocFix`, so it
needs no migration and touches no `tasks.path_manifest` write beyond what `approvePlan`
already does — satisfying the constraint verbatim. (This also means the design leaves
the recon item 1 gap — `PlanStep.pathManifest` not persisting onto children in the
general case — exactly as found. Fixing that is a real, separate latent bug; forcing a
fix into this design's insert would be exactly the kind of unscoped write the
constraints rule out. Worth a follow-up task; not this one.)

### 4. Review against the spec

Extend the existing reviewer contract with spec context, rather than a second review
pass. Cost matters here: a second full review per PR is not free, and the platform
already has one hook (`createReviewerTask`, fired from the merge-policy agent-review
path on PR open) whose prompt is already assembled from several conditionally-included
blocks in exactly this shape — `renderManifestGuidance` for path-manifest conformance
(`reviewer.ts:655`, doctrine/section pair) and `renderMissionCriteriaGuidance` for
mission-level prose criteria (`apps/web/src/lib/criteria-reviewer-findings.ts`,
consumed at `reviewer.ts:824-829`). Add a fourth block of the same shape:
`renderSpecConformanceGuidance`, fed by `originalTask.context.specSource?.specPath`
(read the same way `originalTask.pathManifest` already is, `reviewer.ts:819-821`).
When present, `buildReviewerContext` fetches the named spec/design doc and renders a
"Spec Conformance" section instructing the reviewer to judge the diff against the
document's decisions, not just its own diff hygiene — same verdict vocabulary
(`approve` / `request-changes` / `escalate`), no new output field required. When absent
(the overwhelming majority of PRs, which trace to no spec), the assembled prompt is
byte-identical to today's — the same "opt-in must not silently reflow every workspace's
reviewer prompt" rule the patch-evidence flag already follows (`reviewer.ts:776-779`).

This resolves the task brief's "extend the existing reviewer contract with spec context
injected, or a separate spec-validator pass" question in favor of the former: one review
pass, one verdict, spec conformance as one more thing it's told to look at — not a
second agent invocation per PR.

### 5. Failure modes

- **Unusable plan shape.** No change: `resolveCompletedTask`'s existing
  `plan-shape-rejected` mission-feed warning (§ recon item 3) already fires for any
  `mode: 'planning'` task with an invalid `structuredOutput.plan`, spec-authored or not.
  A spec task is rarer and more deliberately triggered than an organizer cycle, so the
  existing once-per-task feed warning is sufficient visibility; no dedicated surface is
  worth building for a failure this infrequent.
- **Approval never given.** This is exactly the ambiguity `plan-first-missions.md`
  already named in its own §4 and memory d7379c68 flagged in `plan_produced_no_children`:
  the remedy text conflates "the approval path is broken" with "a human gate nobody
  answered." This design takes `plan-first-missions.md`'s diagnosis (split the
  invariant) but **not** its remedy (24h auto-dispatch) — a spec-authored plan must
  never auto-dispatch, full stop, because unlike an organizer's plan, there is no
  "today's behavior" fallback to auto-dispatch *into*; auto-approving a spec's own
  breakdown is precisely the thing "spec before code" forbids. Concretely: scope
  `plan_produced_no_children` (`mission-invariants.ts:358,729-745`) to
  `!context.requiresPlanApproval`, as `plan-first-missions.md` §4 already proposed, and
  add a second, non-resolving invariant keyed on `requiresPlanApproval === true` that
  only posts an escalating visibility note (reusing the `missionNotes` `type: 'question'`
  shape `resolveCompletedTask` already uses for organizer questions,
  `task-dependencies.ts:164-174`) at increasing intervals — never a call to
  `approvePlan`. A forgotten spec plan stays forgotten-but-visible forever; it does not
  time out into unreviewed child tasks.
- **Built thing diverges from spec, reviewer says so.** No new mechanism: the reviewer's
  existing `request-changes` (fixable on the same branch) or `escalate` (a human call)
  verdicts already block merge under the `agent-review` policy tier exactly as they do
  for any other finding. §4's spec-conformance guidance feeds the same verdict the
  reviewer already renders — it does not add a blocking path that bypasses the merge
  policy, and it does not write to the `spec_discrepancies` ledger (that stays the
  mechanical Tier-2 checker's job; a reviewer's prose judgment on one PR is not the
  same kind of claim as a ripgrep-checkable assertion, and conflating the two would
  let a single reviewer's read create a ledger row nothing can later mechanically
  re-verify).

### 6. When this pattern does not apply

`emitsPlan` is explicit opt-in on `create_task`, never inferred from title, category, or
mission. Default `false`. A one-line chore, a bug fix, a docs edit — none of these set
it, and nothing about this design changes their behavior. The pattern is for the
narrow case the task brief names: a task whose entire deliverable is a breakdown that
should become approved, traceable, spec-checked child work — not "any task that happens
to produce a plan-shaped thought." Concretely: a caller sets `emitsPlan: true` only when
filing a task whose brief is "write a spec/design doc and propose (not file) an
implementation breakdown" — i.e., exactly the pattern this recon found repeated,
unwired, across the workspace's own spec-task briefs.

## Implementation sketch

*Items 1-4 are shipped, verified against the code cited in each. Item 5 is partial —
see its own note below.*

1. **Load-bearing:** `emitsPlan` param on `create_task` (MCP allow-list +
   `POST /api/tasks` body/insert) — forces `mode: 'planning'`, forces
   `context.requiresPlanApproval = true` unconditionally, requires non-empty
   `pathManifest`. Everything else is inert without this, since it is the only way a
   spec task can exist at all today.
2. `approvePlan`: write `context.specSource: { specPath, planningTaskId }` onto every
   child of a plan whose parent task has `mode === 'planning'` and a `pathManifest`
   (i.e., came through the `emitsPlan` path). No migration; `context` is jsonb.
3. `apps/web/src/lib/reviewer.ts` + `criteria-reviewer-findings.ts`-shaped new module:
   `renderSpecConformanceGuidance`, wired into `buildReviewerContext` alongside the
   existing manifest/criteria blocks, reading `originalTask.context.specSource`.
4. `mission-invariants.ts`: scope `plan_produced_no_children` to
   `!context.requiresPlanApproval`; add the non-resolving, non-auto-dispatching
   visibility invariant for `requiresPlanApproval === true` plans awaiting approval.
5. Dashboard: `specSource` shipped — the task detail page renders it via
   `SpecSourceBlock` (`apps/web/src/app/app/(protected)/tasks/[id]/page.tsx`) on an
   approved child task, no new UI surface needed. **`pathManifest` rendering on a
   pending spec plan did not ship**: `PlanReviewPanel`'s local `PlanStep` type
   (`apps/web/src/app/app/(protected)/tasks/[id]/PlanReviewPanel.tsx`) still has no
   `pathManifest` field and renders none. The assumption this item leaned on —
   that `plan-first-missions.md` might land that rendering first — did not hold; recon
   item 2 above confirms that design's own mission-organizer wiring is still unbuilt.
   This is a real, small gap; see the proposed follow-up in this reconciliation's task
   output rather than fixed here (docs-only PR).

## Open questions

- **Should `emitsPlan` require an admin-level caller, or any `create_task` caller?**
  Leaning toward: any caller, same as every other `create_task` param — the
  `pathManifest`-required 400 and the forced `requiresPlanApproval` already prevent
  misuse (nobody can create an unreviewed spec-authorized task branch), so an extra
  auth tier would add friction without closing a real gap.
- **Does a spec task's own plan-shape validation need to be stricter than an ordinary
  organizer's** (e.g. require at least one step, or reject an empty plan with a
  `goalCriteria` still attached)? Leaning toward no special-casing: an empty plan from a
  spec task is a legitimate "nothing to build yet" outcome, exactly as it is for the
  doc-fix proposal pattern this generalizes (`spec-doc-fix.ts`'s own text: "having
  nothing to propose is the expected outcome").
- **`renderSpecConformanceGuidance`'s token budget.** The doc-fix pattern injects a
  short assertion list, not a whole document. A spec-to-build reviewer may need more of
  the spec's own text to judge conformance meaningfully. Leaning toward capping at a
  fixed excerpt (mirroring `policyConfig.reviewerPatchTokenBudget`'s existing shape,
  `reviewer.ts:762-765`) rather than the full document, tuned once real usage exists —
  not a decision to make blind in this document.

## Non-goals

- Opening `mode` as a generally-settable `create_task` parameter. §4's blocker analysis
  is the reason: the mission machinery assumes `mode: 'planning'` provenance that a bare
  parameter would not guarantee.
- Implementing `docs/design/plan-first-missions.md`'s own mission-organizer wiring
  (`orchestrationMode: 'auto-dispatch'`, the `editedPlan` reject-plan fast-path, the
  24h timeout-to-auto-dispatch invariant). That design's delta is real and large, but it
  is about organizer-authored plans on mission first-cycles — orthogonal to this one,
  which is about explicitly-requested spec-authored plans. Both designs read the same
  `requiresPlanApproval` flag; neither depends on the other shipping.
- Fixing `approvePlan`'s general (non-doc-fix) `pathManifest` drop (recon item 1). Named,
  not fixed, per the write-scope constraint.
- Flipping `gitConfig.mergePolicy.agentReview.reviewerRole` to `reviewer`, or
  provisioning the runner role directory that would make that flip safe. Named as a
  live, confirmed prerequisite for anyone who *does* want spec-conformance review running
  as a distinct role rather than folded into the existing reviewer — not attempted here,
  since this design's Proposal §4 deliberately does not need it (it extends whatever
  role `reviewerRole` already resolves to).
- Retrofitting historical spec tasks with `specSource`, or backfilling `emitsPlan` onto
  any task created before this ships.
- A `metric`-type or `description`-type `goalCriteria` evaluator, mission-legibility
  rendering, or anything about the mobile timeline — untouched by this design.

## Proposed implementation breakdown (historical — items 1-4 shipped, item 5 partial)

The irony is noted: this document's own brief said "propose a breakdown, do NOT file
those tasks," which was exactly the gap this document existed to close. Obeying it once
more, here is the breakdown that was filed and built by hand, item by item — retained
as the record of what was proposed rather than rewritten, per
`docs/design/DESIGN-FORMAT.md` rule 5. See "Implementation sketch" above for the
shipped/partial verification notes against each item.

1. **`emitsPlan` on `create_task`** (MCP `mcp-tools.ts` + `POST /api/tasks`). Load-bearing
   — nothing else works without it. Files: `packages/core/mcp-tools.ts`,
   `apps/web/src/app/api/tasks/route.ts`. Tests: param accepted/rejected, `mode` forced,
   `requiresPlanApproval` forced and not overridable, `pathManifest` required (400 when
   absent).
2. **`approvePlan` writes `context.specSource`** on children of an `emitsPlan`-sourced
   plan. Depends on (1) only for realistic test fixtures. Files:
   `apps/web/src/lib/approve-plan.ts`. Tests: `specSource` present on every child of a
   spec-authored plan; absent for an ordinary organizer plan; `specPath` matches the
   parent's `pathManifest[0]`.
3. **`renderSpecConformanceGuidance` + reviewer wiring.** Depends on (2) for
   `context.specSource` to exist. Files: new module (shape mirrors
   `criteria-reviewer-findings.ts`), `apps/web/src/lib/reviewer.ts`. Tests: guidance
   block present only when `specSource` is set; assembled prompt byte-identical to
   today's when absent; token budget respected.
4. **`mission-invariants.ts` split** — scope `plan_produced_no_children` to
   `!requiresPlanApproval`; add the visibility-only awaiting-approval invariant.
   Independent of (1)-(3); can land in parallel. Files: `apps/web/src/lib/mission-invariants.ts`.
   Tests: existing invariant no longer fires on a `requiresPlanApproval` plan; new
   invariant fires at the chosen checkpoints and never calls `approvePlan`.
5. **Dashboard: surface `specSource` on a child task's detail view**, and confirm
   `PlanReviewPanel` renders `pathManifest` on a pending spec plan (may already be
   covered if `plan-first-missions.md`'s own implementation lands `pathManifest`
   rendering first — check before duplicating). Depends on (2). Files:
   `apps/web/src/app/app/(protected)/tasks/[id]/PlanReviewPanel.tsx` and/or task detail
   page.

Suggested order: 1 → 2 → {3, 4, 5 in parallel}.
