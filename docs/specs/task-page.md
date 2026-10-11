---
title: Task Page
status: active
owner: max
last_verified: 2026-10-11
summary: The task page MUST lead with the deliverable, its Build → Audit → Land track and one compact outcome, list checks by review round from delivery facts, and frame a review or fix run as an attempt of its parent.
domain: surfaces
surfaces: [apps/web/src/app/app/(protected)/tasks/[id]/page.tsx, apps/web/src/lib/task-checks.ts, apps/web/src/lib/review-result.ts, apps/web/src/lib/workflow/projections.ts]
related: [workflow-state-kernel, mission-task-lifecycle, surface-ia-home-missions-initiatives]
keywords: [task detail, what shipped, why this, verdict block, review approved, updating branch, awaiting merge, repair 1, checks list, review round, attempt, reviewer task, fix attempt, structured output, technical summary, raw output, lifecycle track]
verified_by: [apps/web/src/lib/task-checks.test.ts, apps/web/src/lib/review-result.test.ts, apps/web/src/app/app/(protected)/tasks/[id]/task-header.test.ts, apps/web/src/app/app/(protected)/tasks/[id]/TaskVerdictBlock.test.tsx, apps/web/src/lib/workflow/projections.test.ts, apps/web/src/lib/task-verdict.test.ts]
supersedes: []
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
| A review's findings | the reviewer task's `result` (summary + `structuredOutput`) | `readableTaskResult` (lib/review-result.ts) |

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
‹ Mission or Activity
[eyebrow: result heading]                         (Review of PR #N / Fix for PR #N / Result / What shipped)
<Title>                                           h1
type · scope · role · workspace · PR #N ↗         (role once, never twice; release badge on a deliverable only)
Review of <deliverable title> ›                   (attempts only; the link is the deliverable)
✓ Build → ◐ Audit · in review → Land              (the one track, phrase per §State mapping)
[● Review approved]  <one line of cause, if any>  (compact outcome row; a card only when it carries an action)

CHECKS · PR #4413 · head e49b25b
  ✓ Code review      Approved · round 2          ›  (expands: verdict, summary prose, findings, review run link)
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
- `DeliveryView.headline` for `REPAIRING(behind)` is "Updating branch" and for a
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

## Interaction

- A check row with detail is a native disclosure (`<details>`), keyboard and
  screen-reader operable, 44px minimum target. Opening it never navigates.
- Code review detail: verdict word, the reviewer's summary as wrapping prose
  (paragraphs kept), and "Open review run ›" to the reviewer task.
- A failed check's detail names the attached repair (Fix N of M · queued /
  running / completed / failed) with a link to the repair task.
- Earlier rounds is one disclosure listing rounds oldest first, each with its
  verdict and the repairs it caused.
- An attempt deep link (`/app/tasks/<attempt>`) keeps working: the page renders
  the attempt scoped, with "Review of:" / "Fix for:" naming and linking the
  deliverable, and the deliverable's track and checks with this attempt's round
  marked current.

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

## Code surface

- `apps/web/src/app/app/(protected)/tasks/[id]/page.tsx` — composition.
- `apps/web/src/app/app/(protected)/tasks/[id]/TaskVerdictBlock.tsx` — the compact outcome row.
- `apps/web/src/app/app/(protected)/tasks/[id]/task-header.ts` — `taskHeading`, `headerLifecycle`.
- `apps/web/src/components/ui/Lifecycle.tsx` — the track; `phrase` prop.
- `apps/web/src/lib/task-checks.ts` — `deriveTaskChecks`, `taskSubjectOf`.
- `apps/web/src/app/app/(protected)/tasks/[id]/TaskChecks.tsx` — the checks list.
- `apps/web/src/lib/review-result.ts` — `readableTaskResult`.
- `apps/web/src/app/app/(protected)/tasks/[id]/TaskShippedHeader.tsx` — result heading, Technical summary, Run details and Raw output.
- `apps/web/src/lib/task-verdict.ts` — the review-attempt outcome rule.
- `apps/web/src/lib/workflow/projections.ts` — `deriveDeliveryView` headlines, `rounds` and `ledger` on the view.

## Regression cases (visual)

Each at 390px and desktop: reviewer approved with parent open; branch refresh;
actual CI repair running; merged; failed task; escalation needing a person.
No Why this, no duplicated Done, no "Repairing" for a refresh, no "What
shipped" before a merge, no horizontal scroll in Raw output.

## Out of scope

- Visual review rows: no visual-review fact is bound to a delivery's head
  today, so the checks list draws none rather than invent one. When the
  kernel records one, it becomes a row.
- Per-job CI rows: the kernel records CI per head, not per job. The Tests row
  links to the PR's checks; per-job detail stays on the PR card.
- Home and the activity list read `deliveryReading` (workflow/delivery-display.ts);
  they already share `DeliveryView`, and their wording is the Home cleanup's.
