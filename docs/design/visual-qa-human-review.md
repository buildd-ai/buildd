---
status: proposed
# The model, the scoped loader and its GET route ship in slice 1. The
# decisions route is the next slice and fails until it lands, which is what
# keeps this doc honestly `proposed`.
assertions:
  - id: "cell-matrix-model"
    type: "symbol"
    name: "buildVisualReviewModel"
    path: "apps/web/src/lib/visual-review-model.ts"
  - id: "scoped-loader"
    type: "symbol"
    name: "loadVisualReview"
    path: "apps/web/src/lib/visual-review-load.ts"
  - id: "visual-review-read"
    type: "route"
    method: "GET"
    path: "/api/missions/[id]/visual-review"
    file: "apps/web/src/app/api/missions/[id]/visual-review/route.ts"
  - id: "visual-review-decisions"
    type: "route"
    method: "POST"
    path: "/api/missions/[id]/visual-review/decisions"
    file: "apps/web/src/app/api/missions/[id]/visual-review/decisions/route.ts"
---

# Visual QA: human review loop

**Status:** Proposed
**Related:** `docs/design/visual-qa-auditor.md` (the auditor this builds on), `apps/web/src/lib/mission-visual-review.ts`, `apps/web/src/lib/mission-surface-audit.ts`, `packages/core/surface-audit.ts`, `apps/web/src/lib/visual-audit-evidence.ts`, `apps/web/src/lib/mission-completion.ts`, `apps/web/src/app/app/(protected)/missions/[id]/`, `apps/web/src/components/chat/objects/`, `apps/web/src/lib/chat/mission-events.ts`

## Problem

The visual auditor gathers the right evidence: phone and desktop shots of every changed route, each with a finding and a verdict. The handoff to the human is where it fails. Six problems, all seen on origin/dev:

1. **The human can look but cannot act.** `VisualReviewLightbox.tsx` has no controls. No session-authed route can record a human judgement: `PATCH /api/artifacts/[artifactId]` accepts API keys only. "Agree", "that's not a bug" and "send this back" all require leaving the flow and hand-filing a `[surface fix] <route>: …` task with the exact title shape.
2. **The mission view gets less complete as the work gets better.** `selectLatestRun` keeps only the newest `(workerId, runKey)` run. Round 2 re-shoots only the fixed routes (`followUpSurfaceFix` freezes `requiredRoutes` to them). So after round 2, round 1's shots of every other route disappear from the Board.
3. **Pending, boot-failed and stalled audits are invisible.** `page.tsx` builds `boardVisual` only when `run.length > 0`. The visual `DeliveryStep` is computed and then thrown away (only Shipped is rendered). Nothing detects "no browser-capable runner online": the audit sits in `pending` indefinitely, and the only trace is `pending_deliverables`.
4. **`unsure` does nothing.** The auditor posts a `question` mission note. That note never enters `needsYou`, `canCompleteMission` ignores it, and a reply only marks it answered. The round-cap question has the same problem. So a mission can close with a shot nobody looked at.
5. **Chat shows none of it.** `MissionObjectView` has no visual field. `MissionPane` renders `MissionBoard` without `visual`, the pinned strip shows no shots, and only `plan_ready` and `question` events are ever posted. The assistant cannot read findings: `list_artifacts` drops `metadata`.
6. **Smaller gaps.**
   - Audit tasks are inserted without `kind`, and `ROLE_TO_WORK_KIND` has no `visual-auditor` entry, so no glyph shows anywhere.
   - `autoSurfaceAudit` exists in the API but not in the Settings sheet.
   - The task sheet shows shots as title-only links.
   - The task page mixes shots from several attempts.
   - Phone thumbnails are `h-12` and the lightbox caps the image at `42vh`.

There is also a live integrity bug. The artifact PATCH replaces `metadata` wholesale (`route.ts:130`). The auditor prompt tells agents to send `update_artifact {qa:{fixTaskId}}`. Doing that erases `route`, `viewport` and `finding`, and the shot silently drops out of both the evidence check and the strip.

## Current state

- **Evidence.** `artifacts.metadata.qa` = `{runKey, route, viewport, finding, verdict: ok|issue|unsure, fixTaskId?, variant?, theme?}`, written only by visual-auditor workers. Reads are scoped by `missionVisualShotsWhere` in `mission-page-query.ts`.
- **Completion evidence gate.** `loadVisualAuditEvidence` runs from `PATCH /api/workers/[id]`, per worker. It requires every route × viewport, a real upload, a non-empty finding, and every `issue` shot linked to a `[surface fix]` task. Verdicts are advisory.
- **Rounds.**
  - `planSurfaceFixFollowUp` either extends a pending audit or opens round 2 (`context.surfaceAuditRound`, `context.visualQa.requiredRoutes`).
  - At `MAX_SURFACE_AUDIT_ROUNDS = 2` it posts a system `question` note instead.
  - A person filing `[surface fix] <route>: …` through `POST /api/tasks` already reaches this path.
- **Surfaces.**
  - `BoardVisualShots` (Board only).
  - `VisualReviewStrip` (task page grid and dev fixture).
  - `VisualReviewLightbox` (read-only).
  - `MissionDelivery.tsx` is orphaned. `mission-detail-retirements.test.ts` asserts `<MissionDelivery` is absent from the page, so it was retired on purpose.
- **Chat.**
  - Object cards act directly on the human's behalf (`QuestionObject` → `ChatActions.answerQuestion`); the tap is the consent.
  - `worker:artifact` is already a refresh event in `MissionLiveStore` / `MissionAutoRefresh`, but `upload-url` never fires it.

## Proposal

The agent reviews first and the human reviews last. The human should see what the agent saw, judge it in one tap (on a phone too), and have that judgement *do* the thing it implies. There are five parts.

### The crux: a route-level cell matrix with human decisions in their own table

Every surface reads one pure model, `buildVisualReviewModel()` in `apps/web/src/lib/visual-review-model.ts`. It replaces "the latest run" with **cells**.

- A cell is one `route × viewport × variant`.
- Each cell carries its `history` across rounds: `{round, shot, agentVerdict, finding, fixTask?, review?}`.
- A round-1 cell stays current until a later round re-shoots it. This fixes problem 2.
- `effectiveVerdict` is the human decision if there is one, else the agent's verdict.
- The model also returns one `phase` for the audit as a whole:

  `off | waiting_deps | queued | no_browser_runner | capturing | boot_failed | stalled | failed | needs_you | fixing | reviewed`

  `failed` is a latest audit that failed for any reason other than a stall; `off` is kept for a mission that never had an audit. `needs_you` carries its reason (`question`, `unsure` or `round_cap`), and a question an in-progress auditor worker is waiting on counts, since the task stays `in_progress` while its worker waits.

  It returns a triage queue too: unsure first, then issue, then ok, then already reviewed.

Human decisions go in a new append-only table, `visual_shot_reviews`, and **never** into `artifacts.metadata.qa`. Three reasons:
- the auditor (via `update_artifact`) could otherwise overwrite them;
- a human "looks right" must never satisfy the auditor's `issue → fixTaskId` evidence rule;
- the gate needs an indexed query over open decisions, and undo needs history.

What breaks if this is wrong:
- If decisions lived in `qa`, one agent PATCH would erase human work.
- If the matrix were fed into the per-worker evidence gate, a mission could pass on another round's shots.

The evidence gate therefore stays per run, and a parity test holds the two equal for single-round missions.

### 1. Two buttons whose effect depends on the agent's verdict

The human sees two buttons whatever the agent said: **Looks right** and **Needs fix**. The server derives the relation and the side effect:

| Agent said | Looks right | Needs fix |
|---|---|---|
| ok | agree, record only | dispute: file `[surface fix] <route>: <note>` (note prefilled with the finding) |
| issue | dispute (waive): cancel the linked fix **only if it is still pending and unclaimed**. If it has started, post a `guidance` note to it and say so. | agree: optional note appended to the fix as `guidance` |
| unsure | waive, record only | file a fix, as for ok |

Rules for filing and undoing:
- The server always builds the fix title with `surfaceFixTitle(route, note || finding)`, using the recorded route pattern. The client never builds it.
- The fix id is stored on the review row. It is never written to `qa.fixTaskId`, which stays the auditor's field.
- Both viewports of one route can be decided together ("apply to both", on by default when their verdicts match), and that files one fix task.
- Every decision shows a 5-second Undo. Undo supersedes the review. It reopens a fix that it cancelled, or cancels a fix it filed, **only while that task is pending and unclaimed**. Otherwise it returns `409 fix_started`.
- At the end of the queue the human is offered one batch action: "The agent marked 9 fine. Accept all 9."

### 2. The review surfaces: one component family

`apps/web/src/components/visual-review/` is route-agnostic, so chat imports it without reaching into `missions/[id]`. It holds:

- **`VisualReviewLine`**: phase copy plus verdict dots. Reviewed dots show a human tick. This is the only place phase copy is written. `mission-delivery.ts` `visualStep` becomes an adapter over it.
- **`VisualReviewTray`**: thumbnails grouped by route, with the mobile and desktop shots paired.
  - Thumbnails are at least 64px tall on phones.
  - Each thumbnail shows its human-review marker: hollow = awaiting you, solid = confirmed, strike = disputed.
  - A "Review N" button sits alongside.
  - With no shots yet, it shows the phase's inline actions:
    - no runner: "Turn off for this mission" / "Skip this audit";
    - boot failure: the existing question's AnswerButtons;
    - stalled or failed: retry.
    - a question: the worker's prompt, with the same AnswerButtons.
- **`VisualReviewDeck`**: the lightbox rebuilt as a review queue.
  - **Desktop:** the route's desktop and phone shots side by side; route pattern, variant and round chip; the finding per viewport; the fix task with its status and PR. The action bar is sticky. Keys: Y = looks right, N = needs fix, J/K = next/previous, C = compare, U = undo. A header shows "4 of 14 reviewed".
  - **Phone:** a full-height page with a segmented phone/desktop toggle (phone first). The image is width-fit and scrolls, with no 42vh cap. Two 50%-width buttons, at least 48px tall, sit at the bottom inside the safe area. Swipe is horizontal only (previous/next) and is disabled while zoomed or comparing.
  - **Layouts:** `layout="dialog"` for the mission page; `layout="sheet"` renders inline, never a Dialog stacked inside the chat BottomSheet.
- **`VisualShotCompare`**: before/after for a cell with more than one round. The fix task title and merged PR sit between the two images. Desktop shows the rounds side by side; phone uses press-and-hold to show Before. There are no slider or blink modes.
- **`ShotImage`**: every `img src` is `/api/artifacts/:id/download`, never a signed URL. `onError` falls back to `ExpiredTile`, and the finding and any decision stay readable and decidable as text.

### 3. Where it shows

**Mission page.**
- The visual model is passed whenever an audit exists, including pending, boot-failed and stalled audits; the `run.length > 0` guard goes.
- Board:
  - The Band gets a Visual cell (`VisualReviewLine`).
  - The Needs-you count adds `summary.awaitingHuman`.
  - A `VisualReviewAsk` card sits next to `AskBanner`.
  - The auditor tile body becomes the Tray.
  - `CompletionRecord` shows human-confirmed, disputed and waived counts.
- The footer delivery row gets a clickable "Screens" row.
- Lanes (Side) and Feed get the Tray and Ask too.
- The Settings sheet gets a "Visual review" row: an `autoSurfaceAudit` toggle modelled on the `autoVerify` toggle, with the live Line under it.
- The task page and task sheet show the Tray for the audit's round, not title links or a mixed-attempt grid.
- Removed: `MissionDelivery.tsx`, `BoardVisualShots.tsx`, `VisualReviewLightbox.tsx`, `VisualReviewStrip.tsx` and `visual-review-parts.tsx`. The retirement test is extended.

**Chat.** There is no new object kind. `MissionObjectView` gains `visual: VisualReviewModel | null`.
- The mission pane passes `visual` to `MissionBoard` / `MissionLanes`.
- `MissionCard` gets a Line and a "Review N" row.
- `PinnedObject` shows the Line and a "N to review" chip at every width (red for `no_browser_runner`).
- "Review" opens the Deck in the sheet or pane.
- `ChatActions.reviewShots()` calls the decisions route directly. The tap is the consent, as with `answerQuestion`.
- New `ChatEventKind` `visual_review`, whose text always carries the counts (the model sees only `[update] text`):
  - "Visual audit waiting: no browser runner online"
  - "Round 1 done: 11 ok, 2 issues, 1 unsure. 3 need you"
  - "Round 2: /app/tasks/:id looks right"
  - "Issues remain after 2 rounds: your call"
- `get_visual_review {missionId}` is a text-only chat read tool. It reads the same GET route, so it is auditor-scoped and never sees images. There is **no** assistant write tool for decisions.

### 4. The server loop

- **Kind.**
  - Add `'visual-auditor': 'observation'` to `ROLE_TO_WORK_KIND`. This fixes existing rows through `resolveWorkKind` with no backfill.
  - Set `kind` on both audit inserts.
  - Human-filed fixes are `kind: 'engineering'`.
- **Read.** `GET /api/missions/[id]/visual-review` goes through one server-only loader, `lib/visual-review-load.ts`. It moves `missionVisualShotsWhere` out of the route folder, and it is the only way any surface reads shots.
- **Write.**
  - `POST /api/missions/[id]/visual-review/decisions` takes `{artifactIds (1..50), decision: looks_right|needs_fix, note?, expected: {artifactId: agentVerdict}}`.
  - `DELETE …/decisions/[reviewId]` is the undo.
  - Auth is session only: team and workspace access, as in `download/route.ts`, plus the in-process chat API. Every artifact must match `missionVisualShotsWhere` for this mission, or the request fails with 422.
  - Stale guard: if the cell has a newer-round shot, or the agent verdict changed, the route returns `409 {stale, cells, model}`: every stale cell of the request (both viewports can go stale at once) and the fresh model.
  - Writes follow a supersede-then-insert pattern with no `db.transaction`. A partial unique index keeps at most one active review per artifact, so a double tap cannot create two active reviews.
  - Each decision writes one `decision` mission note (with a collapse key per round) and fires `mission:visual_review` on `channels.mission`.
- **Rounds.**
  - `planSurfaceFixFollowUp(latest, {origin: 'auto'|'human'})`.
  - Human-origin fixes open or extend a round, and never hit the automatic-cap question.
  - Only one open human round is allowed at a time; a second request extends it.
  - Hard ceiling: `MAX_TOTAL_SURFACE_AUDIT_ROUNDS = 5`. At the ceiling the route returns 409 "open a task by hand".
  - Round rows record `context.surfaceAuditTrigger`.
- **Resolving questions.** A decision on an unsure cell marks any open auditor question note that references the artifact as answered. Once no surface fix is open, the round-cap note is marked answered too.
- **Auditor prompt.** The auditor no longer posts a note for `unsure`; the review queue is the question. It sends only `{qa:{fixTaskId}}` in `update_artifact`, which the server now merges. On a round N+1 it states whether each prior finding is resolved.
- **Runner availability.**
  - `browserRunnerOnline(heartbeats, workspaceId, now)`: a `worker_heartbeats` row with fresh `lastHeartbeatAt`, the workspace covered, and `environment.envKeys` including `'browser'`.
  - The phase is `no_browser_runner` when the audit is pending, its dependencies are done, it is more than 10 minutes old, and no such runner exists.
  - This is display only; it never cancels anything.
  - The chat stall event is posted once per audit task from the existing stale-workers sweep. No new cron is added. Dedupe is an atomic `jsonb_set` of `context.visualQa.stallNotifiedAt` guarded by `IS NULL … RETURNING`.
- **Realtime.** `upload-url` (for `qa/` uploads) and the artifact PATCH fire `worker:artifact` on the mission channel, so thumbnails stream in through the existing refresh.
- **PATCH integrity fix.** `PATCH /api/artifacts/[artifactId]` deep-merges `metadata.qa` and shallow-merges top-level keys. A regression test comes first.

### 5. The completion hold (shadow by default)

- New code `visual_review_open` in `packages/core/mission-completion-codes.ts`.
- `canCompleteMission` would refuse while a *current* unsure cell has no active review, or while the round-cap note is open. Open fixes already hold the mission through `pending_deliverables`, and ok and issue cells never need a human.
- Fast skip: if the mission has no audit task in the already-loaded `allTasks`, no extra query runs.
- Per the no-op default rule, the check ships in **shadow**: it logs `[visual-review-shadow] <mission short id> would hold: N cells`, and `mission-state-view` shows a non-blocking "N screens want your review".
- Enforcement is opt-in via `VISUAL_REVIEW_GATE=enforce` until the shadow logs are read.

## Schema

One new table, generated with `cd packages/core && bun db:generate`, following the schema-change skill (the head is around `0204`, so expect collisions). It is DDL only, with no backfill and no joins against real values.

`visual_shot_reviews`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `mission_id` | uuid not null | FK missions, cascade |
| `workspace_id` | uuid not null | FK workspaces, cascade |
| `artifact_id` | uuid not null | FK artifacts, cascade |
| `audit_task_id` | uuid null | FK tasks, set null |
| `round` | int not null | |
| `cell_key` | text not null | |
| `route` | text not null | |
| `viewport` | text not null | |
| `agent_verdict` | text not null | snapshot at decision time |
| `decision` | text not null | `looks_right` \| `needs_fix` |
| `relation` | text not null | `agree` \| `dispute` \| `waive` |
| `note` | text null | |
| `fix_task_id` | uuid null | FK tasks, set null |
| `cancelled_fix_task_id` | uuid null | FK tasks, set null |
| `reviewer_user_id` | uuid null | FK users, set null |
| `reviewer_label` | text null | |
| `superseded_at` | timestamptz null | |
| `created_at` | timestamptz default now | |

Indexes:
- `(mission_id, superseded_at)`
- `(artifact_id)`
- partial unique `(artifact_id) WHERE superseded_at IS NULL`

There is no `missions.visual_signoff` column in this wave.

## Implementation sketch

The load-bearing piece comes first. Each step is a separate PR.

1. **Foundation:** the model, the loader and GET, schema, glyph, PATCH merge, realtime.
2. **Decisions:** the route, round origin, question resolution, shadow hold, prompt.
3. **Components:** the review component family and fixtures.
4. **Mission page wiring:** the page and task surfaces, deletions, the settings toggle.
5. **Chat:** the visual field, the actions, the events and the read tool.

Steps 2 and 3 run in parallel after step 1. Steps 4 and 5 run in parallel after step 3. Watch dev CI after each merge, because the square-corners, em-dash and task-class invariants can turn red when PRs combine.

## Open questions

- **Enforce the hold by default?** I lean toward shadow for one release, then enforce. An unattended mission holding on an unsure shot is the honest outcome, but it is a behaviour change.
- **Auto-waive after the image expires?** Unsure cells whose images have expired (the R2 `qa/` rule is about 30 days and lives outside code) could be auto-waived. I lean toward yes once enforcement is on, recorded as a `waive` with a system reviewer, so a mission never holds on evidence nobody can see.
- **Old auditor prompts.** Roles are seeded per workspace, so older workspaces keep posting unsure notes. The resolver matches the artifact id in the note body. Should the visual-auditor role be re-synced? I lean toward yes, with a role version bump.
- **Human round ceiling.** Should it be 5, or just "one open human round"? I lean toward keeping both.

## Non-goals

- A new chat object kind, or one object per round.
- An assistant tool that writes decisions.
- Slack thumbnails.
- Server-side re-judging (`visual_qa` inference).
- A "re-shoot without a fix" action.
- Overlay-slider and blink compare modes.
- A three-mode sign-off policy.
- Workspace-wide "open disputes" views.
- Emitting `mission_completed` / `mission_failed` chat events.
- Changing the home page's `selectLatestRun` use.
- Reviving `MissionDelivery.tsx`.
