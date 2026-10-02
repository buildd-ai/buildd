# Mission "What shipped" header

**Status:** Proposed
**Related:** `packages/shared/src/planning.ts` (`planningOutputSchema`),
`apps/web/src/lib/mission-loop.ts`, `apps/web/src/lib/mission-evaluation.ts`,
`apps/web/src/lib/mission-completion.ts` (`completeMissionIfVerified`),
`apps/web/src/lib/mission-helpers.ts` (`selectMissionCompletionSummary`),
`apps/web/src/lib/mission-completion-record.ts`, `apps/web/src/lib/mission-context.ts`,
`apps/web/src/lib/visual-audit-evidence.ts`, `apps/web/src/lib/visual-review-query.ts`,
`apps/web/src/lib/auto-merge.ts`, `apps/web/src/app/api/workers/[id]/route.ts`,
`apps/web/src/app/api/missions/[id]/route.ts`,
`apps/web/src/app/app/(protected)/missions/[id]/page.tsx`,
`apps/web/src/app/app/(protected)/missions/[id]/MissionDescription.tsx`,
`apps/web/src/app/app/(protected)/home/NeedsYouStack.tsx`,
`apps/web/src/app/app/(protected)/home/page.tsx`,
`packages/core/pr-lede.ts`, `packages/core/surface-audit.ts`, `packages/core/path-overlap.ts`,
`packages/shared/src/types.ts` (`TaskHandoff`), `docs/design/DESIGN-FORMAT.md`,
`docs/design/mission-task-handoff.md`, `docs/design/visual-qa-auditor.md`,
`docs/specs/mission-task-lifecycle.md`

## Problem

A completed mission gives its owner no plain-language answer to **"what changed for
me?"**, and no screenshots when the change was visual.

The trigger case was a weekly mobile audit mission that finished four of four green. The
page said "completed" with a full progress bar. Its closeout artifact read like a
changelog, in class names and component props. Its description, the only other prose on
the page, was a collapsed spec-style wall of text (`MissionDescription.tsx` folds anything
over four lines behind "Show more"). The mission ran no visual audit, and nothing on the
page said so. To find out whether the phone now looked right, the owner had to open pull
requests.

### Why today's closeouts fail the cold-read test

The test: someone who has never seen the mission reads only the closeout text for ten
seconds. Can they say what is different for users, and whether anyone looked? Three recent
closeout artifacts (anonymised, identifiers trimmed):

1. **The mobile audit mission.** "Fixed mobile layout issue with `ProviderOnboardingCard`
   pushing Needs You content below the fold. Changes: added `hasActionableWork` prop …;
   reduced mobile padding from `pb-16`/`mb-8` to `pb-8`/`mb-6` …". The first clause names
   the user's problem, then it becomes a diff summary. No screenshot. **Fails:**
   implementation vocabulary, and no evidence it was checked.
2. **A component-kit mission.** The artifact holds the last surface-audit task's summary:
   "Round 2 re-check of a dev route: 24 shots (8 fixture states across three widths) …".
   It describes an audit round, not the mission. The shots exist and do not lead.
   **Fails:** wrong subject; the evidence is present but buried.
3. **A security-hardening mission.** The artifact is raw handoff JSON:
   `### handoff {"delivered": "Pre-release hardening merged; follow-up: … check …"}`.
   **Fails:** not plain language, nothing said about what changed for anyone, and the
   follow-up (a departure from done) is one clause inside a JSON string.

Why these are what they are: the artifact in all three is the `mission-<missionId>`
"— Latest" artifact, which the `auto-artifact` step in
`apps/web/src/app/api/workers/[id]/route.ts` upserts on **every** non-heartbeat mission
task completion. The last writer wins, including review and audit tasks and tasks that
finish after the mission closes. It was never a closeout; it is a side effect of a task
finishing, written by an agent thinking about its own task. Meanwhile the mission-level
text that does exist, D3 (`selectMissionCompletionSummary`), only *selects* prose written
for another purpose: the evaluation task's summary, an orchestrator summary, or the system
"Mission completed" note. A hand-completed mission gets none.

## Proposal

The agent that already proposes completion also writes the owner-facing answer, in the
output it already returns. The server adds the parts that must not be the model's word
(change type, which screenshots exist), stores the result, and the completed mission page
leads with it.

**The crux: reuse the existing completion author; add no agent and no parallel path.**
Two authors already propose completion and both call `completeMissionIfVerified` with
`proposed: true`: the planning task whose structured output sets `missionComplete: true`
(`mission-loop.ts`, path `agent_signal`), and the completion-evaluation task whose verdict
is `complete` (`handleEvaluationResult`, path `evaluation_task`). Each already has the
mission description and its tasks' results in its prompt, which is what "did the work
differ from the description?" needs, so the extra output costs one instruction, not a
system. The report is taken from whichever proposal *wins* the atomic completion claim,
never from a proposal the platform refused.

### Output contract

One optional object, `shipped`, added to **both** output schemas from a single shared
definition: `planningOutputSchema` in `packages/shared/src/planning.ts` (with
`PlanningStructuredOutput`) and `EVALUATION_OUTPUT_SCHEMA` in `mission-evaluation.ts`.
Optional, so existing tasks and schemas behave exactly as before.

```ts
shipped?: {
  lede: string;          // 1-2 plain sentences: what changed for the user
  heroShots?: string[];  // surface-audit screenshot artifact ids, only when any exist
  offPlan?: string[];    // at most 2 lines; ONLY when delivered work materially differs
                         // from the description (a scope cut, or done differently)
}
```

**What the model writes:** `lede`, `offPlan`, and a *nomination* of `heroShots`.

**What the server owns:**

- **`changeType`** (`frontend | backend | both | null`) is computed from the delivered PR
  diffs, never written by the model. For each merged PR of the mission's deliverable
  tasks, list its files through the same PR-files endpoint the reviewer and auto-merge
  already call (`apps/web/src/lib/auto-merge.ts`). `frontend` if any path satisfies
  `isUiSurfacePath` (`packages/core/surface-audit.ts`: `apps/web/src/app/` and
  `apps/web/src/components/`, excluding `apps/web/src/app/api/`); `backend` if the
  changed code is all non-UI; `both` if both; `null` (no chip) for docs-only, research, or
  no-code missions. If the files cannot be fetched, fall back to the tasks' declared
  `pathManifest`, ignoring the `['**']` "scope undeclared" sentinel
  (`isAdvisoryManifest`, `packages/core/path-overlap.ts`).
- **Hero shots.** The pool is the latest audit run's screenshots
  (`loadVisualAuditEvidence`, `missionVisualShotsWhere`) whose `metadata.qa.verdict` is not
  `issue`. Nominated ids are kept only if they are in the pool. If none survive, the server
  picks deterministically: mobile first, then desktop, at most 3. The pool is read **when
  the claim is won**, not when the author ran, so a shot added by a late audit round is
  still found. A mission with no audit has an empty pool.
- **Lede check.** A mechanical filter, not a judge: at most 240 characters
  (`LEDE_MAX_CHARS`), and none of a path, a backticked token, `#\d+`, or a UUID/hex run.
  A lede that fails is **not shown** (see Fallbacks). No refusal, no retry loop.
- **`offPlan`** is trimmed to 2 lines of at most 160 characters each.

**Stored record** (illustrative):

```ts
{ version: 1, lede: string | null, changeType, heroShots: Array<{ artifactId, route, viewport, verdict }>,
  offPlan: string[], authorTaskId: string | null, origin: 'author' | 'no_author' | 'manual',
  completedAt: string }
```

### The prompt

Appended to the two completion-proposing tasks' instructions (the planning output
requirement in `apps/runner/src/prompt-builder.ts` when `missionComplete` is being set,
and the evaluation prompt in `buildEvaluationContext`), and described once in the schema's
field descriptions. The text is built on the PR lede rules (`LEDE_FIELD_SPEC`,
`packages/core/pr-lede.ts`), relaxed to one or two sentences:

```text
When you set missionComplete (or return verdict "complete"), also fill `shipped`.

`shipped.lede`: ONE or TWO plain sentences for the person who asked for this mission and
has not read any of its pull requests: what is different for them now, and if the change
was visual, whether anyone looked at it. Say it the way you would say it out loud to a
colleague. No file paths, route or endpoint names, symbol or function names, class names,
PR numbers, or internal vocabulary (task, handoff, criterion, cycle). Do not list what each
task did; say what the whole mission changed. Max 240 characters.

`shipped.heroShots`: only if screenshots are listed below, up to 3 ids of the ones that
best show the change. Otherwise omit it.

`shipped.offPlan`: OMIT THIS unless the delivered work materially differs from the mission
description: something was cut, or something was done a different way than described.
Then at most 2 short plain lines, each saying what differs and why. A retry, a conflict or
CI fix, a rename, or a different implementation with no effect on the outcome is not
off-plan. When unsure, omit it.

BAD:  "Fixed mobile layout issue with ProviderOnboardingCard pushing Needs You content
       below the fold. Added hasActionableWork prop and reduced mobile padding from
       pb-16 to pb-8."
      (A commit message: component, prop, classes. Nothing says how the phone looks now.)
BAD:  "Root cause: the after-CI fix task for a release PR was an attempt whose parent was
       the adopted release task, so closeAncestorRetryPrs treated it as an earlier
       attempt. Added isEarlierAttemptPr; 8 new tests."
      (A reviewer's narrative: root cause, symbols, test counts. The outcome for the
       owner is never stated.)
GOOD: "On a phone, the home screen now opens on what needs you instead of a setup card
       that pushed it below the fold. Checked at phone and desktop width."
GOOD: "Release pull requests are no longer closed by mistake when a follow-up fix fails.
       One planned cleanup was dropped."
```

Both BAD examples are from real closeouts (identifiers as written). The GOOD ones say the
same changes the way a person would, carry one verifiable claim, and end on an honest
clause (what was checked, what was dropped).

The planning prompt already lists completed tasks as `[handoff]` or `[summary]` lines
(`buildMissionContext`, `mission-context.ts`, preferring `handoff.delivered`); the
evaluation prompt reads `result.summary` only. The build should give the evaluation path
the same handoff-preferring read, and both should skip a summary whose `summarySource` is
`fallback` (the runner's end-of-session capture, never an outcome).

### Storage

An `artifacts` row with unique key `mission-shipped-<missionId>` (the `(workspaceId, key)`
unique index makes the write an idempotent upsert), `type: 'report'`, `missionId` set,
`metadata.kind = 'mission_shipped_report'`, the stored record in `metadata.shipped`, and a
short markdown render in `content` for knowledge readers. **No migration.** It is a
different key from the `mission-<id>` "— Latest" artifact, which the report never reads and
which is left alone.

It is written by the claim winner in `completeMissionIfVerified`, beside the flight-strip
cache, fire-and-forget: a failure cannot un-complete the mission, and the page falls back
(below). The winner receives the author task id as a new optional argument on the two
proposing call sites; the function reads that task's `structuredOutput.shipped`.

**Why an artifact and not a `missions` column:** the hot `missions` row stays narrow, and
no migration is needed. The cost is one keyed artifact read per completed mission page.

**Reopening.** If a mission is reopened, the record's `completedAt` no longer equals
`missions.completedAt`; surfaces ignore the stale record and the next completion
overwrites it.

**Sensitive workspaces** (`dataClass === 'sensitive'`) store no prose: `lede` and
`offPlan` are dropped, and only `changeType` and screenshot ids are kept.

### Surface

**Mission page.** When the mission is completed and a current record exists, a header
sits at the top of the page, in place of the D3 completion text, with
`id="what-shipped"`:

1. The **lede**, in larger type than body text.
2. The **change type** as a small chip (hidden when `null`).
3. Up to 3 **hero shots**. Each opens the existing review deck
   (`VisualReviewDeck`, via `useMissionVisualReview().openDeck`); the old read-only
   lightbox was retired, so the deck is the one full-size viewer. Shots are served from
   `/api/artifacts/:id/download`.
4. **`offPlan`**, only if present, as one or two lines under a quiet "Off plan" label.

The task detail, goal criteria and collapsed description stay below, unchanged. The
description is not moved: the header simply gives the owner the answer before it.

**Home.** The `ShippedCard` "Read summary" link (`NeedsYouStack.tsx`) targets
`<mission>#what-shipped`, so "learn more" lands on this header. The card otherwise stays
as it is; no new stack or motion.

**Task page.** A completed task leads with the same answer, one task wide. A task
that must open a PR is asked (`taskShippedPromptText`, `packages/shared/src/shipped.ts`)
to return `shipped: { lede, offPlan? }` in its `complete_task` output. After completion
the server checks the lede with the same filter, computes the change type from that
task's PR files (manifest fallback), and merges the record into `tasks.result.shipped`
(`apps/web/src/lib/task-shipped-store.ts`). No hero-shot nomination: the page shows
the task's own audit screenshots. The page (`tasks/[id]/task-shipped-header.ts`) shows,
in order: the eyebrow "What shipped · type", the plain title, status chips; the lede
card with the change type in plain words ("On screen" / "Behind the scenes"); one
full-width "Your move" action with the checks and the PR number under it; matched
errors as a quiet "One hiccup, already handled" row; then the raw handoff behind a
collapsed "Technical summary", and "Run details". With no lede, the title stands
alone and the handoff stays behind its disclosure. It never becomes the headline.

### Fallbacks

The header is additive. Every case below degrades to what the page renders today, with the
mechanical facts we do know, and never invents prose.

| Case | Behaviour |
|---|---|
| **No shots** | Lede and change type still show. If `changeType` includes `frontend`, the header says, factually, "No screenshots were captured for this change." It does not imply a check that did not happen. |
| **Author missing** (completed by dormancy, `criteria_eval`, or heartbeat, none of which has a proposing author; or the author returned no `shipped`) | No lede. The header shows only the mechanical facts (change type, shots, "Completed by hand" where true) above the D3 completion text as today. If there are no facts to show, no header. |
| **Fallback-only author** (the session ended without structured output; the runner captured last-message text, `summarySource: 'fallback'`) | Treated as author missing. Fallback text is never used as the lede, the same filter D3's `authoredSummary` applies. |
| **Completed by hand** (dashboard or MCP `manage_missions` status=completed, `missions/[id]/route.ts`) | The route calls the same store function with `authorTaskId: null`, `origin: 'manual'`. Mechanical facts are computed; no lede. Labelled "Completed by hand". Criteria not all passing are already shown by the existing criteria block. |
| **Lede fails the check** | Treated as author missing. The failure is logged; it does not block completion. |
| **PR files unavailable** | `changeType` from declared manifests; if those are sentinel-only, `null`. |
| **Mission reopened** | Stale record ignored until the next completion. |

Not backfilled: missions that completed before this ships keep their current page.

### Safety bounds

- **No new agent run and no retry loop.** The only added model output is one optional
  field in a task that was already running.
- **The store never blocks completion.** It runs after the atomic claim, fire-and-forget,
  exactly like the flight-strip cache.
- **One artifact write per completion** (idempotent upsert by key).
- **PR-file fetches are bounded:** at most 20 PRs per mission, one page of 300 files each,
  a short timeout, and a failure falls back to manifests.
- **The model can only select, not assert:** shot ids must be in the server's pool, and
  `changeType` is never read from model output.
- **Default is a no-op:** `shipped` is optional in both schemas, and until a record exists
  every surface renders exactly as it does now.

## Current state

- `completeMissionIfVerified` is the single automated writer of `status='completed'`; its
  claim winner runs `computeAndStoreFlightStripCache`, posts the "Mission completed" note,
  unblocks dependents, and attempts release. Human completions skip it
  (`missions/[id]/route.ts`).
- `planningOutputSchema` has `summary` and `missionComplete` and no owner-facing field.
  `EVALUATION_OUTPUT_SCHEMA` is a verdict schema (verdict, confidence, rationale).
- The evaluation task is spawned from the mission loop only, before the mission closes; the
  planning-task proposal is the common path.
- The mission page reads only `summary`, `summarySource` and `reaperAutoCompleted` from
  task results, and feeds the D3 pick to the board as `completionText`.
- Surface-audit screenshots are artifacts with `metadata.qa`
  (`{runKey, route, viewport, finding, verdict, …}`). When an audit task exists it is a
  work-class deliverable (`mission-surface-audit.ts`), so completion is held until it
  finishes; but an audit is only spawned for a UI mission that gets one, and the mobile
  trigger case never did.
- `ShippedCard` counts PRs, fixes, duration and screens for one recently completed
  mission and links to it.

## Open questions

- **Completions with no author (dormancy, criteria evaluator, heartbeat, by hand) get no
  lede. Is that acceptable?** *Lean: yes for now.* Spawning an author for them is the new
  agent and parallel path this design avoids; the heartbeat's schema is operational-only on
  purpose (`HEARTBEAT_OUTPUT_SCHEMA`). Measure how many completions land on these paths
  once the header ships, and revisit only if it is a large share.
- **Do shots exist when the author writes?** Only if an audit was spawned: an existing
  audit task holds completion until it finishes, but a UI mission with no audit has none,
  and a late fix round can add shots after the author ran. *Lean: the server resolves shots
  at claim time (above), and the sibling gate that makes the audit mandatory for UI
  missions is what makes screenshots reliably present.* This design depends on that gate
  for coverage, not for correctness: no shots renders the factual "No screenshots" line.
- **Should a failed lede check retry the author?** *Lean: no.* A loop costs an agent run
  to fix a cosmetic problem; dropping to the fallback is honest and bounded.
- **Is the model's "materially differs" judgment good enough for `offPlan`?** *Lean:
  accept some noise.* The instruction says to omit when unsure, and the cap is two lines,
  so the worst case is a slightly over-cautious line, never a wall of deviations.

## Non-goals

- A structured planned-versus-shipped system: entry kinds, evidence schemas, mechanical
  diffs of planned against delivered tasks.
- `spec_discrepancies` integration.
- Stacked, expandable or animated home cards, or any new motion.
- The surface-audit gate (a separate sibling task).
- A new agent, a dedicated closeout task, or a second completion path.
- Backfilling missions that completed before this ships.
- Changing how completion is decided, or fixing the "— Latest" artifact's
  overwrite-after-close behaviour (a real defect, separate and small).

## Build breakdown

Two tasks. Neither should start until this design is merged.

1. **Author contract and prompt.** Add the shared optional `shipped` definition to
   `planningOutputSchema` / `PlanningStructuredOutput` and `EVALUATION_OUTPUT_SCHEMA`; add
   the prompt text above to the planning output requirement and the evaluation prompt;
   give the evaluation prompt the handoff-preferring, fallback-skipping task read. Add the
   author-task argument to the two `completeMissionIfVerified` call sites and the store
   function it fires: `changeType` from PR files with the manifest fallback, hero-shot
   pool and deterministic pick, lede check, `offPlan` trim, artifact upsert, stale and
   sensitive handling; call the same store function from the human-completion path with
   `origin: 'manual'`. Tests: each row of the Fallbacks table, `changeType` for
   frontend/backend/both/null, hero ids outside the pool dropped, lede check cases.
2. **Mission page header.** Depends on task 1's stored record (can be built against a
   fixture). The header with `id="what-shipped"`: lede, change-type chip, hero shots
   opening `VisualReviewDeck`, optional "Off plan" lines, the "No screenshots were
   captured" line, the mechanical-only variant, and D3 fallback; the `ShippedCard` link
   retargeted to `#what-shipped`. Verify at phone and desktop width with the visual-review
   workflow (`/visual-review`).
