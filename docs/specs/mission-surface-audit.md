---
title: Mission Surface Audit
status: active
owner: max
last_verified: 2026-10-17
summary: A mission touching UI surfaces MUST receive a dependent surface audit and enforce its visual review policy before shipping.
domain: missions
surfaces: [apps/web/src/lib/workflow/visual-review-policy.ts, apps/web/src/lib/workflow/visual-review-state.ts]
related: [task-state-machine, claim-gate-legibility, mission-completion, organizer-context]
verified_by: [apps/web/src/lib/workflow/visual-review-policy.test.ts, apps/web/src/lib/workflow/visual-review-state.test.ts, apps/web/src/lib/mission-surface-audit.test.ts, apps/web/src/lib/mission-surface-audit-gate.test.ts]
assertions:
  - id: extra-guard-1
    type: test_file
    path: apps/web/src/lib/mission-surface-audit.test.ts
  - id: extra-guard-2
    type: test_file
    path: apps/web/src/lib/mission-surface-audit-gate.test.ts
  - id: "visual-review-policy"
    type: "symbol"
    name: "resolveVisualReviewPolicy"
    path: "apps/web/src/lib/workflow/visual-review-policy.ts"
  - id: "visual-review-policy-tests"
    type: "test_file"
    path: "apps/web/src/lib/workflow/visual-review-policy.test.ts"
  - id: "visual-review-state"
    type: "symbol"
    name: "deriveMissionVisualReview"
    path: "apps/web/src/lib/workflow/visual-review-state.ts"
  - id: "visual-review-state-tests"
    type: "test_file"
    path: "apps/web/src/lib/workflow/visual-review-state.test.ts"
  - id: guard-1
    type: test_file
    path: apps/web/src/lib/workflow/visual-review-policy.test.ts
  - id: guard-2
    type: test_file
    path: apps/web/src/lib/workflow/visual-review-state.test.ts
---
# Mission Surface Audit

**Capability statement**: A mission touching UI surfaces MUST receive a dependent surface audit and enforce its visual review policy before shipping.

## Per-mission surface-audit contract

**Capability statement**: A mission whose builder tasks touch a UI surface
directory MUST get its own `[surface audit]` task, gated on every builder task
in the mission, without relying on the separate recurring `Weekly mobile UI
audit` mission to eventually catch what it missed.

**Trigger**: `POST /api/tasks` (the single creation choke point for the
dashboard, the API, and MCP `create_task` — including organizer/heartbeat
decomposition passes, since all three route through this endpoint) calls
`ensureMissionSurfaceAudit` after every task insert that carries a `missionId`.

**UI surface directories**: `apps/web/src/app/` and `apps/web/src/components/`
(see `SURFACE_AUDIT_UI_PATH_PREFIXES`). The repo-wide sentinel (`['**']`) never
counts — it means "scope undeclared", not "touches the UI" (see the
Manifests-are-the-enforcement contract above).

**Behavior**:
- Only `taskClass = 'work'` tasks (real builder deliverables, not bookkeeping
  rows or the audit task itself) can trigger or extend an audit.
- No existing `[surface audit]` task for the mission, and this task's
  `pathManifest` touches a UI surface directory → mint one, `dependsOn` = every
  `taskClass = 'work'` task currently in the mission (including this one).
- An audit task already exists → append this task's id to its `dependsOn`
  (deduplicated), regardless of whether this particular task's manifest is
  UI-scoped — the audit reviews the mission's whole shipped surface, and a
  backend-only task can still change what renders.
- Mission has `autoSurfaceAudit = false` → no-op entirely.
- **Membership, not a frozen list**: the audit waits on the mission's tasks as
  they are now. A task unlinked or moved out of the mission
  (`PATCH /api/tasks/[id]` `missionId`, which `manage_missions unlink_task`
  calls) has its edge dropped from the old mission's pending audits
  (`detachTaskFromMissionSurfaceAudits`), and extending the audit rewrites its
  `dependsOn` to current members. The claim gate ignores an audit's dependency
  that is not in the audit's mission (`outsideSurfaceAuditMission` in
  `dependenciesSatisfied`), so an edge left by an earlier unlink never blocks
  it, and the mission page and task summary leave it out of the "waiting on"
  count (`dependencyHoldsTask`). Every other task waits on every dependency it
  names.

**Checklist** (reused from the Weekly mobile UI audit, scoped to the paths
declared by the mission's own builder tasks instead of the whole app): 390pt/320pt
viewport walk, both themes (every required route in light and dark,
`metadata.qa.theme`; completion counts a route only with both), the first screen
at 390 showing what the page is for, the CTA set derived from live server state
for every state the mission introduced, empty/error/loading rendering, nothing
shown twice (the same fact, count or action, or duplicate chrome titles), and
before/after against trunk on a mission branch. A workspace may add two items via
`gitConfig.visualQa`: `designRules` (a repo path every shot is checked against)
and `reference` (an approved design reference findings compare against); both
are off when absent. The audit task files defects as tasks in the **same mission** (not friction
reports) and completes with an artifact.

**Design vs built**: when the audit has a design (the mission's `design_reference`,
else the design the dependency's pinned spec revision names), the claim block
(`visual-audit-spec-criteria.ts`) hands the auditor a `QA_DESIGN` plan holding every
criterion that names screens on `screen:` lines. `scripts/qa/design-capture.ts`
renders each named screen at `#<screen-id>` at its own viewport, from memory in a
fresh browser context with no buildd session and no network beyond web fonts, pairs
it with the captured route (by name, or an explicit `routes` entry) at the same
device width, and writes `designs/`, `side-by-side/` (design | built) and
`design-captures.json`. The judge gets both images per screen and is asked for
differences that matter to the criterion (layout, content order, words, states
shown), not pixels; its verdict cites the screen id. The page is shot in the
design's theme; Night/Day parity stays its own check. A criterion with no screen
is judged as before. A screen of kind `component` (the design's screen metadata,
or the section's `data-kind`) is compared with its dev fixture
(`/app/dev/fixtures?state=…`, one per component state allowed) at the screen's own
width, never with a real route; its verdict names the screen and the fixture URL.

**Idempotency**: Re-running decomposition (the organizer creating tasks again)
never creates a second audit task — the existing-task lookup is by title prefix
within the mission, so a repeat pass only extends `dependsOn`. Best-effort under
concurrent task creation (check-then-act, matching this codebase's other
neon-http non-transactional patterns) — not a hard concurrency guarantee.

**Completion gate** (the audit above is minted from what a task *declares* at
filing; a task filed with no manifest, or by a path that never calls the hook,
mints nothing, and the mission used to close as shipped with no one having
looked at the screen). `canCompleteMission` therefore also reads what the
mission's merged work *actually changed*, via `evaluateSurfaceAuditGate`:
- Not required when the resolved Visual Review policy is `off` (workspace
  override, or the legacy `autoSurfaceAudit = false` exception, which `strict`
  ignores), when a `[surface audit]` / visual-auditor task has completed, when
  the mission has no finished builder task, or when a human waiver is recorded
  (never under `strict`).
- A builder is a finished `work` task that is not an audit, not a trunk-refresh
  task (`isTrunkRefreshTask`: its manifest widens to trunk's whole diff) and not
  the `Ship mission:` row. Their paths say nothing about what the mission changed.
- Evidence is each builder's PR diff, with patches (including the old name of a
  renamed file); a builder's declared manifest stands in only when it has no PR
  or its PR could not be read. Of that, only rendered UI files count (under a UI
  surface directory and not a test, story, snapshot, mock or doc), so a
  backend-only mission is never touched.
- Those files go to the visual impact classifier (`assessVisualImpact`,
  deterministic rules only: the gate has no single head SHA to bind a model
  answer to, so an ambiguous file stays `review_required`). A change it proves
  cannot render (comments, types, server-only code) owes nothing (`why:
  'no_render_impact'`), and its applicability record rides on the decision as
  `surfaceAuditAssessment`. Styles, tokens, risky flows and route screens whose
  hunk touches markup, style or text (or has no patch) always owe an audit; a
  route screen whose hunk changes none of those (a data-query port) is
  ambiguous, so here, with no model, it owes one too.
- Refusal code `surface_audit_missing`, with `surfaceAuditActor`:
  - `system` under `automatic` (default) and `strict`: `canCompleteMission`
    files the audit itself through `requestMissionSurfaceAudit` (idempotent) and
    the reason says the mission completes when it passes. The state view shows a
    self-resolving wait, never Run-or-Waive. A read-only call
    (`evaluateCriteria: false`) files nothing; the next completion attempt does.
  - `owner` under `ask`, on a local-executor mission, when an audit already
    failed or was cancelled (no refile on every attempt), or when filing failed:
    the reason names the UI files and both ways out (run the audit, or waive it;
    under `strict` only run it). The state view shows it as an owner decision.
- Fails open when the diff cannot be read and nothing was declared (no linked
  repo, GitHub error), so an outage never strands a mission.
- **Waiver**: `PATCH /api/missions/[id]` with `surfaceAuditWaiver` (a reason of
  at least 10 characters; MCP `manage_missions update`) records a
  `Surface audit waived` mission note carrying the reason. Only a person or an
  admin key acting for one may waive; an in-task agent (`actorWorkerId`) gets 403
  and the engine never waives. The same PATCH carrying `status: completed`
  is refused with 409 `surface_audit_missing` unless a waiver is supplied or
  already recorded. Archiving is not gated.
- **Dashboard waiver** (`MissionSurfaceAuditWaiver`): the mission page offers
  **Waive visual audit** on the Settings sheet's Visual review card and in the
  drawer of a not-yet-started audit task, whenever the mission has an audit, is
  blocked on a missing one, or carries a waiver. It asks for the reason in a
  sheet and sends `surfaceAuditWaiver` alone through the same PATCH (no status
  change), so the reason, the person and the time are recorded the same way and
  an agent or task token is refused there. A recorded waiver shows its reason,
  who set it and when, in place of the action. On a `mission-branch` mission
  the audit drawer also says CI Visual QA can't capture a mission branch and
  links the tracking PR.
- **Decision sheet** (`MissionDecisionSheet`): the exits it renders follow the
  blocker the server reports, so no button leads to a refusal. A missing audit
  shows exactly two actions, **Run visual audit** and **Waive with reason**; the
  goal-criteria exits (file the work, fix the criterion, waive and complete)
  render only while criteria are unmet, and nothing renders when neither holds.
  Each action has a one-line subtitle, the headline is one plain sentence
  (`surfaceAuditHeadline`), the changed files sit in a collapsed, wrapping list,
  and no API or tool name appears in text a person reads (the agent-facing
  wording stays in the API error body).
  - *Run visual audit* is `POST /api/missions/[id]/surface-audit`
    (`requestMissionSurfaceAudit`): files the `[surface audit]` task for the
    visual-auditor role, scoped to the files the PRs changed, and is idempotent
    (an open or finished audit is returned, only a failed or cancelled one is
    replaced). On an `executor: local` mission the sheet says buildd's runners
    will not claim it.
  - *Waive with reason* requires a reason of at least 10 characters (the same
    minimum as the API, checked on the client first), then sends
    `surfaceAuditWaiver` with `status: completed` in one PATCH. The sheet shows
    the recorded reason only after the PATCH succeeds. With goal criteria also
    unmet it sends the waiver alone, so the criteria are never waived by
    implication.
  - **Suggestion**: opening the sheet on this blocker asks a decision model
    (`POST /api/missions/[id]/surface-audit/advice`, capability
    `surface_audit_advice`, built in) whether to audit or waive, from the changed
    UI files and the shipped work titles (never descriptions or diffs). A
    confident pick is pre-selected with a one-sentence reason, and a waive pick
    prefills the editable reason. It only suggests: the person always confirms.
    No key, a timeout, an error, a low-confidence pick or a sensitive workspace
    all mean no suggestion, and both actions stand bare. Results are cached per
    mission and the set of merged PRs on each server instance, and the spend is
    recorded like other decision calls.

**Non-goals**: The recurring workspace-wide `Weekly mobile UI audit` mission is
unaffected and still runs as a backstop. Desktop-only concerns are out of scope.

**Acceptance criteria**:
- AC-29: GIVEN a mission with no existing audit task WHEN a `taskClass = 'work'`
  task is created with a `pathManifest` entry under `apps/web/src/app/` or
  `apps/web/src/components/` THEN exactly one `[surface audit]` task is created,
  `dependsOn` including the triggering task.
- AC-30: GIVEN a mission that already has a `[surface audit]` task WHEN another
  `taskClass = 'work'` task is created in that mission THEN no second audit task
  is created and the existing one's `dependsOn` gains the new task's id.
- AC-31: GIVEN a mission whose tasks only declare non-UI paths (or the `['**']`
  sentinel) THEN no audit task is ever created.
- AC-32: GIVEN a mission with `autoSurfaceAudit = false` THEN no audit task is
  created or extended regardless of what paths its tasks declare.
- AC-33: GIVEN a mission whose merged PRs changed a rendered UI file and that has
  no completed audit and no waiver WHEN completion is attempted (automated or by
  a person) THEN it is refused with `surface_audit_missing` and a reason naming
  the files and how to clear it.
- AC-34: GIVEN that mission WHEN a person supplies `surfaceAuditWaiver` THEN the
  reason is recorded on the mission and completion proceeds; an in-task agent's
  waiver is refused.
- AC-35: GIVEN a backend-only mission, or one with a completed audit, THEN the
  completion gate does not apply.
- AC-36: GIVEN a mission blocked only on a missing visual audit WHEN its
  decision sheet renders THEN it offers exactly "Run visual audit" and "Waive
  with reason" and none of the goal-criteria exits; with only unmet criteria it
  offers only the criteria exits; with both it offers both groups.
- AC-37: GIVEN the waiver field WHEN the reason is under 10 characters THEN no
  request is sent; WHEN a valid reason is submitted THEN the mission is
  completed with that reason recorded, and a refused request records and shows
  nothing.
- AC-38: GIVEN the suggestion call fails, times out or is not confident THEN
  both actions render live with nothing pre-selected.
- AC-106: GIVEN a mission's pending `[surface audit]` WHEN one of its
  dependencies is unlinked or moved to another mission THEN that edge leaves the
  audit's `dependsOn`, and a dependency not in the audit's mission never blocks
  its claim, while an ordinary task keeps waiting on a dependency in another
  mission.
- AC-107: GIVEN the mission page WHEN a person waives the visual audit with a
  reason of at least 10 characters THEN the reason and the person are recorded
  on the mission; a task token's waiver is refused and records nothing.
- AC-108: GIVEN a finished mission whose only UI evidence is a trunk-refresh
  task's manifest or PR, or whose UI-directory changes the classifier proves
  cannot render (comments, types, server-only code) THEN no audit is owed and
  the classifier's applicability record is on the decision.
- AC-109: GIVEN a mission that genuinely owes an audit under `automatic` or
  `strict` WHEN completion is attempted THEN the `[surface audit]` task is filed
  automatically (once), the refusal names the system, not the owner, and the
  state view shows a wait; under `ask` the owner decision stays, and under
  `off` no audit is owed.
- AC-110: GIVEN a completed mission whose last visual pass judged an earlier
  commit than the one it delivered WHEN its visual review is shown THEN it reads
  "passed on an earlier commit", names both commits, owes no verification and
  never says it checks again; GIVEN the same on an open mission THEN the review
  is owed again (`needed`).

**Code surface**:
- `apps/web/src/lib/mission-surface-audit-gate.ts` — `evaluateSurfaceAuditGate()`
- `packages/core/surface-audit.ts` — pure predicates and checklist content
- `apps/web/src/lib/mission-surface-audit.ts` — `ensureMissionSurfaceAudit()`,
  `requestMissionSurfaceAudit()`
- `apps/web/src/lib/surface-audit-advice.ts` — `adviseSurfaceAudit()` (the
  decision-sheet suggestion)
- `apps/web/src/app/api/missions/[id]/surface-audit/route.ts` and
  `.../surface-audit/advice/route.ts`
- `apps/web/src/app/api/tasks/route.ts` — trigger point (`POST` handler)
- `apps/web/src/lib/mission-surface-audit-membership.ts` —
  `detachTaskFromMissionSurfaceAudits()`, `missionMemberIds()`
- `apps/web/src/app/api/workers/claim/deps-gate.ts` — `outsideSurfaceAuditMission()`
- `apps/web/src/app/app/(protected)/missions/[id]/MissionSurfaceAuditWaiver.tsx` —
  the dashboard waiver
- `packages/core/db/schema.ts` — `missions.autoSurfaceAudit` (default `true`)

### Visual review: automatic, workspace-governed, verified before merge

**Owner decision (2026-10-12).** Visual audit is an **automatic,
workspace-governed process, never a routine owner prompt.**

- **Code decides impact.** Whether rendered UI changed is answered
  deterministically (declared manifests, then the PR diff; an unreadable diff
  fails open as `unknown`, never `no`). Jev is asked only about an *ambiguous*
  finding (an undecided unsure screen, the round cap). The owner is not a
  routine reviewer.
- **Verification runs BEFORE the mission-to-trunk merge.** While the
  integration PR is open, a review that is owed sets `blocksMerge`. If the PR
  merged first, the state carries `postMergeRecovery` and the review still runs.
- **The owner sees Merge now / Wait only where the merge policy requires
  approval.** That is a merge-policy concern. Visual review adds the owner as
  `nextActor` only for `ask` mode, and for a blocked review the owner must fix
  (a workspace-caused setup problem, or a system failure whose automatic
  retries are used up).

**Canonical state.** `deriveMissionVisualReview`
(`apps/web/src/lib/workflow/visual-review-state.ts`) is the one derivation;
`getMissionVisualReviewState` (`visual-review-state-load.ts`) is the one helper
surfaces call. It reads the existing `VisualReviewModel`, the surface-audit gate
and the integration PR delivery, and writes nothing. No surface re-derives
status from `VisualReviewModel.phase` or the gate. Statuses:

| Status | Meaning | Blocks completion / merge |
|---|---|---|
| `not_applicable` | no rendered UI changed | no |
| `optional` | UI changed (or unknown) but policy does not require review | no |
| `needed` | required, not started (system creates it; `ask` waits on the owner) | yes |
| `queued` / `running` | audit waiting / capturing | yes |
| `findings` | review worked and found **product** defects | yes |
| `blocked` | the review **system** failed (boot, stall, auditor, no browser runner, preview or auth setup) | yes |
| `passed` | nothing unresolved | no |
| `waived` | a person skipped it with a recorded reason | no |

`findings` and `blocked` never share a status, tone, copy or action: an `issue`
verdict is always `findings`, and `blocked` never files `[surface fix]` tasks.
The state also carries branch-stage fields (`headSha`, `base`, integration PR
`open | ready | blocked | merged`, `pendingVerification`, `blocksMerge`,
`postMergeRecovery`) and `nextActor` (`system | jev | owner | none`). A waiver
stands only while no audit started after it, and never under `strict`.

**Policy.** `strict | automatic (default) | ask | off`, stored in the workspace
`gitConfig.visualReview.policy` (no migration; null/absent inherits). Resolved by
`resolveVisualReviewPolicy` as **team default -> workspace override -> mission
exception**; the result names its `origin` (`default | team | workspace |
mission`). `strict` forbids skip and waive and ignores any mission exception;
`PATCH /api/missions/[id]` refuses a waiver or `autoSurfaceAudit: false` there
with 409 `visual_review_policy_locked`. Legacy `missions.autoSurfaceAudit`
maps to the mission exception: `true` or null inherits, `false` is `off`. No
team-level column exists yet, so the team default is the platform default
(`automatic`) until one is added. The workspace settings page shows the
effective value and where it comes from (`VisualReviewPolicySection`), and
`PATCH /api/workspaces/[id]/config` writes the override (`visualReview: null`
clears it).

**Impact assessment.** `assessVisualImpact`
(`apps/web/src/lib/workflow/visual-review-impact.ts`) decides whether the
integration branch diff vs trunk owes a review: policy first (`off` is
`not_applicable` by policy; `strict` never skips on a model's say-so), then
deterministic rules (styles, tokens and risky flows are `review_required`, and
so is a route screen unless its patch changes no markup, style or text line,
which makes it ambiguous rather than protected; a screen with no patch stays
protected; tests, types, docs, comments, server-only code are
`not_applicable` with recorded evidence), then, only for the ambiguous
remainder, the `buildd.visual_impact` decision kind through the shared
decision substrate (see `decision-kinds.md`). A missing diff, an error, low
confidence or `insufficient_evidence` runs the audit; there is never a human
prompt. The result is an *applicability* record (`recordKind: 'applicability'`,
head SHA, basis, confidence, structured reasons), distinct from a waiver, and
holds only for the head SHA it was made on (`isImpactAssessmentCurrent`).
`uiChangeFromImpact` maps it onto the state's `uiChange`.

**Scheduling.** `planVisualReviewSchedule`
(`apps/web/src/lib/workflow/visual-review-schedule.ts`, pure) decides what to do
for a mission's integration branch head, and `scheduleMissionVisualReview`
(`visual-review-schedule-run.ts`) executes it through the existing idempotent
writer, `requestMissionSurfaceAudit(missionId, { headSha, round, reason })`. It
runs from the `visual-review-schedule` cron (every 30 minutes) and from any merge
door that is refused for an owed review. An audit task is stamped with the head
it is for (`context.visualReview.headSha`); a queued audit stamped for an older
head is re-stamped, a running one keeps its head. Rules: never file while an
audit is queued or running; a pass on another commit, or an audit that recorded
none, is stale evidence (`staleEvidence`, status `needed`) and re-files as the
next round, up to the total round ceiling, while the mission is open. A completed
or archived mission is never re-filed (its completion gate already ran), so there
a pass on an earlier commit stays `passed` with `staleEvidence` and
`passedOnEarlierCommit` set, owes nothing, and every surface says it passed on the
judged commit and that the delivered commit was not checked again, never that it
checks again (AC-110); a failed audit is a **system**
failure and retries with 5 / 15 / 45 minute backoff, three attempts per head,
then `blocked` with the owner as next actor; a named capture setup error
(`protection_bypass_missing`, `app_auth_not_configured`, `preview_unavailable`)
and a local executor go to the owner at once and are never retried; with no
browser runner online the review is still filed (the next runner to connect
takes it) and reads as "Waiting for a browser", a system wait that raises no
Needs You and no "Report a Buildd problem" (see Known limits). A product finding is never a retry:
it is a `[surface fix]`, and the fix merging moves the head, which re-files the
review before the merge. Under `ask` and `off` nothing is filed.

**A merged fix waiting for a screenshot (spec 072de598 I-15).** A finding
whose fix merged is re-checked only by a shot of the same route, viewport and
known state (`qa.state`); a shot of another state, or a finding with no known
state, resolves nothing (AC-15). `buildVisualReviewModel` lists every such
finding in `model.recapture` and says who takes the next step:

- `queued`: an audit that has not finished will take them. Its prompt gets the
  exact list at claim (`attachVisualAuditRecapture`), from the model rather
  than the auditor's own reading of the fix's route.
- `capture`: the last audit finished without them and rounds are left (below
  `MAX_TOTAL_SURFACE_AUDIT_ROUNDS`, and the last audit was not itself a
  recapture). The state reads `needed` and the scheduler files one audit with
  reason `recapture`, naming each route, viewport and state, depending on
  nothing (the fixes already merged). A completed audit on the same head is not
  the answer to a recapture.
- `decide`: the round-cap question is open, or a recapture already missed them.
  The cells read `fixCheck.state = 'decide'` and join the deck queue with
  Fixed / Still broken; the state reads findings with `exhausted`, so the owner
  is asked (or skips, I-7). Still broken files a new repair.

No surface reads "no action needed" while one of these holds the merge, and the
mission PR never reads "ready to merge" while its visual review or its CI
holds it (I-12, AC-10): `mergeFact` reports it as `landing_blocked` (cause
`visual_review`) or `ci_red`, and `get_pr` names the merge gate's reason.

**Capture.** The review captures the integration branch by `capture_ref`
(`visual-qa.yml`, dispatched from trunk) or its preview deployment; the page
source result carries `captureHeadSha`, the commit that ref points at now, so an
auditor can say when the branch moved past the commit its task names.

**Ready to merge.** `decideReadyToMerge` (`apps/web/src/lib/ready-to-merge.ts`,
pure) is the one decision for a mission's integration PR; `guardMissionPrMerge`
builds its facts and every merge door already calls the guard (auto-merge,
`merge_pr`, the dashboard merge button, the kernel landing lane;
`ready-to-merge.test.ts` fails if a new door calls a merge primitive without
it). It blocks while mission work is unfinished or the visual review is owed,
stale, in findings, or blocked, and fails closed when the review state cannot be
read. It never gates a task PR into the integration branch, never gates opening
or reviewing the mission PR, and a direct-to-trunk mission has no integration PR
to gate. CI, the code reviewer's verdict and the protected-path, migration,
security and spend rails remain per-door rails that run for every PR; nothing
here, Jev included, can authorize an irreversible merge or skip a mandatory
check. An integration PR that already merged is `postMergeRecovery`: the review
is filed as `post_merge_recovery` and never reported as pre-merge assurance.

**One reading on every surface.** `presentVisualReview`
(`apps/web/src/lib/workflow/visual-review-presentation.ts`, pure) turns the
canonical state into the words, the stage (verifying, fixing, ready to merge,
merged, stuck, waived), the owner decision and the completion record. The
mission page's stepper and compact branch panel, the Settings row, the Visual
review delivery step, the mission-state reading behind Home and Health cards,
and the chat and MCP `get_visual_review` text all read it; none derives a
stage from phases, audit tasks or changed-file lists.

- The owner appears only for an actual decision: Merge now where the merge
  policy asks a person, a visual judgment once the automatic fix rounds are spent
  (`findings.exhausted`), a workspace setup problem, a check that could not run
  after its automatic retries, and the one Run under the `ask` policy. Changed
  UI files, a queued or running audit and a screen awaiting Jev never raise
  Needs You, and under `automatic` or `strict` a missing audit is a system wait
  (`visualReviewActor` on the mission state), never a Run-or-Waive prompt.
- A visual product finding and a failure of the check are separate:
  `problem: 'product'` vs `'system'`. A system failure is retried first; after
  that a person can send "Report a Buildd problem"
  (`POST /api/missions/[id]/visual-review/report`), a mission-feed entry built
  server-side from the state and passed through `redactDiagnosticText` (no
  links, tokens or addresses). It never touches the review's screens.
- The completion record keeps a person's waiver (reason, who, when, policy
  shown) apart from an automatic "no visual changes" decision. The waiver is
  offered only beside a real owner decision where the policy allows it, never
  under `strict`.

**Verified end to end.** `workflow/visual-review-flow.test.ts`, over the
in-memory mission in `visual-review-flow.fake-db.ts`, drives one mission's life
through the production chain (impact, state, schedule, ready-to-merge,
presentation) for: a no-render diff skipping automatically; a stylesheet, token,
risky flow or presentation-changing route screen always owing a review without
asking Jev; an
ambiguous change going to Jev and failing safe; review before the integration
PR merges; a finding repaired and re-reviewed on the fixed commit; a changed
head invalidating the pass; bounded retries then the owner; strict, automatic,
ask and off with team, workspace and mission inheritance and the legacy
`autoSurfaceAudit` mapping; the completion record; post-merge recovery; no
Needs You from an ordinary review; task PRs unaffected; feature vs
direct-to-trunk. `ready-to-merge.test.ts` pins that every merge door calls the
guard.

**Known limits.**
- The end-to-end suite covers the pure chain. The SQL and GitHub loaders
  (`visual-review-state-load.ts`, `visual-review-impact-load.ts`) and
  `guardMissionPrMerge`'s wiring are covered by their own tests, not by it.
- A direct-to-trunk mission has no integration head, so it is never assessed
  and its canonical state stays `optional`; its completion is held only by the
  older surface-audit gate.
- "No browser runner" has no timer: the review waits in the queue indefinitely
  and the state never escalates to the owner on its own (retries only count
  failed audits).
- Under `ask` the scheduler files nothing, so a mission waits on the owner's
  Run with no timer.

**Not yet wired.** The completion gate resolves the policy and asks the
classifier's deterministic rules (see "Completion gate" above), but it does not
read the canonical state yet, and the audit-creation hooks still read
`autoSurfaceAudit`; moving them onto the canonical state is follow-up work. The waiver note does not yet store the policy in
effect when it was written; the record shows the policy resolved now. The audit-creation hook (`ensureMissionSurfaceAudit`) honours only `autoSurfaceAudit = false`, so a workspace-level `off` does not stop it filing an audit at task creation; the scheduler and the merge gate do honour `off`.

**Out of scope**: The sibling contracts linked in the frontmatter.
