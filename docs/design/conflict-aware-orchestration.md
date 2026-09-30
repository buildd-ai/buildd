# Conflict-aware orchestration

**Status:** Accepted — implementation pending; rollout remains evidence-gated.
**Related:** [Convergence layer](convergence-layer.md), [Change intents](change-intent.md),
[Path claims](path-claims.md), [Spec-to-build pattern](spec-to-build-pattern.md),
[Task-area prediction](task-area-prediction.md), [Decision calls](decision-calls.md),
`packages/core/path-overlap.ts`, `packages/core/path-claim.ts`,
`apps/web/src/lib/change-intent.ts`, `apps/web/src/lib/auto-merge.ts`,
`apps/web/src/app/api/workers/claim/route.ts`, `packages/ai-kit/src/decide/index.ts`.

## Problem

Tasks repeatedly defer on paths that a cancelled task or an inflated reviewer
scope appears to hold. Unknown manifests serialize otherwise independent work.
PRs with green CI wait behind a moving base; distinct migration filenames can
still occupy the same numeric slot. More model calls cannot repair incorrect
ownership state.

The supplied gate and usage analysis, reviewed on 2026-09-30, supports prioritizing
claim correctness, unknown scope and merge latency. Conflict agents generally
resolve their work successfully and account for a small share of token spend:
the case for automation is latency, not assumed cost savings. Exact production
measurements remain outside this public repository. The concrete-manifest share,
successful explicit path-check volume and change-intent warning volume do not yet
have a complete readout. Absence of those measurements is not evidence of absence.

## Current state

Source inspected on 2026-09-30; these are shipped mechanisms, not proposed APIs.

| Area | What the source does | Remaining gap / deviation from the brief |
| --- | --- | --- |
| Spatial overlap | `pathsOverlap`, `shouldSerializeByManifest` and `findBlockingPr` in `packages/core/path-overlap.ts` compare exact paths and directory prefixes; arbitrary globs are literal. `**` is advisory for serialization. | Different numbered migration filenames do not overlap. Mixed sentinel/concrete manifests still check concrete leases at claim. |
| Claim deferral | Claim route has an open-PR manifest backstop, an active-lease backstop, and mission-local `advisory_manifest` serialization of scope-undeclared editing tasks. It records deferrals; review/non-editing tasks have exemptions. | PR manifests can be stale. Preserve own-PR, retry-PR and subject-PR exclusions, dependency, pacing, capacity, auth and budget gates. |
| Claim lifecycle | `task-cancel.ts`, worker terminal paths, GitHub webhook and `stale-workers.ts` use `path-claim-release.ts`. Core filters terminal and expired parked holders; cron maintenance reaps stale rows. | Cancellation/merge/close release is already built. Audit races, missed historical rows and delivery rather than rebuild it. Lease release on completion with an open PR is intentional: the separate open-PR backstop protects pending changes. |
| Claim mutation | Core provides atomic manifest append, claim insert and whole-task release. Task PATCH explicitly rejects `pathManifest`; `path-claim-check.ts` serves REST and MCP. | No selective release/narrow primitive. Conflict check, manifest append and insert are separate operations; atomic append alone is not exclusive acquisition. A check for an already-declared path returns before inserting a missing lease. |
| Runner declaration | `hook-factory.ts` auto-claims Edit/Write/MultiEdit with a bounded request and pending queue; `worker-sync.ts` reports committed branch touches. Worker PATCH promotes new observations into leases. | Confirmed conflicts are advisory. Codex has no PreToolUse seam. `computeTouchedPaths` compares against `origin/HEAD` or `origin/dev`, excluding dirty/untracked writes and ignoring the mission PR base. Observed leasing does not check another holder first. |
| Reviewer scope | `createReviewerTask` in `reviewer.ts` creates analysis tasks without a manifest. Delta review intersects compare files with PR files when its bounded file read is complete. | Distinguish read-only reviewer tasks from reviewer-fix retries. Retry manifests/leases and accumulated branch observations can still be inflated; prompt filtering alone does not narrow them. |
| Change intents | `change-intent.ts` matches surfaces, injects namespace anchors, records intents, posts warning notes and closes intents on PR close. | No `mergeAfter` merge gate. Anchor injection triggers for namespace directory paths, not schema-only paths; the schema-only example in the older design overstates the code. Intent insert uses `onConflictDoNothing`, but the schema has no matching unique key to guarantee deduplication. |
| Base refresh | `auto-merge.ts` checks actual PR-base ancestry. `conflict-retry.ts` uses `pr-branch-update.ts` for behind-only PRs, pinned to the evaluated head. | Clean update is already agent-free. It merges the base through GitHub, rather than rewriting history with rebase. Every update failure currently falls through to an agent; there is no same-symbol semantic check. |
| Decisions | ai-kit exports `defineDecision`, fingerprint/version checks, shadow/gated/live and `runDecisionEval`. Core resolves team policy, keys and model routing; `isJevModel` gates application at existing call sites. | The kit's mode is not a substitute for the app's Jev-only check. These orchestration decisions have no labelled rollout yet. |
| Prediction/plans | `task-area-prediction.ts` and its source module retrieve completed task neighbours and diff paths for advisory retrieval. Worker terminal handling captures touched-path outcomes before clearing them. `PlanStep` accepts manifests. | Retrieval prediction intentionally never writes authoritative manifests. `approve-plan.ts` still drops step manifests except the doc-fix override. Spec-to-build approval exists, but this mission explicitly authorizes direct filing and remains manual to prevent duplicate decomposition. |

`checkDependsOnResolved` in `task-dependencies.ts` unblocks downstream tasks
after upstream completion/merge; its use by merge routes is post-merge notification,
not an existing pre-merge ordering check in `tryAutoMergeWorkerPr`. Reuse its
dependency semantics, not a presumed merge gate.

## Proposal

The **crux** is distinguishing a live editing lease, a pending PR's actual surface,
and a prediction. If any is substituted for another, we either block unrelated
tasks forever or let two writers acquire the same surface. Correct deterministic
state is a prerequisite for every applying decision.

### 1. Correct and reconcile claim state

Keep existing lifecycle release and reaper wiring. Test cancel, error, completion
with an open PR, merge, close without merge, missing worker data, repeated terminal
events and failed waiter delivery. Repair historical stale rows through the reaper;
do not require replaying cancellations by hand. A terminal task releases its edit
lease even when its PR remains open; the PR backstop uses the current PR diff.

Add an authorized, workspace-scoped selective release/narrow operation shared by
REST and MCP. It soft-releases only this task's dropped leases, updates the current
effective manifest and notifies only affected waiters. Keep explicit planning
dependencies; identify provenance before removing any inferred overlap edge.
Preserve a separate declaration snapshot for conformance checks and audit. Use
atomic SQL/CAS with revision checks and retryable conflicts, not interactive Neon
transactions. Acquisition, narrowing and terminal release must serialize on the
same ownership revision so a late append cannot resurrect a cancelled lease.

Exclusive acquisition must atomically check and acquire normalized exact/prefix
paths within the workspace, including paths already in the declaration. Use a
workspace-scoped SQL serialization boundary for the overlapping-prefix check;
a unique exact-path index alone cannot exclude directory/file races. Observed
touches must use this same operation, not bypass it with unconditional inserts.
Keep regenerable-file exceptions, but do not treat a migration namespace as an
ordinary regenerable file.

Reconcile PR-backed effective scope from a fully paginated, head/base-pinned PR
file list, including rename source and destination. A read-only reviewer holds
no edit lease. A reviewer/CI/conflict fix attempt owns only its verified actual
editing scope, with inherited stale claims narrowed using the new primitive.
Never subtract files from a live writer's dirty worktree based only on a remote
PR snapshot. On missing, truncated or racing diff data retain conservative state
and record why; missing data is not an empty diff. Reconciliation must update both
the lease view and the open-PR view consumed by the claim route.

Acceptance: no terminal holder blocks a fresh task; one of two simultaneous
prefix-overlapping acquisitions wins; stale retry scope shrinks without releasing
live edits; an unmerged PR remains protected after its worker ends.

### 2. Automatic declaration and checkpoint sweeps

Extend the existing hook, not a second hook system. Normalize absolute paths
relative to the task worktree; reject escape paths. In the opt-in enforcing mode,
a confirmed real holder denies Edit/Write/MultiEdit and names the blocking task
and path. Preserve the bounded network deadline: unavailable coordination queues
the path and records degraded enforcement, rather than freezing the session.
Do not clear denied paths as though acquired; flush results per path/batch.

At sync, checkpoint, pre-push and completion, union committed changes against the
task's resolved PR base with NUL-delimited staged/unstaged status and untracked
files, excluding ignored runtime/scratch artifacts by explicit rules. Capture
renames, deletes and newly created source files. Refresh base refs outside the
hot hook; never fall back silently to an unrelated trunk. This replaces the
current committed-only `computeTouchedPaths` scope, and covers Bash writes.

Sweeps detect writes after they happened. They cannot honestly promise pre-edit
denial for arbitrary Bash or Codex. On a confirmed collision stop further writes
and push/completion, persist the checkpoint and hand off to a deferred task/PR;
do not keep an agent alive waiting for a lease. For backends without a pre-write
seam, advertise checkpoint enforcement explicitly. Retain `check_path_claim`
for deliberate declarations. A future filesystem interception layer is outside
this increment.

Acceptance: clean tool edits acquire before writing, real conflicts deny in
enforcing mode, unavailable service does not hang, Bash/untracked writes reach
the manifest, and a mission branch never leases unrelated trunk-history files.

### 3. Surface merge ordering and migrations

Implement Candidate 3's **mergeAfter behavior** using existing open change intents;
do not add a second free-form task dependency field merely to match its old name.
Add an opt-in serialized-surface policy alongside existing warning surfaces.
In `tryAutoMergeWorkerPr`, before any branch mutation or merge, defer behind an
earlier unclosed intent on a matched serialized surface. Reuse the helper in
other merge doors so normal manual/API merge cannot silently bypass ordering.
Any existing authorized override must be explicit and ledgered.

Order by stable `(createdAt, PR number)` with a deterministic tie-break; group
all intent rows for the same PR into one contender. Never make both contenders
wait on each other, never block on one's own PR, and stop/report a cross-surface
cycle. Serialize contenders in a workspace/repository boundary using atomic SQL
reservation/CAS; a read then merge check alone races. Pin the head, base and
surface revision; recheck immediately before merge and release a reservation on
success, failure or bounded expiry. GitHub mutation cannot share a DB transaction,
so recovery must reconcile expired reservations against GitHub before reuse.

Derive surfaces from authoritative actual diffs as soon as available, preserving
pre-PR declarations as provisional. Handle null task IDs explicitly (SQL `ne`
does not include NULL), deduplicate open intents at the PR/surface boundary and
reconcile missed close events, superseded PRs and same-PR head updates. Failure
to verify intent state defers the merge in enforcing mode. Closing the earlier
PR triggers re-evaluation of waiting PRs without a resident agent.

Record existing warnings and new ordering deferrals in the gate ledger with
surface, counterpart PR, evaluated head/base and reason; coalesce repeated waits.
Warnings remain advisory outcomes, distinguishable from enforcing deferrals.
Add counters for successful/denied/degraded path declarations and manifest
provenance; the generic MCP histogram is not an adequate denominator.

Migrations are one serialized namespace including schema-triggered generation,
SQL files, snapshots and journal. Add an explicit schema trigger for namespace
injection; do not assume the current directory-only resolver covers it. Namespace
reservation must survive generated-file lease exemptions. Keep migration-slot
reservation and collision/journal guards as backstops. Later PRs refresh after
the earlier PR closes; overlapping indices require renumbering/regeneration and
fresh CI, even if git merges cleanly. Compare the latest trunk and mission indices
before generating a migration. Do not hardcode observed production values.

Acceptance: later surface PR waits, closure wakes it, parallel merge attempts
cannot both reserve the surface, schema-only tasks serialize migrations, and
distinct SQL filenames sharing an index still refuse merge.

### 4. Deterministic base refresh and semantic escalation

Keep GitHub's `expected_head_sha` update-branch operation for clean behind-only
PRs. This is a deliberate deviation from literal rebase: it already exists,
preserves shared branch history and meets the latency goal without an agent.
Use the PR's actual base, including mission integration branches. Respect the
existing live-retry single-flight and dependency-bot branch ownership rules.

Classify update failure: changed head means re-read; transient/auth/rate-limit
or unknown API errors mean bounded retry/defer; a verified textual conflict
means dispatch the existing conflict agent. An API error alone is not conflict
evidence. Deduplicate by PR/head/base, allow at most one mutation in flight, and
cap repeated refresh attempts before escalating an operational failure. Retain
existing conflict iteration bounds; never rewrite a shared branch to refresh it.

Before refresh, compare the PR and newly arrived base diffs from their common
ancestor. A bounded CBM adapter maps changed hunks to symbol identities using
matching repository revisions; intersect symbols, not merely filenames. A
clean refresh with a verified same-symbol edit on both sides dispatches a
semantic conflict review. Record the evidence and do not auto-merge it first.
Missing/stale CBM coverage is `unknown`, not `disjoint`: defer semantic clearance
for bounded rechecks and surface an operational diagnostic, without inventing
a textual-conflict agent. In enforcing mode a potentially shared code surface
needs verified clearance; clearly disjoint paths need no symbol lookup.

After refresh, let CI/webhooks re-enter ordinary merge policy for the new head
and current base. Never reuse old-head green CI or an approval whose existing
carry-forward checks fail. No generative or Jev call occurs on the deterministic
disjoint clean path. No session waits for CI.

Acceptance: clean disjoint update plus fresh CI merges agent-free; network errors
do not create conflict tasks; genuine textual or verified same-symbol conflicts
do; head/base races and unavailable CBM never receive a false safety verdict.

### 5. Versioned Jev decisions

Use ai-kit's `defineDecision` with namespaced IDs, prompt versions and pinned
fingerprints. Resolve access through `packages/core/decision-client.ts` so policy,
credential scoping and team model routing remain intact; do not call the provider
with a new credential path. Record model, version, fingerprint, candidate digest,
rule verdict, confidence, applied/suggested status, error, latency and receipt.
A `gated` answer applies only when the kit permits it **and** `isJevModel` passes;
other models record suggestions even in `live`. No key, timeout, low confidence
or invalid answer falls back to today's deterministic rule. Bound retrieval plus
decision execution to an overall five-second deadline; cancel unfinished work.

#### 5a. Manifest prediction at creation

Reuse completed task-to-diff neighbour retrieval in
`packages/core/task-area-prediction-source.ts`, adding a bounded CBM candidate
adapter rather than a new index. Prefer actual diff evidence over declarations;
record candidate-source and revision coverage. Keep the existing retrieval-only
experiment unchanged. This is a separate, explicitly opted-in declaration policy.

One Choice produces one file, not a multi-file manifest. Use a bounded repeated
Choice over at most 254 deduplicated candidate files plus `DONE`, removing selected
files between picks, with a configurable pick cap and the shared deadline. Record
each dynamic definition's fingerprint and candidate map; validate the cap before
calling. Candidate omissions and pick/deadline truncation remain unknown scope,
never a fabricated complete manifest. New files absent from CBM require a supplied
declaration or later observed acquisition. Explicit caller manifests always win.

Shadow records predictions without changing creation acceptance or dependencies.
After evaluation, gated mode may supply an effective creation manifest only for
an eligible missing-scope task when all selections pass the measured threshold
and no truncation/unknown-scope flag remains. Inject namespace anchors and run the
same validation/overlap logic as explicit declarations. Retain provenance and the
original unknown-scope marker independently; do not make `**` a lease. Failed
prediction preserves the existing `manifest_required` rejection where applicable.

Label against final actually touched files (terminal observations plus full PR
diff when present), not the caller manifest. Persist outcomes before worker
observations clear; distinguish observed edits from landed edits and failed work.
Use `runDecisionEval` on labelled pick steps with deterministic truth ordering,
then compute whole-set precision/recall, omitted-path rate and candidate recall
separately. A good pick score cannot hide missing candidate files. Compare with
regex and neighbour-union baselines on the same split. The target is avoidable
unknown-scope deferral, not merely fewer creation rejections.

#### 5b. Hold versus start at claim

Ask one Choice (`HOLD`, `START`) only for uncertain scope or advisory PR overlap
after state reconciliation. Include holder liveness, effective diff/declaration,
base freshness and deterministic gate verdict. Never override exclusive live
leases, serialized migrations/surfaces, real dependencies, pacing, capacity,
budget/auth or an unresolved data read. A measured `START` may relax only the
identified advisory policy; it still acquires paths through Section 1.

Label completed windows with conflict-task creation, collision and base-freshness
refusal as separate outcomes as well as a composite risk label. A held or cancelled
task is censored, not a safe start. Shadow observes outcomes of the rule's actual
starts, so it cannot prove counterfactual safety for held tasks. Use a small
opt-in gated cohort of otherwise eligible starts with recorded assignment and
propensity to measure that boundary. Include wait time, stranded rate and throughput
alongside unsafe-start rate to prevent `HOLD`-everything appearing successful.

#### 5c. Optional overlap-real decision

Defer implementation until 5a and 5b have measured benefit. It compares both
head/base-pinned actual diffs, never manifests alone. If later enabled, use the
same shadow/eval/Jev-only progression; it cannot bypass a live lease or migration
surface gate. No optional decision task is required for this mission's first exit.

### 6. Rollout, evaluation and safety bounds

Ship new policies disabled; decision code starts in shadow with zero applying
cohort. Existing release, reaper, warning, refresh and retrieval behavior remain
the fallback. Explicit workspace opt-ins enable confirmed-conflict edit denial,
surface ordering and semantic clearance independently of Jev rollout.

Persist a dedicated content-free decision/outcome ledger (private source snapshots
are referenced securely, never committed). Group by definition fingerprint,
candidate-policy version, model and experiment arm. Use workspace-scoped retrieval
and avoid future-diff leakage when assembling creation-time candidates.

The final evaluation runs `runDecisionEval` on labelled outcomes, calibrating on
a training split and grading on held-out task/PR groups and a later time window.
Keep retry chains and neighbours from the same work unit in one split. Publish
only synthetic fixtures and qualitative conclusions here; detailed readouts are
private artifacts. Report coverage, per-label errors, set recall, unsafe starts,
latency, wait time and censored/missing-label share, with deterministic baselines.

Select thresholds from Jev measurements, not copied constants or an arbitrary
confidence target. The gated flip is conditional on adequate labels and an
acceptable measured tradeoff; if evidence fails, deliver the readout and keep
shadow. Pin fingerprints with the measured policy. Roll back applying fractions
to zero on regression or unknown ownership state. `live` requires a subsequent
successful gated readout; it does not bypass deterministic safety rails.

## Implementation sketch

File the following dependency chain directly in the manual mission. Every task
declares concrete files/directories, `kind`, a verification command and spec-source
context. Claim-route and merge-gate work runs at premium tier. The spec task is
the first dependency so build workers consume the merged design.

| Step | Deliverable | Requires | Verification focus |
| --- | --- | --- | --- |
| A | Section 1 acquisition/narrow/lifecycle primitives and transport | Spec | Concurrent prefix acquisition, terminal append race, selective waiter notification |
| B | Sections 1–2 diff/reviewer reconciliation and `PlanStep.pathManifest` persistence | A | Paginated/pinned diff, stale retry scope, explicit step manifests and doc-fix precedence |
| C | Section 2 enforcing hook and Bash/backend checkpoint coverage | B | Hook timeout/conflict tests, dirty/untracked/rename sweeps, mission base |
| D | Section 3 merge ordering, migrations and warning ledger | C | Concurrent surface reservation, close wakeup, cycle/failure handling, schema trigger |
| E | Section 4 deterministic refresh classification and CBM symbol adapter | D | No agent on clean/transient path, genuine conflict/symbol escalation, stale CBM |
| F | Sections 5–6 decision/outcome ledger and bounded access adapter | E | No-key/non-Jev/shadow no-op, fingerprint persistence, terminal labels |
| G | Section 5a creation manifest prediction | F | Candidate cap, multi-file choice, missing candidates, creation gate unchanged in shadow |
| H | Section 5b claim hold/start shadow decision | G | No deterministic gate bypass, censoring and outcome joins |
| I | Section 6 shadow readout and conditional gated flip | H | Held-out eval, baseline comparison, measured thresholds, rollback and fingerprint pins |

Builders write failing regression/feature tests before code and run the repo's
isolated `bun run scripts/run-unit-tests.ts` commands. Schema changes require
generated migrations and index comparison against trunk. After implementation,
promote the shipped invariants into `docs/specs/`, run `bun run specs:check` and
update this design's lifecycle; do not mark the whole proposal implemented when
only shadow decisions have shipped.

## Open questions

Thresholds, applying cohort sizes and whether either Jev decision earns `live`
remain empirical rollout decisions. The default is shadow until held-out evidence
supports application. The optional overlap-real decision remains deferred until
the first two demonstrate benefit. Neither requires a human plan review to begin
the dependency chain authorized here.

CBM revision coverage is an integration risk to establish in Step E. Prefer
head/base-pinned evidence; if the deployed adapter cannot provide it, ship the
clean refresh classification and leave semantic auto-clearance disabled with a
measurable unknown result. Do not silently relax the safety property.

## Non-goals

Keeping agent sessions alive waiting for leases, CI or another PR; replacing
merge review policy; a global merge queue for every file; new backend credentials;
model-driven textual conflict resolution on a clean disjoint path; replacing the
advisory task-area retrieval experiment; changing this mission to auto orchestration;
or implementing Section 5c before evidence justifies it.
