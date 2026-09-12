---
title: Action Queue Card State
status: active
owner: max
last_verified: 2026-09-12
summary: An action card on Home's "Waiting on You" queue MUST render from server state (the PR, the stored reviewer verdict, and any dispatched task's live status), never from state a click set and the server never confirmed.
domain: surfaces
surfaces: [apps/web/src/lib/action-queue.ts, apps/web/src/components/WaitingOnYouReviewCard.tsx, apps/web/src/lib/pr-review-status.ts, apps/web/src/app/app/(protected)/home/page.tsx]
related: [surface-ia-home-missions-initiatives, pr-lifecycle-reconciliation]
keywords: [WaitingOnYouReviewCard, WaitingOnYouMergeCard, conflict_dispatched, reviewerVerdict, approvalStale, optimistic UI, router.refresh, HomeAutoRefresh, stale local state]
verified_by: [apps/web/src/components/WaitingOnYouReviewCard.test.tsx, apps/web/src/lib/action-queue.test.ts, apps/web/src/lib/pr-review-status.test.ts]
assertions:
  - id: reviewer-verdict-banner
    type: symbol
    name: ReviewerVerdictBanner
    path: apps/web/src/components/ReviewerVerdictBanner.tsx
  - id: derive-pr-review-status
    type: symbol
    name: derivePrReviewStatus
    path: apps/web/src/lib/pr-review-status.ts
  - id: build-action-queue
    type: symbol
    name: buildActionQueue
    path: apps/web/src/lib/action-queue.ts
  - id: reviewer-verdict-banner-reachable
    type: symbol_reachable
    symbol: ReviewerVerdictBanner
    entry: apps/web/src/components/WaitingOnYouReviewCard.tsx
  - id: card-test
    type: test_file
    path: apps/web/src/components/WaitingOnYouReviewCard.test.tsx
  - id: action-queue-test
    type: test_file
    path: apps/web/src/lib/action-queue.test.ts
  - id: pr-review-status-test
    type: test_file
    path: apps/web/src/lib/pr-review-status.test.ts
supersedes: []
---

## Capability statement

Every mutating action card on Home's action queue MUST derive what it renders
from server-computed state — the PR's current lifecycle, the reviewer's stored
verdict, and any dispatched follow-up task's live status — for as long as it
remains mounted. A client `useState` local to the card may drive **optimistic**
UI for the instant between a click and the fetch response it triggered, and
never past the point where fresh server-derived props are available.

## Why this exists

This is the third occurrence of the same defect shape on this codebase: a card
composes what it shows from the *dispatch event* of a button click, stores that
in local `useState`, and never rejoins live state afterward. Once dispatched,
the card is wrong forever — it can't reflect a retry finishing, a verdict that
was there all along, or the PR simply merging — regardless of how many times
the surrounding page re-renders with corrected data. It was fixed once in
`CondensedTimeline`'s reviewer-retry chip (joining the retry task by
`parentTaskId` and rendering its live `status`), and a second time is exactly
the bug this spec closes: an approved PR whose head advances (typically via a
same-branch conflict-resolution retry) went invisible on `get_pr_review` was
skipped — the verdict, GitHub-review-post status, and the retry's own progress.

## Invariants

### I-1: Local state never outlives the click

A card's `useState` MUST NOT be the sole source of truth for anything that
describes an outcome across renders (a dispatched retry, a completed merge, an
exhausted retry budget). Such states live in a separate `optimistic` value that
is cleared unconditionally — via a `useEffect` keyed on the server-derived prop
— the moment new props arrive. Local state that drives pure navigation within
the card (e.g. "corrections text box is open") is exempt: it makes no claim
about server truth and MUST NOT be reset by a background refresh, or a human
mid-edit loses their input.

### I-2: An approved verdict always renders

Whenever `ActionQueueItem.reviewerVerdict` is present, the card (`REVIEW` or
`RESOLVING` chip alike) MUST render it — reviewer verdict, confidence, one-line
summary, and (for an approve) the SHA it was made against — regardless of the
card's transient `state`/`optimistic` value. A verdict must never disappear
because a conflict retry is (or was) in flight.

### I-3: Staleness is stated, not hidden

When the verdict's `approvedSha` no longer matches the PR's current head (a
conflict retry pushed commits after the approval — see `approvalStale` in
`action-queue.ts`), the card MUST say so explicitly ("approved at `<sha>`, N
commits since") rather than silently showing a stale approve, or dropping it
and reading as unreviewed.

### I-4: One status vocabulary

Card-facing reviewer status MUST come from `derivePrReviewStatus`
(`pr-review-status.ts`) — the same derivation `get_pr_review` uses — not a
second, surface-local parsing of mission-note prose. `ActionQueueItem`'s
`reviewerVerdict`/`approvalStale` fields carry that shape through to the
client; nothing downstream re-derives verdict/confidence from text.

### I-5: A verdict recorded here is not proof it reached GitHub

`postPrReview`'s outcome (`githubReviewPosted`/`githubReviewPostError`) is
persisted onto the reviewer task's own `context`, independent of `missionId` —
a mission-less task's failed post is not allowed to be invisible. Both
`get_pr_review` and the card surface `postedToGithub === false` explicitly
(`ReviewerVerdictSummary.postedToGithub`); a terminal approve in buildd's store
MUST NOT be presented as done when GitHub shows no review at all.

## Acceptance criteria

- AC-1: GIVEN a reviewer task completes with an approve verdict WHEN the PR's
  head has advanced since the reviewer task was dispatched (a push landed
  first) THEN `postPrReview` is called against the PR's current head SHA, not
  the frozen dispatch-time SHA, and posts exactly once.
- AC-2: GIVEN a review was already posted for a given (PR, head SHA, state)
  WHEN the same verdict is reached again (forced re-review) THEN no duplicate
  GitHub review is posted.
- AC-3: GIVEN a card renders a terminal approve AND a dispatched conflict retry
  THEN the card shows the verdict banner AND the retry's live status
  simultaneously — never blank, never one hiding the other.
- AC-4: GIVEN a card's stored verdict's `approvedSha` differs from the PR's
  current head THEN the card renders the approve with an explicit staleness
  qualifier, not silently or as unreviewed.
- AC-5: GIVEN the exact regression shape (terminal approve, confidence above
  threshold, CI green, mergeable, head advanced by a conflict retry) THEN the
  verdict is visible both on GitHub (a real review exists) and on the card.

## Known gap — not fixed here

`WaitingOnYouMergeCard.tsx` has the same defect shape (I-1) for its
`conflict_dispatched`/`conflict_exhausted`/`error` states — audited during this
capability's introduction, tracked as separate follow-up work, not fixed in
this change. `SwipeableRow`'s snooze/file-anyway/ignore actions on a
`gate-card` are a related but distinct defect: those actions never reach the
server at all (no persistence), so a snoozed card can reappear having never
actually been snoozed anywhere the server knows about — also out of scope
here.

## Code surface

- `apps/web/src/components/WaitingOnYouReviewCard.tsx` — the card this spec was
  written against; `optimistic` overlay pattern (I-1).
- `apps/web/src/components/ReviewerVerdictBanner.tsx` — shared verdict
  rendering (I-2, I-3), used by both the client card and the server-rendered
  `RESOLVING` block on Home.
- `apps/web/src/lib/action-queue.ts` — `ReviewerVerdictSummary`,
  `ApprovalStaleness`, carried through `EscalationRawItem` → `ActionQueueItem`.
- `apps/web/src/lib/pr-review-status.ts` — `derivePrReviewStatus` (I-4),
  `postedToGithub`/`postError`/`approvedSha` fields (I-5).
- `apps/web/src/app/api/workers/[id]/route.ts` —
  `handleReviewerOutcomeIfNeeded`; re-fetches the PR head before posting
  (AC-1), persists the post outcome unconditionally (I-5).
- `packages/core/mcp-tools.ts` — `get_pr_review` text surfaces
  `postedToGithub === false` (I-5).
