---
title: Task Page
status: active
owner: max
last_verified: 2026-10-12
summary: The task page MUST lead with the deliverable, its track and one outcome, list checks by round from delivery facts, frame attempts by their parent, fit a phone's first screen, and open Code review only to substance.
domain: surfaces
surfaces: [apps/web/src/app/app/(protected)/tasks/[id]/page.tsx, apps/web/src/lib/task-checks.ts, apps/web/src/lib/task-result.ts, apps/web/src/lib/workflow/projections.ts]
related: [workflow-state-kernel, mission-task-lifecycle, surface-ia-home-missions-initiatives]
keywords: [task detail, mobile header, show full title, review queued, no findings yet, review of PR, what shipped, why this, verdict block, review approved, updating branch, awaiting merge, repair 1, checks list, review round, attempt, reviewer task, fix attempt, structured output, technical summary, raw output, lifecycle track]
verified_by: [apps/web/src/lib/task-checks.test.ts, apps/web/src/app/app/(protected)/tasks/[id]/TaskChecks.test.tsx, apps/web/src/app/app/(protected)/tasks/[id]/TaskTitle.dom.test.tsx, apps/web/src/app/app/dev/fixtures/task-page-fixtures.test.ts, apps/web/src/app/app/(protected)/tasks/[id]/pr-lineage.test.ts, apps/web/src/lib/task-result.test.ts, apps/web/src/app/app/(protected)/tasks/[id]/task-header.test.ts, apps/web/src/app/app/(protected)/tasks/[id]/TaskVerdictBlock.test.tsx, apps/web/src/lib/workflow/projections.test.ts, apps/web/src/lib/task-verdict.test.ts, apps/web/src/components/LoopStatus.test.tsx, apps/web/src/components/task/PrCard.test.tsx]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "task-checks"
    type: "symbol"
    name: "deriveTaskChecks"
    path: "apps/web/src/lib/task-checks.ts"
  - id: "task-subject"
    type: "symbol"
    name: "taskSubjectOf"
    path: "apps/web/src/lib/task-checks.ts"
  - id: "readable-result"
    type: "symbol"
    name: "readableTaskResult"
    path: "apps/web/src/lib/task-result.ts"
  - id: "header-lifecycle"
    type: "symbol"
    name: "headerLifecycle"
    path: "apps/web/src/app/app/(protected)/tasks/[id]/task-header.ts"
  - id: "checks-on-page"
    type: "symbol_reachable"
    symbol: "deriveTaskChecks"
    entry: "apps/web/src/app/app/(protected)/tasks/[id]/page.tsx"
  - id: "task-checks-tests"
    type: "test_file"
    path: "apps/web/src/lib/task-checks.test.ts"
  - id: "task-result-tests"
    type: "test_file"
    path: "apps/web/src/lib/task-result.test.ts"
  - id: "review-detail"
    type: "symbol"
    name: "reviewDetailOf"
    path: "apps/web/src/lib/task-checks.ts"
  - id: "review-detail-tests"
    type: "test_file"
    path: "apps/web/src/app/app/(protected)/tasks/[id]/TaskChecks.test.tsx"
---

# Task Page

## Why this spec exists

The page grew by accretion: a verdict card, a "What shipped" header, a
lifecycle track, a PR card, related tasks and a worker feed each said where the
task stood, in their own words. On a reviewer run of PR #4413 (task `47e6ef96`)
it read, top to bottom: "What shipped" over the reviewer's title, "Reviewer ·
reviewer · buildd", "Skip release", "Build → Audit · repair 1 → Land", a card
saying "Done" twice with a "Why this?" disclosure, the parent task "Assigned",
and the review's summary as serialized JSON. The PR's GitHub comment said
"Repairing". None of it was a lie about a column; all of it misled. Nothing was
being repaired (the base branch was being refreshed), nothing had shipped (the
PR was approved, not merged), and the page never said that the thing on screen
was a review *of* another task.

This spec fixes the page's information hierarchy and the state vocabulary it
shares with the GitHub activity comment, Home and the activity list. It writes
no lifecycle state: every fact below is read from an existing writer (the
workflow kernel's delivery, rounds and attempt ledger; tasks; workers).

## Relationship model

```
mission ─┬─ deliverable task (delivery owner, tasks.delivery_role = owner or null)
         │     └─ delivery (workflow_deliveries, one per PR; owner_task_id)
         │           ├─ review rounds (workflow_review_rounds: round, head_sha, verdict, reviewer_task_id)
         │           ├─ attempt ledger (workflow_attempts: family ci | review_fix | conflict | migration | trunk,
         │           │                  mode mechanical | agent, bound_head_sha, trigger_reason, task_id)
         │           └─ attempt tasks (tasks.delivery_id = delivery; delivery_role review | fix | ci_fix | conflict_fix)
         └─ other tasks
```

Canonical identifiers and the adapter that reads them:

| Fact | Source | Read by |
|---|---|---|
| Which task the page is about | `tasks.id` from the URL | page |
| The deliverable an attempt belongs to | `DeliveryView.ownerTaskId`; legacy: `context.reviewerFor`, else `tasks.parentTaskId` | `taskSubjectOf` (lib/task-checks.ts) |
| This run's role | `DeliveryView.history[].role` for this task id; legacy: `context.reviewerFor` ⇒ review | `taskSubjectOf` |
| Lifecycle stage | `DeliveryView.state` / `stateReason` / `stage` | `headerLifecycle` (tasks/[id]/task-header.ts) |
| Review rounds | `DeliveryView.rounds` | `deriveTaskChecks` |
| Repairs and refreshes | `DeliveryView.ledger` | `deriveTaskChecks` |
| CI on the current head | `DeliveryView.prState` | `deriveTaskChecks` |
| A review's findings | the reviewer task's `result` (summary + `structuredOutput`) | `readableTaskResult` (lib/task-result.ts) |

A task with no kernel-owned delivery (legacy-owned, kill switch off, no PR)
keeps today's projections; the checks list is absent rather than guessed.

Cases the model handles explicitly:

- **Several deliveries / PRs for one task**: the page reads the delivery the
  loader returns for this task id (the newest kernel-owned one). Earlier PRs
  stay in Run details.
- **Superseded attempt**: `history[].superseded` keeps it in round history,
  never as the current row.
- **Cancelled or retried check**: a ledger row with status `skipped` or
  outcome `superseded` is history; only the newest row of a family on the
  current head is current.
- **External merge** (a person merged on GitHub): the delivery is `MERGED` by
  the kernel's one writer of merged; the Merge row reads Merged regardless of
  which door merged it.

## Information hierarchy (wireframe)

Phone (390px), top to bottom; desktop is the same column beside the fact sheet.

```
‹ Mission or Activity                              (compact; see §Mobile header)
[eyebrow: result heading]                         (Review of PR #N / Fix for PR #N / Result / What shipped)
<Title, ≤3 lines on a phone>                      h1, full width; "Show full title" when clipped
[● status pill]                     [↳ Ask] [⋯]    (phone: one compact row under the title;
                                                    desktop: pill and actions on the title row)
type · scope · role · workspace · PR #N ↗         (role once, never twice; release badge on a deliverable only)
Review of PR #N ›                                 (attempts only; links the deliverable; its full title
                                                    is the link's accessible name and tooltip)
✓ Build → ◐ Audit · in review → Land              (the one track, phrase per §State mapping)
[● Review approved]  <one line of cause, if any>  (compact outcome row; a card only when it carries an action)

CHECKS · PR #4413 · head e49b25b
  ✓ Code review      Approved · round 2          ›  (expands per §Code review detail)
  ◐ Tests            Checking                    ›  (expands: link to the PR's checks)
  ↻ Merge            Updating branch                (no expansion)
  ▸ Earlier rounds (1)                              (round 1 · changes requested → fix 1 of 3 completed)

[result: what changed / review summary]            (lede card or readable summary)

▸ Technical summary                                 (readable prose only, never JSON)
▸ Run details                                       (runner, turns, tokens, model, branch, worker history,
    ▸ Raw output                                     raw structured output incl. confidence, wrapped)
```

Removed from the default flow: the "Why this?" disclosure and its prose,
the decision-ledger rows (they live in the admin app), a second "Done" heading,
the release badge on an attempt, raw JSON anywhere outside Raw output.

## State mapping

One vocabulary for the track phrase, the outcome row, the Merge check and the
GitHub comment header (`DeliveryView.headline`):

| Delivery fact | Track (step · phrase) | Comment header | Merge / Code review row |
|---|---|---|---|
| `WORKING` | Build | Agent working | — |
| `AWAITING_PUSH` | Build · waiting for push | Waiting for the fix to reach GitHub | — |
| `AWAITING_REVIEW`, round queued, no reviewer claimed | Audit · awaiting review | Review queued | Code review: Awaiting review |
| `AWAITING_REVIEW`, round `reviewing` | Audit · in review | Reviewing | Code review: In review |
| `CHANGES_REQUESTED` | Audit · changes requested | Changes requested · fix queued | Code review: Changes requested |
| `FIXING` | Audit · fixing | Fixing review feedback | Code review: Changes requested, repair Fixing |
| `REPAIRING(ci)` | Audit · fixing CI | Fixing CI | Tests: Failed, repair Fix queued / Fixing |
| `REPAIRING(behind)` | Audit · updating branch | Updating branch | Merge: Updating branch |
| `REPAIRING(conflict / migration)` | Audit · resolving conflicts (or the stalled/merge-conflict headline) | same | Merge: Conflict |
| `APPROVED`, CI pending on head | Land · approved · checking | Approved · awaiting merge | Tests: Checking; Merge: Awaiting merge |
| `APPROVED` | Land · awaiting merge | Approved · awaiting merge | Merge: Awaiting merge |
| `LANDING` | Land · merging | Merging | Merge: Merging |
| `MERGED` | ✓ Land | Merged | Merge: Merged |
| `ESCALATED` | Audit · needs you | the escalation's own headline | the row the escalation names |
| `CLOSED_UNMERGED` / `ABANDONED` | Land · not landed | Closed without merging / Abandoned | Merge: Closed |
| `FAILED` | Build · failed | Failed | — |

"Repairing" is reserved for an active code repair by an agent. A branch
refresh is never a repair; a review run is never a repair.

The outcome row is the *page subject's* outcome: on a reviewer run it is the
review's verdict (Review approved / Changes requested / Escalated / Review
finished), on a deliverable it is the task verdict (lib/task-verdict.ts). The
parent's delivery stage is the track's job, so the two cannot contradict:
"Review approved" over "Land · awaiting merge" is two true facts.

"What shipped" heads the result only when the delivery is merged (or, without
a delivery, the task completed with no PR). An approved or open PR's result is
headed "Result"; a review run's is "Review of PR #N". Merged into a branch is
never described as released.

## Invariants

- The page renders at most one status row under the track. It renders no
  "Why this?" control and no `task-verdict-why` element.
- The outcome row never repeats its own label as a heading: a headline equal to
  the chip label, or starting with it, is reduced to the remainder or dropped.
- A review attempt's track and checks come from its parent delivery; its own
  completion never makes the track read Land or Merged.
- The Lifecycle track reads "repair" only for `FIXING` or an agent-mode
  `REPAIRING`; `REPAIRING(behind)` reads "updating branch".
- `DeliveryView.headline` for `REPAIRING(behind)` is "Updating branch", or
  "Waiting to update branch" while its refresh is parked in the landing lane,
  with the detail naming the PR landing on that base first
  (workflow-state-kernel §13.7). For a
  plain `APPROVED` delivery is "Approved · awaiting merge"; the GitHub comment
  header is that headline (workflow-state-kernel §12.1 rule 4).
- A structured result is never rendered as serialized JSON outside the Raw
  output disclosure. Confidence appears only there.
- An approval of a round whose `headSha` is not the delivery's current head is
  history: it renders under Earlier rounds, never as the current Code review.
- Review rounds and repair attempts are counted separately; a review round is
  never labelled a repair.
- The eyebrow names the role once: a title bracket qualifier equal to the role
  name (case-insensitive) is dropped.
- The release badge (Skip / Force release) renders only for a deliverable,
  never for a review or fix attempt.
- A looped task's chip and its Loop history count the same evaluations: a
  stopped loop (satisfied or exhausted) shows `loopIteration` itself, and only
  a running loop shows the attempt in progress (`loopIteration + 1`), both
  capped at `maxLoops`. History rows name the outcome in words ("CI passed",
  "Check failed"), the heading names the goal ("until CI passes"), and no row
  renders a worker id or a raw exit-condition type.
- The PR card never states a commit or diff count nobody recorded. When no
  attempt recorded its counters (`diffStatsRecorded`), the Added, Removed,
  Files and Commits figures are left out, and the attempt that opened the PR
  names no commit count. A recorded head SHA is not a recording, and a PR is
  never opened from zero commits, so all-zero counters read as unrecorded.
- A merged PR is stated once, on the status row: "Shipped · PR #N merged",
  its "View PR #N ↗" link, and the claim-to-merge time as the row's cause
  line. When the status row links the PR, the side panel has no PR row, and
  the PR card drops its "#N · repo · merged" header line and Claim → merge
  figure. The card draws only recorded figures (diff counters, more than one
  attempt, the diff bar), and no card at all when there are none; PR history
  stays. The status row's link is the way to the PR at every width.

## Interaction

- A check row with detail is a native disclosure (`<details>`), keyboard and
  screen-reader operable, 44px minimum target. Opening it never navigates.
- Code review detail: per §Code review detail. The verdict word is the row's
  own result; the detail adds the round and head it read, then the reviewer's
  summary as wrapping prose (paragraphs kept) or a plain account of why there
  is none, and "Open review run ›" when the reviewer task is not this page.
- A failed check's detail names the attached repair (Fix N of M · queued /
  running / completed / failed) with a link to the repair task.
- Earlier rounds is one disclosure listing rounds oldest first, each with its
  verdict and the repairs it caused.
- An attempt deep link (`/app/tasks/<attempt>`) keeps working: the page renders
  the attempt scoped, with "Review of:" / "Fix for:" naming and linking the
  deliverable, and the deliverable's track and checks with this attempt's round
  marked current.

## Mobile header

The header is the page's first screen on a phone; it must not spend it on
chrome. On a reviewer run of a PR with a long conventional-commit title the
old header wrapped the title onto about eight lines (Ask and ⋯ reserved a
column beside it), repeated the same title under "Review of", and pushed the
checks below the first screen.

- **Top spacing.** No app-owned space above the back link beyond the page
  scroller's own padding: the breadcrumb pulls up into it below `md`, the
  mission masthead keeps `mb-3` below `md`, and the header block keeps `mb-4`.
  The breadcrumb link stays a 44px target. The app does not opt into
  `viewport-fit=cover`, so the browser keeps the top inset; the bottom nav
  owns the bottom inset (`env(safe-area-inset-bottom)`), and the scroller
  reserves its height (`pb-16`).
- **Title.** `text-heading` (20px phone / 24px desktop), full available width
  below `md`. Clamped to three lines below `md`; when it is clipped a "Show
  full title" button (44px, `aria-expanded`, `aria-controls` the h1) expands it
  in place and "Show less" collapses it. Expanded, it wraps anywhere and never
  scrolls sideways. From `md` the title is unclamped and the button absent. A
  reviewer title keeps its leading `PR #N:`, so the clamp never hides which
  PR the run is about.
- **Actions.** Below `md` the status pill (only without a verdict) and Ask / ⋯
  share one row under the title, actions right-aligned, each ≥44px. They never
  sit beside the title on a phone, never stack above it. From `md` they return
  to the title row. With no status pill (a verdict carries the state) the
  mono sub-line shares that row on a phone instead of leaving the actions
  alone on it. Every link on these rows (the sub-line's and the Checks
  heading's "PR #N ↗") is a 44px target below `md`.
- **Attempt link.** "Review of PR #N ›" / "Fix for PR #N ›", naming the
  deliverable by its PR; the deliverable's full title is the link's
  accessible name (visually hidden) and tooltip. Without a PR the title is the
  reference, held to one line. The link is ≥44px below `md`.
- **One track, one outcome.** Unchanged: the delivery's track and the
  subject's outcome row per §State mapping; the header adds no second state.
- **First screen.** At 390×844 the long-title pending reviewer fixture, title
  collapsed, shows the Checks heading and the Code review and Tests rows above
  the bottom nav without scrolling. At 320 and 360 the page reads top to
  bottom with no sideways scroll.

## Code review detail

What the Code review row opens to, from `reviewDetailOf` (lib/task-checks.ts)
over the round the row reads and the reviewer task the page loaded
(lib/task-delivery-context.ts: its `result` and `status`). Every detail opens
with "Round N · head abc1234" (plus "carried to the current head after a
branch update" for a carried approval), binding what follows to that round.

| Row's round / reviewer | Detail |
|---|---|
| no round on this head (Awaiting review), or policy-skipped | none: the row is not a disclosure |
| round `queued`, reviewer task not claimed | "Review queued · no findings yet" |
| round `reviewing`, or the reviewer task claimed / running | "Review in progress · no findings yet" |
| round `decided`, reviewer left a summary | the summary as prose |
| round `decided`, reviewer row read, no summary (or no row) | "The review finished without written findings" |
| round `decided`, reviewer rows could not be read | "Couldn’t load the review’s findings" + "Try again" (reloads the page) |
| round `failed` | "The review run ended before giving a verdict" |

- A bare "This review run" is never detail. On the reviewer's own page the
  detail is the same as anywhere else, without "Open review run ›"; on any
  other page that link follows the detail.
- Missing output never reads as approval: the detail never states a verdict
  the reviewer did not write; the row's verdict is the kernel's round verdict.
- Findings belong to the current round's reviewer only. An approval on an
  earlier head is history (Earlier rounds) and its prose never appears under
  the current row.
- No timing is shown: review rounds record no start or decision time today,
  and the page does not invent one. When the kernel records one it joins the
  round line.
- Findings load with the page (one query, no client fetch), so there is no
  separate loading state; a failed read is the "Couldn’t load" row above.

## Acceptance criteria

- AC-1: GIVEN a completed reviewer task with `structuredOutput {summary, verdict: "approve", confidence: 0.8}` whose parent delivery is `APPROVED` WHEN the page renders THEN the outcome row reads "Review approved", the track reads "Land · awaiting merge", the result is headed "Review of PR #N", and no element contains "What shipped", "Why this?", "repair 1" or the literal `"confidence"` outside Raw output.
- AC-2: GIVEN a delivery `REPAIRING` with `stateReason` `behind` WHEN `deriveDeliveryView` runs THEN `headline` is "Updating branch", and `headerLifecycle` returns step Audit with phrase "updating branch" and not state `fixing`.
- AC-3: GIVEN a delivery `REPAIRING` with `stateReason` `ci` and an agent `ci` attempt running WHEN checks are derived THEN the Tests row is Failed with an attached repair reading Fixing and the repair task link.
- AC-4: GIVEN a delivery `MERGED` WHEN checks are derived THEN the Merge row reads Merged; GIVEN `APPROVED` it reads Awaiting merge and never Merged.
- AC-5: GIVEN rounds 1 (`request_changes`, head A) and 2 (`approve`, current head B) WHEN checks are derived THEN the current Code review reads Approved · round 2 and round 1 appears only under history with its review_fix repair.
- AC-6: GIVEN an approved round on head A while the delivery's current head is B and no round exists for B WHEN checks are derived THEN Code review reads Awaiting review and the approval is history.
- AC-7: GIVEN a summary string that is valid JSON with a `summary` field WHEN `readableTaskResult` reads it THEN prose is the `summary` text and the verdict is normalised; GIVEN malformed JSON THEN prose is the original text and `malformed` is true; GIVEN plain text THEN prose is that text.
- AC-8: GIVEN a verdict whose headline equals its label ("Done") WHEN the outcome row renders THEN the label appears once and no `h2` heading repeats it.
- AC-9: GIVEN a reviewer task titled "[reviewer] PR #N: …" with role name "Reviewer" WHEN `taskHeading` runs THEN the eyebrow contains "Reviewer" exactly once.
- AC-10: GIVEN no kernel-owned delivery, or a delivery with no PR, WHEN the page renders THEN no checks list is drawn (no invented rows).
- AC-11: GIVEN a `pr_checks_green` loop satisfied on its 2nd evaluation (`loopIteration` 2, `maxLoops` 3, two history rows) WHEN the chip and Loop history render THEN the chip reads "LOOP SATISFIED · 2/3", the list shows two iterations, and no full UUID or `pr_checks_green` appears.
- AC-12: GIVEN a completed task whose PR merged with no recorded diff counters and one attempt WHEN the page renders THEN the status row reads "Shipped · PR #N merged" with the claim-to-merge time and a "View PR #N" link, the side panel has no PR row, no element repeats "#N · repo · merged", no Claim → merge figure is drawn, and PR history is still shown.
- AC-13: GIVEN the reviewer run's own page, round 1 `queued` on the current head and the reviewer task `pending` WHEN the checks render THEN Code review is a disclosure opening to "Round 1 · head <sha7>" and "Review queued · no findings yet", with no "This review run" and no link to the page itself; with the reviewer task `in_progress` (or the round `reviewing`) it reads "Review in progress · no findings yet" and states no start time.
- AC-14: GIVEN the reviewer's own page and a `decided` round whose reviewer left a summary WHEN the row opens THEN the summary renders as prose and no "Open review run" link is drawn; GIVEN another page THEN the same detail is followed by a 44px "Open review run ›".
- AC-15: GIVEN a `decided` round whose reviewer left no summary WHEN the row opens THEN it reads "The review finished without written findings" and the detail contains no "approv…"; GIVEN the reviewer rows could not be read THEN it reads "Couldn’t load the review’s findings" with a 44px "Try again".
- AC-16: GIVEN an approval with findings on head A and a current head B with no round WHEN the checks render THEN Code review reads Awaiting review, is not a disclosure, and none of head A's prose appears in it; the approval is under Earlier rounds.
- AC-17: GIVEN a title longer than three phone lines WHEN the header renders below `md` THEN the h1 is `text-heading`, spans the full width, is clamped to three lines with a 44px "Show full title" (`aria-expanded=false`) that expands it in place and "Show less" that collapses it; Ask and ⋯ sit on the row under the title, never beside it.
- AC-18: GIVEN a review attempt of a deliverable with PR #N WHEN the header renders THEN the attempt link reads "Review of PR #N ›" and the deliverable's full title is in its accessible name and tooltip, not its visible text.

## Code surface

- `apps/web/src/app/app/(protected)/tasks/[id]/page.tsx` — composition.
- `apps/web/src/app/app/(protected)/tasks/[id]/TaskVerdictBlock.tsx` — the compact outcome row.
- `apps/web/src/app/app/(protected)/tasks/[id]/task-header.ts` — `taskHeading`, `headerLifecycle`.
- `apps/web/src/components/ui/Lifecycle.tsx` — the track; `phrase` prop.
- `apps/web/src/lib/task-checks.ts` — `deriveTaskChecks`, `taskSubjectOf`.
- `apps/web/src/app/app/(protected)/tasks/[id]/TaskChecks.tsx` — the checks list; `reviewDetailOf` (lib/task-checks.ts) decides what Code review opens to.
- `apps/web/src/lib/task-delivery-context.ts` — the delivery view, deliverable title and each reviewer's findings and status, in one load.
- `apps/web/src/app/app/(protected)/tasks/[id]/TaskTitle.tsx` — the clamped h1 and its "Show full title" toggle.
- `apps/web/src/app/app/(protected)/tasks/[id]/TaskSubjectLink.tsx` — "Review of PR #N ›" / "Fix for PR #N ›".
- `apps/web/src/lib/task-result.ts` — `readableTaskResult`.
- `apps/web/src/app/app/(protected)/tasks/[id]/TaskShippedHeader.tsx` — result heading, Technical summary, Run details and Raw output.
- `apps/web/src/lib/task-verdict.ts` — the review-attempt outcome rule.
- `apps/web/src/lib/workflow/projections.ts` — `deriveDeliveryView` headlines, `rounds` and `ledger` on the view.
- `apps/web/src/components/LoopStatus.tsx` — loop chip (`loopAttemptShown`) and Loop history.
- `apps/web/src/components/task/PrCard.tsx` — the PR card; `statedAbove` drops what the status row already says.

## Regression cases (visual)

Fixture: `/app/dev/fixtures?state=task-page&case=<case>` (illustrative data,
dev/fixtures/task-page-fixtures.ts), header laid out like the page's.

Each at 390px and desktop: reviewer queued with a long PR title
(`review-pending`, the default case); reviewer approved with parent open;
branch refresh; actual CI repair running; merged; failed task; escalation
needing a person. `review-pending` also at 390×844 (title collapsed: Checks,
Code review and Tests above the bottom nav), 320 and 360 wide, light and dark,
with the title expanded and with Code review opened.
No Why this, no duplicated Done, no "Repairing" for a refresh, no "What
shipped" before a merge, no "This review run" as detail, no horizontal scroll
in Raw output or at 320px.

## Out of scope

- Visual review rows: no visual-review fact is bound to a delivery's head
  today, so the checks list draws none rather than invent one. When the
  kernel records one, it becomes a row.
- Per-job CI rows: the kernel records CI per head, not per job. The Tests row
  links to the PR's checks; per-job detail stays on the PR card.
- Home and the activity list read `deliveryReading` (workflow/delivery-display.ts);
  they already share `DeliveryView`, and their wording is the Home cleanup's.
