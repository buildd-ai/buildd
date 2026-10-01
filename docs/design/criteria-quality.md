# Goal Criteria That Mean Something: an Advisory Quality Check

**Status:** Proposed
**Related:** `packages/core/mission-helpers.ts` (`MECHANICAL_CRITERION_TYPES`, `validateGoalCriteria`, `criterionFingerprint`),
`packages/core/gate-events.ts` + `packages/core/gate-slugs.ts` (the gate ledger),
`apps/web/src/lib/strand-choice-decision.ts` + `apps/web/src/lib/strand-choice-shadow.ts` (the shadow pattern this copies),
`packages/core/decision-client.ts`, `packages/core/inference-client.ts`, `packages/core/inference-policy.ts`,
`apps/web/src/lib/mission-completion.ts` (`canCompleteMission`),
`apps/web/src/app/app/(protected)/missions/[id]/MissionBoard.tsx` (`GoalCell`),
`apps/web/src/lib/mission-board.ts`, `apps/web/src/lib/criteria-escalation.ts`,
`docs/design/decision-calls.md`, `docs/design/memory-done-right.md`,
`docs/design/plan-first-missions.md`, `docs/reports/gate-audit.md`,
`docs/specs/mission-task-lifecycle.md`

## Problem

A mission's goal is meant to tell the owner when it is done and what they can show
for it. In practice the goal usually says nothing a customer would recognise.

1. **The validator teaches the empty goal.** PR #2407 made `validateGoalCriteria`
   reject a non-empty `goalCriteria` with no mechanical entry. Its 400 ends with:

   > `A cheap default: all_prs_merged + no_open_tasks.`

   Authors (people, agents, the organizer, MCP clients) read the error, paste the
   default and pass. The mission then has a "goal" that holds for *any* finished
   batch of work. "Done when all PRs merged" is not something the owner can
   present to a customer.

2. **The bookkeeping criteria repeat a gate that already exists.**
   `canCompleteMission` (`apps/web/src/lib/mission-completion.ts:234`) already
   refuses completion while any work or attempt row is open (its step 2) and
   while any completed deliverable has an unmerged PR (its step 5), and it does
   this for every mission, with or without criteria. Listing `all_prs_merged` and
   `no_open_tasks` adds nothing to completion. It only takes up the Goal cell
   (`GoalCell`, `MissionBoard.tsx:287`), which then reads "Goal · 2/2 criteria"
   for a mission whose outcome nobody stated.

3. **Prose criteria mostly cannot be graded.** Forensics over this workspace's
   missions found that most `description` criteria resolve `NOT_EVALUATED`, that
   only a minority of completed missions define any criteria, and (until PR #2366)
   that escalation had never fired. A goal that cannot be checked is a wish, and a
   goal that can be checked but is pure bookkeeping is noise. Nothing today tells
   the author which of the two they wrote.

The owner settled the outcome and the shape. This doc settles the mechanics. Two
alternatives are already ruled out: **hard rejection**, because the author
sometimes wants the goal exactly as written, and **silent correction**, because
it replaces the owner's goal with one nobody set.

## Proposal

The goal splits into three parts:

| Part | What it is | Where it lives | Who checks it |
|---|---|---|---|
| **Outcome** | One customer-readable sentence: what a user will notice | new `missions.outcome` column | the quality verdict (advisory) |
| **Proof** | Mechanical checks that back the sentence (`command`, `artifact_exists`, a justified `description`) | `missions.goalCriteria`, unchanged | the existing evaluators |
| **Bookkeeping** | Every PR merged, nothing left open | not listed; already in `canCompleteMission` | the existing completion gate |

On every mission create or update, a **`/decide` quality verdict** grades the
outcome and each proof criterion: is it user-noticeable, and is it checkable? It
offers at most one better phrasing. The verdict is recorded in the existing gate
ledger. It never blocks, never rewrites, and graduates from shadow to suggestion
only after its agreement with the owner's labels is measured.

### The crux

**The verdict is advice attached to a write. It is never a condition of the
write.** Every other choice here follows from that:

- It runs after the response in shadow (`after()`, the same as
  `applyStrandChoice`). In suggest mode it is awaited under a hard deadline, and
  a miss means no advice, not a slower or failed save.
- A failure at any step means "no advice", and the response is byte-identical
  to today's.
- The mode type is `'shadow' | 'suggest'`. There is no `'block'` value to turn
  on by mistake.
- Its ledger rows are `warned` / `accepted` / `bypassed`, never `rejected`.

If this is wrong, and the verdict can affect whether or how a mission saves, we
have built the hard rejection the owner ruled out, only with worse error
messages. The tests in §6 assert the status code and the stored row are
independent of the verdict.

---

### 1. Data model: Outcome / Proof / Bookkeeping

**Outcome: a new nullable column, `missions.outcome text`.**

- One sentence, 10–280 characters after trim. It is validated in a new sibling
  of `validateGoalCriteria` (`validateMissionOutcome`, in the same module) and
  called from the same POST/PATCH sites. An over-long or multi-paragraph value
  is a 400 with the length rule. That is a shape rule, not a quality one, and is
  recorded under the existing `goal_criteria` slug.
- It is written by `POST /api/missions`, `PATCH /api/missions/[id]`, and
  `manage_missions` create/update as a new `outcome` param. MCP posts through
  the same routes, so it needs no separate wiring. The chat `manage_missions`
  tool (`apps/web/src/lib/chat/tools.ts`) and its instructions get the field too.
- **Why a column, not a parsed `## Outcome` heading in `description`?** The
  verdict's input must be the outcome *alone*. The description holds context,
  task sketches and links: exactly the "task bodies" the verdict must not see.
  The description stays free-form. A column is also the only form the Goal cell
  can render without guessing.
- `null` is legal and is today's state for every existing mission. **Default
  no-op:** a mission with `outcome = null` renders exactly as it does now, apart
  from the bookkeeping filter below.

**Goal cell rendering** (`GoalCell` and the `criteria` list built in
`apps/web/src/lib/mission-board.ts`):

```
┌ GOAL · 1/1 proof ────────────────────────────────┐
│ Act on any task from wherever you see it, and    │  ← outcome, 2-line clamp
│ get the same behaviour.                          │
│ ■ parity test: board / chat / MCP agree     pass │  ← proof criteria only
└──────────────────────────────────────────────────┘
```

- The heading counts **proof** criteria only: `Goal · {passed}/{proof} proof`.
- Criteria of type `all_prs_merged` or `no_open_tasks` are **bookkeeping**. They
  are filtered out of the Goal cell's list and count. The LANDED cell next to it
  already shows merged-vs-total. The criteria sheet
  (`#MISSION_CRITERIA_ANCHOR`) still lists them, under a "Bookkeeping (enforced on
  every mission)" sub-heading, so nothing disappears.
- `outcome = null` and no proof criteria: "No outcome set", plus a link that
  opens the edit sheet. The unevaluated "Criteria not evaluated · Check now"
  branch is unchanged.
- The header goal line (`MissionBoardHeader`'s `goal`, today from
  `missionSummaryLine(description)`) prefers `outcome` when set and falls back to
  the current derivation otherwise.

The pure classifier lives in `packages/core/criteria-quality.ts` so both the
board and the verdict use one definition:

```ts
export const BOOKKEEPING_CRITERION_TYPES = ['all_prs_merged', 'no_open_tasks'] as const;
export function isBookkeepingCriterion(c: GoalCriterion): boolean;
```

**Bookkeeping as an implicit gate.** We add **no new gate**, because one already
exists. `canCompleteMission` steps 2 and 5 already hold every mission to "nothing
open, every deliverable PR merged". The spec change is to *name* that:
`docs/specs/mission-task-lifecycle.md` gets a sentence saying bookkeeping is the
completion predicate's own bar and does not need to be listed as a criterion.
The two forms differ in two narrow ways, and both stay as they are:

- `no_open_tasks` as a criterion is evaluated by `evaluateGoalCriteria`
  (`mission-helpers.ts`, `case 'no_open_tasks'`). Step 2 instead lets pending
  housekeeping rows through. A mission that lists the criterion keeps the
  stricter read.
- `all_prs_merged` with `requireBranchDeleted: true` is stricter than step 5. It
  keeps evaluating, and is shown as bookkeeping.

**Existing missions that list them:** they keep evaluating and keep gating
exactly as today (`recalculateOverall` is untouched). They stop *displaying as
the goal*: they move to the Bookkeeping sub-heading. No row is rewritten.

**Migration plan.** One additive migration:
`ALTER TABLE missions ADD COLUMN outcome text` (nullable, no default, no backfill).
Follow `.claude/skills/schema-change/`, and check the latest index against
`origin/dev` before generating, because this branch lags trunk. **No backfill.** A
backfill would mean either parsing descriptions (that is guessing) or writing
an outcome nobody set (that is silent correction). The edit sheet may *prefill*
the field client-side from a `## Outcome` / `Outcome:` paragraph in the
description (`missionSummaryLine`'s `GOAL_LABEL` already matches it), and the
author confirms it by saving.

### 2. The verdict

**Primitive: one decision call, plus at most one inference call. No new
framework.** This is the `decisionCall` from `packages/core/decision-client.ts`,
shaped like `adviseStrandChoice`: capability check, `resolveDecisionAccess`, LRU
cache, `[decision-shadow]` line, fail-open `null`.

**Capability:** `mission_criteria_quality`, kind **`opt_in`**, in
`packages/core/inference-policy.ts`. It is enabled per team through
`teams.enabledDecisionShadows`, the same way as `mission_strand_choice`. It must
not be `built_in`: since `isInferenceAllowed` lets every `built_in` capability
through once a key resolves, `built_in` would turn it on for every team with a
key. Default off means merging changes nothing.

**Input: structured criteria + outcome text only.**

```ts
interface CriteriaQualityInput {
  outcome: string | null;
  criteria: Array<{
    index: number;                // position in the submitted array
    fingerprint: string;          // criterionFingerprint()
    type: GoalCriterionType;
    label?: string;
    text: string;                 // command | description | `${key}/${artifactType}`
  }>;
  rubric: RubricExample[];        // §4, capped
}
```

No mission description, no task titles or bodies, no notes, no diffs, no
workspace or mission ids in the state sent out. A workspace with
`gitConfig.dataClass = 'sensitive'` gets no call at all (`null`, the same as the
strand decision).

**Deterministic pre-grading (no spend):**

| criterion | userNoticeable | checkable | confidence | sent to model |
|---|---|---|---|---|
| `all_prs_merged`, `no_open_tasks` | false | true | 1 | no |
| `command`, `artifact_exists` | *asked* | true | — | yes |
| `description` | *asked* | *asked* | — | yes |
| `metric` | n/a | n/a | — | no (validator already rejects new ones) |

The model therefore never decides that "all PRs merged" is bookkeeping, because
the type already says so. Two cases do reach the model: a `description`
criterion that says "all PRs are merged", and a bookkeeping *label* on a
`command`. The rubric (§4) covers those.

**Questions** (`noul` per criterion, keyed `c{index}_noticeable` /
`c{index}_checkable`, plus `outcome_noticeable` when an outcome is set). At most
**8 non-bookkeeping criteria** are sent. Any beyond that get no verdict, and
`detail.truncated` records it.

- *noticeable*: "If this passes, will a user of the product notice something
  different, either directly or because it proves the stated outcome?" Yes: a
  behaviour, a page, a number a customer sees, a parity test over user entry
  points. No: merged PRs, closed tasks, a file existing, "tests pass" with no
  named behaviour.
- *checkable*: "Can two careful reviewers reach the same pass/fail from the
  repo or product state, without asking the author what they meant?"

**Output, per criterion:**

```ts
interface CriterionQuality {
  index: number;
  fingerprint: string;
  userNoticeable: boolean;   // p >= 0.5
  checkable: boolean;        // p >= 0.5 (deterministic true for command/artifact_exists)
  confidence: number;        // min over the criterion's answered questions of max(p, 1 - p)
  suggestion?: string;       // only on weak criteria, see below
}
interface CriteriaQualityVerdict {
  promptVersion: string;     // CRITERIA_QUALITY_PROMPT_VERSION, bumped with the questions or the baseline rubric
  outcome?: { userNoticeable: boolean; confidence: number };
  criteria: CriterionQuality[];
  weak: number[];            // indices where (!userNoticeable || !checkable) && confidence >= CRITERIA_QUALITY_MIN_CONFIDENCE
}
```

`CRITERIA_QUALITY_MIN_CONFIDENCE` starts at 0.8 as a proposal and is set from
the shadow readout. A set is **weak** when `weak` is non-empty, or when it has
an outcome judged not noticeable, or when it has no outcome and no proof
criterion.

**Suggestion.** It is produced only when the set is weak, by **one**
`inferenceCall` (`packages/core/inference-client.ts`, the same capability) with
the same input. It asks for one rewrite of the single weakest item: the outcome
sentence, or one proof criterion. If the weakest item is bookkeeping, it asks
for an outcome sentence plus a proof that backs it. It returns
`{ target: 'outcome' | number, text }`, capped at 280 characters. One suggestion
per verdict matches the mission's "offers one better phrasing". It is cached
with the verdict.

**Call sites:**

| Site | When | Notes |
|---|---|---|
| `POST /api/missions` (`apps/web/src/app/api/missions/route.ts`) | after the insert succeeds, when the mission has criteria or an outcome | |
| `PATCH /api/missions/[id]` (`apps/web/src/app/api/missions/[id]/route.ts`) | after the update succeeds, only when `goalCriteria` or `outcome` changed vs stored | the same place bypass/adopt is classified (§3) |
| `manage_missions` create / update | no separate wiring | it posts through the two routes above. A route test asserts that the MCP path produces the ledger row |
| chat `manage_missions` | no separate wiring | same routes |
| approve-plan (`apps/web/src/lib/approve-plan.ts`) | when a plan's `goalCriteria` / `outcome` is applied to the mission | `PlanningStructuredOutput` already carries `goalCriteria` (`packages/shared/src/planning.ts`), but `approvePlan` does not write it yet (`plan-first-missions.md` §6). Whoever wires that write calls the same `scheduleCriteriaQuality` helper. Until then this site has nothing to grade |

**Timing (copied from the strand shadow):**

- `shadow` (initial): the route builds the input from the rows it already holds
  and calls `scheduleCriteriaQuality(...)`, which runs
  `adviseCriteriaQuality` inside `after()`. If `after()` throws (tests, build),
  it runs as `void run()`. The response is not awaited on it and does not change.
- `suggest`: the route awaits the cached, deadline-bound verdict, with a
  **3 s** whole-call deadline for the decision and the suggestion together. If
  the deadline is missed, the response carries no advice and the work finishes
  in `after()`, so the ledger row still lands. On success the JSON response gains
  an optional field:

  ```ts
  criteriaQuality?: {
    weak: Array<{ index: number | 'outcome'; userNoticeable: boolean; checkable: boolean; confidence: number }>;
    suggestion?: { target: number | 'outcome'; text: string };
  }
  ```

  The field is absent when the mode is shadow, when the call failed, or when
  nothing is weak. `manage_missions` renders it as one line ("Goal check: …
  Suggested: …"). The dashboard edit sheet shows it under the field with two
  actions: **Use suggestion** (fills the field, and the author still saves) and
  **Keep as written**.

**Fail-open on every error.** Each of these returns `null`. The route's status,
body and stored row are then identical to today's:

- capability off
- no decision key
- sensitive workspace
- `decisionCall` error of any kind (`timeout`, `transport`, `rate_limited`,
  `provider_error`, `parse`, …)
- an inference error on the suggestion: the verdict is kept and there is no
  suggestion
- a rubric retrieval error: the call goes ahead with the baseline only
- a throw anywhere

Gate writes are already fire-and-forget (`recordGateEvent` never throws). The
`[decision-shadow]` line logs ids (8-char mission prefix), labels and numbers
only, never criterion text:
`{site:'criteria_quality', v, mission, weak:[…], confidences:[…], mode, latencyMs, inputTokens, costUsd}`.

**Cost bound:** at most one decision call and one inference call per distinct
`(promptVersion, outcome, sorted fingerprints, rubric digest)`. The process-level
LRU holds 200 entries, the same as the strand. A dashboard save that PATCHes an
unchanged array costs nothing, which is also what makes bypass detection free.

### 3. Gate ledger use

**New slug** in `packages/core/gate-slugs.ts`, added and never renamed:

```ts
/**
 * Missions create/update — the advisory goal-criteria quality verdict
 * (docs/design/criteria-quality.md). NEVER `rejected`: `warned` = the set was
 * judged weak; `accepted` = a verdict found nothing weak, or the author adopted
 * the advice; `bypassed` = the author re-saved the flagged items unchanged after
 * seeing the advice. `reason` is prefixed with the mode (`shadow:` / `suggest:`).
 */
CRITERIA_QUALITY: 'criteria_quality',
```

**One row per verdict, not per criterion.** The bypass rate is the false-positive
rate of a *decision*, and per-criterion rows would weight a 6-criterion mission
six times.

| outcome | written when | `detail` |
|---|---|---|
| `warned` | the verdict has `weak` non-empty / weak outcome / no outcome and no proof | `{ mode, promptVersion, weak: [{index, fingerprint, userNoticeable, checkable, confidence}], outcomeHash, suggestion? , truncated? }` |
| `accepted` | the verdict found nothing weak (this is the denominator; the `surface_ordering` precedent), **or** a later write changed or removed every flagged item (`detail.adopted = true`, `detail.adoptedSuggestion` when the new text equals the stored suggestion) | same shape |
| `bypassed` | **suggest mode only.** A later write to the same mission leaves every fingerprint flagged by its latest `suggest:` `warned` row (and `outcomeHash` when the outcome was flagged) unchanged. "Keep as written" is that write | `{ priorEventId, flagged: [fingerprint…] }` |

The `reason` strings are deliberately stable so that `normalizeErrorSignature`
groups them into a few families: `shadow: weak goal criteria`,
`suggest: weak goal criteria`, `suggest: advice kept as written`,
`suggest: advice adopted`, `… nothing weak`. In shadow mode no author saw
anything, so a re-save is **not** a bypass and no `bypassed` row is written.

Bypass detection reads the mission's latest `criteria_quality` row through a
small reader next to `recordOrCoalesceDeferral`'s existing select in
`packages/core/gate-events.ts`. That is a read of the same table, not a second
ledger. If the read fails, no bypass/adopt row is written (fail-open).

**Reading the rate:**
`get_failure_analytics { family: 'gate', errorPrefix: 'suggest:' }` gives the
suggest-mode bypass rate for this slug only, using the existing formula
`bypassed / (bypassed + rejected + warned)` (deferrals excluded). The
`errorPrefix: 'shadow:'` rollup gives shadow volume. The unprefixed gate view
mixes the two, and during shadow it honestly reads 0% bypassed. The same numbers
appear on the health page Gates block, because all three read
`apps/web/src/lib/gate-analytics-query.ts`.

**`docs/reports/gate-audit.md` requirement:** the build PR adds a row to the
Missions table for each wired site: `missions/route.ts` POST and
`missions/[id]/route.ts` PATCH → `criteria_quality` → `warned / accepted /
bypassed`. It also amends the `goal_criteria` rows to mention the outcome length
rule. `packages/core/__tests__/gate-slug-coverage.test.ts` (always-run) fails
until the slug is both fired and listed, so this cannot be skipped.

### 4. Rubric memory

The rubric is a list of labelled examples sent as `instructions` context in the
decision call (`DecisionText` accepts structured objects):

```ts
interface RubricExample {
  verdict: 'good' | 'weak';
  outcome?: string;
  criterion?: { type: GoalCriterionType; text: string };
  why: string;            // one line
  source: 'baseline' | 'workspace';
}
```

**Global baseline: in code, versioned.** `CRITERIA_RUBRIC_BASELINE` lives in
`packages/core/criteria-quality.ts`, and changing it bumps
`CRITERIA_QUALITY_PROMPT_VERSION`. The memory store is keyed by a workspace's
project key (`resolveMemoryProjectKey`, `packages/core/memory-scope.ts`) and has
no cross-workspace tier. Putting the baseline in code makes it global, reviewable
in a public repo, and pinned to the prompt version that the readout measures.
The seed:

- **good:** outcome "Act on any task from wherever you see it, and get the same
  behaviour", proof `command` running a parity test that drives the same action
  through each entry point and asserts identical results. *Why: a user notices
  it, and the test proves the sentence.*
- **good:** outcome "A stranded mission tells you what to do next in one tap",
  proof `artifact_exists` keyed to the shadow readout. *Why: the outcome is
  visible, and the proof is a concrete artifact.*
- **weak:** goal = `all_prs_merged` only. *Why: true of any finished batch, so
  it says nothing about what changed for the user. It is already enforced at
  completion.*
- **weak:** `description` "The feature works well". *Why: not checkable, and two
  reviewers would disagree.*
- **weak:** `command` `bun run test` with label "tests pass". *Why: checkable,
  but it names no behaviour, so it proves nothing a user would notice.*

**Per-workspace entries: ordinary memories.** They have type `pattern`, tag
`criteria-rubric`, and live in the workspace's project key. The content is one
example in the shape above (text only, no ids). They come from two places:

1. **Accepted override (automatic).** When a mission completes through
   `canCompleteMission` with `criteriaVerdict = pass` and `criteriaEscalatedAt`
   null, check its latest `criteria_quality` row. If that row is `bypassed` and
   every fingerprint it flagged is still in the final `goalCriteria`, the author
   overrode the judge and the mission then proved itself. Each such criterion
   becomes a **memory candidate** (`packages/core/memory-candidates.ts`, the
   write-candidates-then-promote path from `memory-done-right.md`): `verdict:
   'good'`, `why: "kept as written by the owner; mission completed with criteria
   passing"`. Promotion follows the existing candidate rules. Nothing is
   promoted straight into the rubric. The hook is fire-and-forget at the
   completion site and never affects completion. A bypassed mission that later
   escalates or fails its criteria writes **nothing**: we do not learn
   negatives automatically (see Open questions).
2. **Explicit (`learn`).** Anyone may `learn` a `pattern` tagged
   `criteria-rubric` for a workspace convention. Memories that already exist go
   through the same supersede/archive tools as any other memory.

**Retrieval at decision time.** `adviseCriteriaQuality` calls `retrieveMemory`
for the workspace's project key, filtered to `type = pattern`, tag
`criteria-rubric`, and ranked by similarity to the outcome plus criteria text.
The rubric sent to the model is capped at **12 examples and 2,000 characters**:
the baseline first (always whole), then up to **6 workspace entries**. The
retrieval is cached per workspace for 10 minutes, and its digest is part of the
verdict cache key. Retrieval failure, a sensitive workspace, or a null project
key means the baseline only. Retrieval goes through the existing memory use
ledger, so `memory_uses` records which rubric entries were shown, and an entry
that is never pulled ages out under the existing decay rules.

**Held-out labels.** Criteria the owner labels for the readout (§5) are **not**
written as rubric entries until the readout for that prompt version is
published. Otherwise the judge would be graded on its own examples.

### 5. Rollout

`CRITERIA_QUALITY_MODE: 'shadow' | 'suggest'` is a code constant in
`packages/core/criteria-quality.ts`. It is raised in code in its own PR after a
readout, never by configuration, the same as `STRAND_CHOICE_MODE`. There is no
third value.

**Stage 1: shadow.** The capability is enabled for the owner's team only.
Verdicts go to `[decision-shadow]` lines and `shadow:` gate rows, and nobody
sees anything.

**Labels.** A readout script (`scripts/criteria-quality-readout.ts`, with a pure
half in `packages/core/criteria-quality-readout.ts`, mirroring
`memory-decision-readout`) samples shadow rows. It shows the owner the outcome
and the criteria **without the verdict** and records a blind label per item
(`good` / `weak`; and, for weak items that got a suggestion, whether the owner
would accept it). Labels are stored as a `data` artifact keyed
`criteria-quality-labels` on the mission that ships this feature. That is
private DB state, never the repo, and needs no new table.

**Graduation threshold (shadow → suggest).** Every one of these must hold on a
single `promptVersion`:

| measure | bar |
|---|---|
| labelled items | ≥ 60, from ≥ 15 distinct missions |
| agreement (verdict weak/not-weak vs owner label, at `CRITERIA_QUALITY_MIN_CONFIDENCE`) | **≥ 85 %** |
| precision of `weak` (owner also says weak) | **≥ 90 %**: a false "weak" is the annoying error |
| coverage (items answered at or above the confidence threshold) | ≥ 70 % |
| fail-open rate (verdict `null` / all sites) | ≤ 10 % |
| suggestion acceptability (owner would take it as is or with a light edit) | ≥ 70 % of weak items with a suggestion |

The readout prints each measure with its n, and the graduation PR quotes them.
If any bar misses, the next step is to tune the questions or the rubric, bump
`promptVersion` and relabel. Lowering a bar is not an option.

**Stage 2: suggest.** The verdict is returned in the same response (§2), and
bypass rows start. **Demotion check:** if the 30-day `suggest:` bypass rate goes
above **35 %**, the next readout must either fix the prompt or rubric, or move
the mode back to `shadow` in code. A high bypass rate means the judge disagrees
with the authors it advises, and advice that is mostly ignored is noise.

**Never block.** There is no stage 3. The test in §6 asserts it.

**The #2407 400.** `validateGoalCriteria` keeps rejecting what it rejects today:
not an array, more than 20 items, bad shape, `metric`, a `description` without
`notMechanizableReason`, a non-empty set with no mechanical entry. Only the
message changes. The `A cheap default: all_prs_merged + no_open_tasks.` sentence
is replaced with:

> `… so the mission has a verdict that does not depend on a live LLM. Prefer a command or artifact_exists criterion that proves the outcome; merged PRs and no open tasks are already required of every mission at completion.`

The same nudge is removed or rephrased wherever an author is told to reach for
bookkeeping first:

- the chat instructions (`apps/web/src/lib/chat/instructions.ts`: "Prefer
  mechanical criteria (command, all_prs_merged, no_open_tasks)")
- the chat tool schema `.describe` (`apps/web/src/lib/chat/tools.ts`)
- the planning output schema description (`packages/shared/src/planning.ts`)
- the `manage_missions` param doc's example
  (`[{type:"command",…},{type:"all_prs_merged"}]`)
- `plan-first-missions.md` §6's "organizer prompt should get the same
  cheap-default guidance"

`MECHANICAL_CRITERION_TYPES` itself is unchanged (see Open questions).

### 6. Test plan

**`packages/core/__tests__/criteria-quality.test.ts`** is the mission's command
criterion. It tests the pure core in `packages/core/criteria-quality.ts`, with
`decide`, `infer`, `resolveAccess`, `retrieveRubric`, `recordGate` and `log`
injected (the `StrandChoiceDeps` pattern), so it runs with no DB and no network.
It asserts:

1. **Bookkeeping is graded without a call.** A set containing `all_prs_merged`
   and `no_open_tasks` yields `userNoticeable: false, checkable: true,
   confidence: 1` for both, and neither appears in the `decide` state.
2. **Outcome vs bookkeeping.** With an injected `decide` returning high
   `noticeable` for a parity-test `command` and an outcome sentence, the set
   `{outcome, command, all_prs_merged}` is not weak. The same set without the
   outcome and the command (bookkeeping only) is weak, with a reason naming
   "no outcome and no proof".
3. **Input discipline.** The state passed to `decide` contains only the outcome,
   the criteria's type/label/text/fingerprint and the rubric: no mission id,
   description, task text or workspace id. At most 8 criteria are sent, and
   `truncated` is set beyond that.
4. **Fails open, every path.** These each return `null`, and `recordGate` is not
   called with `warned`: capability refused, missing key, sensitive `dataClass`,
   each `DecisionError` kind, `decide` throwing, and a `retrieveRubric` throw
   (the latter still calls `decide`, with the baseline only).
5. **Suggestion is optional.** An `infer` error keeps the verdict and omits
   `suggestion`. At most one suggestion per verdict, and ≤ 280 characters.
6. **Cache.** An identical input calls `decide` once. A changed fingerprint,
   outcome, rubric digest or `promptVersion` calls it again.
7. **Ledger classification** (`classifyCriteriaQualityWrite(prior, incoming,
   mode)`):
   - a weak verdict produces `warned` with a `shadow:` / `suggest:` prefix
   - a clean verdict produces `accepted`
   - suggest mode with every flagged fingerprint unchanged produces `bypassed`
   - flagged items changed produces `accepted` with `adopted: true`
   - shadow mode with an unchanged re-save produces **no** `bypassed`
   - the outcome is never `rejected`
8. **Never block.** `CRITERIA_QUALITY_MODE` is one of `'shadow' | 'suggest'`.
   The advice builder has no code path that returns an error, a status, or a
   modified criteria array.
9. **Rubric cap.** The baseline is always first and whole. Workspace entries are
   cut at 6 and the total at 12 / 2,000 characters.
10. **Accepted-pattern promotion predicate.** It is true only for a completed
    mission with `pass`, no escalation, a latest `bypassed` row, and the flagged
    fingerprints still present. It is false for each one of those missing.

**Alongside it:**

- `packages/core/__tests__/goal-criteria-validation.test.ts`: line 102's
  `toContain('all_prs_merged + no_open_tasks')` is inverted. The message must
  not contain "cheap default" and must not recommend the two bookkeeping types.
  Every existing rejection still rejects. `validateMissionOutcome` length and
  shape cases.
- `apps/web/src/app/api/missions/route.test.ts` and
  `apps/web/src/app/api/missions/[id]/route.test.ts`:
  - status and stored row are identical with the verdict stubbed weak, clean,
    throwing or timing out
  - shadow mode schedules via `after()` and adds no response field
  - suggest mode adds `criteriaQuality` only when weak
  - a PATCH with unchanged criteria after a `suggest:` warning fires `bypassed`
  - the MCP `manage_missions` path produces the same row

  Stub `@buildd/core/gate-events` as the gate-ledger memory describes, so insert
  counts do not drift.
- `apps/web/src/lib/mission-board.test.ts` / `MissionBoard.test.tsx`:
  - bookkeeping criteria are excluded from the Goal cell list and count, and
    still listed in the sheet
  - the outcome renders when set
  - "No outcome set" appears when neither outcome nor proof exists
  - a null outcome with today's criteria renders today's cell minus bookkeeping
- `packages/core/__tests__/gate-slug-coverage.test.ts` passes with the new slug
  fired and listed.

## Implementation sketch

The load-bearing piece comes first.

1. `packages/core/criteria-quality.ts` + its test: the classifier, input
   builder, questions, baseline rubric, `adviseCriteriaQuality`,
   `classifyCriteriaQualityWrite`, mode constant. The `mission_criteria_quality`
   capability goes in `inference-policy.ts` (`opt_in`). `CRITERIA_QUALITY` goes
   in `gate-slugs.ts` and `gate-audit.md`.
2. Route wiring (POST/PATCH) via `scheduleCriteriaQuality` in
   `apps/web/src/lib/criteria-quality-shadow.ts`. Shadow only.
3. #2407 message and the nudge sites in §5.
4. `missions.outcome` migration, the validator, the routes, the
   `manage_missions` param, the shared types.
5. Goal cell and sheet rendering.
6. Readout script and labels artifact. Then the completion-site promotion hook.
7. Later, its own PR, after the readout: `CRITERIA_QUALITY_MODE = 'suggest'`.

Steps 1–3 are the mission's build task. Steps 4–6 can follow in separate PRs:
none of them changes behaviour while the capability is off.

## Safety properties

- **Blocks nothing.** No status code, stored row or completion outcome depends on
  the verdict. There is no `rejected` outcome and no `block` mode.
- **Spend bound:** ≤ 1 decision call + ≤ 1 inference call per distinct
  `(promptVersion, outcome, fingerprints, rubric digest)`, only for teams that
  opted in, never for sensitive workspaces.
- **Latency bound:** shadow adds 0 ms. Suggest adds ≤ 3 s, and a miss costs
  only the advice.
- **Learning bound:** accepted patterns enter as candidates, not rules. The
  rubric sent per call is capped. Labels are held out from the rubric.

## Open questions

- **Should bookkeeping types still satisfy the "≥ 1 mechanical" rule?** Today
  `all_prs_merged` alone satisfies it, so an author can still pass the 400 with
  bookkeeping. *Lean: yes for now.* Changing it is the hard rejection the owner
  ruled out. The advice says it softly, and the suggest-phase bypass rate tells
  us whether a harder rule would be wanted.
- **Negative learning.** Should a bypassed mission whose criteria later failed or
  escalated write a `weak` rubric candidate? *Lean: no automatic write.* The
  failure may be the work's fault, not the criterion's. Escalation already asks
  the owner which reading holds (`criteria-escalation.ts`), and that answer is
  the better label source.
- **Team-level rubric tier.** If teams with several workspaces want one shared
  convention, the memory store would need a team scope. *Lean: wait for the
  demand.* `learn` per workspace is enough until then.
- **Suggest-mode deadline.** 3 s is a guess. *Lean: set it from shadow p90
  latency.*

## Non-goals

- Changing how any criterion is **graded** (`evaluateGoalCriteria`, the
  `CriteriaGrader` `api` / `runner` paths, reviewer findings) or what blocks
  completion.
- Rewriting, reordering or auto-filling anyone's criteria or outcome.
- A new ledger, normalizer, decision primitive or label store. This design uses
  `gate_events`, `normalizeErrorSignature`, `decisionCall` / `inferenceCall`,
  the memory candidate path and an artifact.
- Backfilling `outcome` on existing missions.
- Evaluating `metric` criteria.
