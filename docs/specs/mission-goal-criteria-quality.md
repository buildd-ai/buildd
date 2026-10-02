---
title: Mission Goal Criteria Quality (Advisory Verdict)
status: draft
owner: max
last_verified: 2026-10-01
summary: A mission's goal criteria MUST be graded advisorily on write (noticeable outcome, checkable proof) without ever blocking, rewriting or changing the stored goal, failing open and shadow-only until promoted in code.
domain: missions
surfaces: [packages/core/mission-helpers.ts, packages/core/gate-slugs.ts, apps/web/src/app/api/missions/route.ts, apps/web/src/app/api/missions/[id]/route.ts, apps/web/src/lib/goal-criteria-quality-decision.ts, apps/web/src/lib/goal-criteria-quality-shadow.ts]
related: [mission-task-lifecycle, orchestration-decisions-shadow]
keywords: [goalCriteria, goal_criteria_quality, criteria quality, outcome sentence, proof, bookkeeping, advisory, decision-shadow, weak criterion, accepted pattern, rubric, notMechanizableReason, NOT_EVALUATED, at least one mechanical criterion]
verified_by: [apps/web/src/lib/goal-criteria-quality-decision.test.ts, apps/web/src/lib/goal-criteria-quality-shadow.test.ts]
supersedes: []
---

# Mission Goal Criteria Quality (Advisory Verdict)

**Status: draft.** Built so far: the shadow verdict and its `warned` rows
(§2, §3 `warned`, §5 shadow), and the §6 message change — AC-1 to AC-7,
AC-12 to AC-14. Not built yet: `bypassed` rows (AC-8, AC-9), the rubric and
accepted patterns in memory (§4, AC-10, AC-11; the rubric is the code default
for now). It is promoted to `active` once tests assert every acceptance
criterion.

## Why

A mission's goal is meant to say what will be true for a customer when the
mission is done, and to prove it. In practice it mostly does neither:

- Most completed missions define no goal criteria at all.
- Where prose (`description`) criteria are written, their verdict mostly lands
  `NOT_EVALUATED`: the one form that reads like an outcome is the form the
  platform cannot grade reliably.
- Where criteria are mechanical, they are mostly bookkeeping
  (`all_prs_merged`, `no_open_tasks`), which the current 400 in
  `validateGoalCriteria` actively recommends as "a cheap default". Bookkeeping
  proves the work was closed out, not that anything a user would notice
  changed.
- `missions.criteriaEscalatedAt` (the loop guard handing a mission to its
  owner) has never been set, so the escalation path built for unprovable goals
  has never been exercised.

The fix is to shape the goal, then tell the author — without stopping them —
when a criterion does not meet that shape, and to learn from the times the
author was right and the judge was wrong.

---

## 1. Goal shape

**Capability statement**: A mission goal MUST be readable as three parts — an
Outcome sentence, its Proof, and Bookkeeping — and the platform MUST treat only
the first two as the author's statement of done.

- **Outcome** — one customer-readable sentence: what a user (or the workspace
  owner, for internal work) can do or see when the mission is done that they
  could not before. It is what the Goal cell on the mission surfaces shows.
- **Proof** — mechanical checks that back the Outcome sentence: a `command`
  criterion that exits 0 only when the outcome holds, or an `artifact_exists`
  criterion for a named deliverable. A `description` criterion is Proof only
  with a `notMechanizableReason` (unchanged from today).
- **Bookkeeping** — all PRs merged, no open tasks. True of every finished
  mission, so it says nothing about this one.

**Invariants**:

- The verdict (§2) grades Outcome and Proof criteria. Bookkeeping criteria
  (`all_prs_merged`, `no_open_tasks`) are never warned as weak for failing the
  "would a user notice" question; they are graded only as Bookkeeping.
- **Later, separately scoped — NOT built by this mission:** Bookkeeping becomes
  an implicit platform gate on mission completion, applied whether or not it is
  listed, and stops being a listed criterion type an author writes. Until that
  ships, `all_prs_merged` and `no_open_tasks` remain valid, listable,
  mechanical criteria and are evaluated exactly as
  `docs/specs/mission-task-lifecycle.md` § Mission Completion Gate describes.
  This contract does not change completion gating.

---

## 2. Verdict

**Capability statement**: On every goal-criteria write, buildd MAY ask a
decision model to grade each new criterion and suggest one rewrite; the answer
MUST NOT block the write, rewrite a criterion, or change the stored goal.

**Trigger points**:

- `POST /api/missions` with a non-empty `goalCriteria`: every criterion is
  graded.
- `PATCH /api/missions/[id]` carrying `goalCriteria`: only criteria that are
  not byte-identical to a stored criterion are graded (the same grandfathering
  rule `validateGoalCriteria` applies via `opts.stored`). A PATCH that adds or
  changes no criterion makes no call.
- The call runs only after `validateGoalCriteria` has accepted the array and the
  write has been committed. A 400 from validation means no verdict.

**The two questions**, asked of each graded criterion:

| Question | Labels | Weak when |
|---|---|---|
| `noticeable` — would a user notice this outcome? | `yes` · `no` · `bookkeeping` | `no` |
| `checkable` — is it checkable without a person reading prose? | `yes` · `no` | `no` |

A criterion is **weak** when either question lands on its weak label at or above
the confidence floor (proposed 0.8, set from the shadow readout). A
`bookkeeping` answer is never weak.

**One suggested rewrite** per verdict (not per criterion), chosen as a fixed
label — decision calls return labels, not free text:

| Rewrite label | Rendered suggestion |
|---|---|
| `state-outcome` | Say what a user can do or see when this is done, in one sentence. |
| `command-proof` | Back the outcome with a command that exits 0 only when it holds. |
| `artifact-proof` | Name the deliverable and check it with artifact_exists. |
| `none` | No rewrite suggested. |

The rendered text is a code-owned table keyed by label; the model never writes
the text the author sees.

**Facts sent** (the call's state), per graded criterion, and nothing else:

- the criterion `type`;
- its `label`, and its `description` text for a `description` criterion.

Never the mission title, description, task text, command string, metric query,
repo, ids, or any other mission field. Only for workspaces that are not
sensitive: a workspace whose `gitConfig.dataClass === 'sensitive'` sends
nothing, and the verdict is null.

**Invariants**:

- The verdict is advisory. It never causes a non-2xx response, never alters the
  `goalCriteria` stored or returned, never sets `goalCriteriaState`, and never
  touches `criteriaEscalatedAt`.
- The call never throws into the route. Every failure returns null (see §5).
- The prompt and question definitions carry a prompt version; bump it when a
  question, label or rubric shape changes, exactly as
  `STRAND_CHOICE_PROMPT_VERSION` does.

---

## 3. Ledger

**Capability statement**: Every weak verdict and every later override of it
MUST be recorded in the gate ledger under the `goal_criteria_quality` slug, so
the judge's false-positive rate is readable without new storage.

- **New slug** in `GATE_SLUGS` (`packages/core/gate-slugs.ts`): key
  GOAL_CRITERIA_QUALITY, value `goal_criteria_quality`. It is ADDED. The
  existing `goal_criteria` slug (validation 400s) is not renamed or reused —
  renaming forks a slug's history.
- **`warned`**: one row per weak criterion, written through
  `recordGateEvent`, with `surface` `POST /api/missions` or
  `PATCH /api/missions/[id]`, the mission and workspace ids, and `detail`
  carrying `fingerprint` (`criterionFingerprint`), `type`, the two answers and
  their confidences, the rewrite label, `promptVersion`, `model`, and `mode`
  (`shadow` | `surface`). `detail` never carries criterion text.
- **`bypassed`**: when a later goal-criteria write for the same mission still
  contains a criterion whose fingerprint has a `warned` row for that mission,
  one `bypassed` row is recorded for that (mission, fingerprint) pair, once.
  `detail` carries the fingerprint and the `mode` of the warning it answers.
  Bypass detection is a deterministic ledger lookup; it makes no model call and
  runs even when the decision capability is off.
- `reason` is a fixed per-outcome string (no criterion text), so rows coalesce
  cleanly in `get_failure_analytics`.

**Reading it**: `get_failure_analytics family=gate` reports
`goal_criteria_quality` like any other gate. Bypassed over warned is the
judge's false-positive rate. Only `surface`-mode pairs measure a real
override — in `shadow` the author never saw the warning, so a shadow
`bypassed` row means "kept it", which is the base rate the surface readout is
compared against.

---

## 4. Rubric in memory

**Capability statement**: The grading rubric MUST be read from team memory,
bounded in the prompt, and MUST fail open to a code-owned default.

**Memory shape** (rows in `memories`, which are team-scoped; `project` is the
canonical scope key written via `normalizeProject`):

| Entry | `type` | `tags` | `project` |
|---|---|---|---|
| Baseline rubric | `decision` | `goal-criteria-rubric` | null (team-wide) |
| Workspace rubric note | `decision` | `goal-criteria-rubric` | the workspace's scope key |
| Accepted pattern | `pattern` | `goal-criteria-rubric`, `goal-criteria-accepted` | the workspace's scope key |

- The **global baseline** is a code-owned default rubric shipped with the
  verdict. The team-wide memory row, when present, replaces it for that team;
  absent, the code default is used. The default is what every team starts
  from.
- An **accepted pattern** stores the criterion's `fingerprint` and type (in
  `content` as a single line, plus the fingerprint as a tag) and the
  criterion's label text. It is written when a criterion that has a
  `bypassed` row is on a mission that then completes cleanly: mission status
  `completed`, goal-criteria overall `pass`, `criteriaEscalatedAt` null.
  Writes go through the memory store with `sourceKind` naming the mission
  completion, and are not written for a sensitive workspace.

**Fetch and bound**:

- Only `state = 'active'` rows. At most one baseline, the 5 most recently
  updated workspace rubric notes, and the 20 most recently updated accepted
  patterns for the workspace. Each entry is truncated to 500 characters; the
  rubric block is capped at 4,000 characters in total, dropping oldest accepted
  patterns first.
- A criterion whose fingerprint matches an accepted pattern for the workspace
  is **suppressed**: it is not sent to the call, and no `warned` row is written
  for it. Suppression is a deterministic fingerprint match, not something the
  model is trusted to honour.
- The rubric read fails open: an error, a timeout, or no rows uses the code
  default and no accepted patterns. A rubric read failure never prevents the
  verdict and never fails the write.

---

## 5. Rollout

**Capability statement**: The verdict MUST ship shadow-only behind an opt-in
decision capability and MUST reach authors only after a code change made from
the shadow readout.

Modelled exactly on `mission_strand_choice`
(`apps/web/src/lib/strand-choice-decision.ts`, `docs/design/decision-calls.md`):

- A new `opt_in` capability, `mission_goal_quality`, in `INFERENCE_CAPABILITIES`
  (`packages/core/inference-policy.ts`), off by default (a team turns it on by
  listing it in `teams.enabledDecisionShadows`), so a team that has not
  opted in makes no call and writes no `warned` row.
- **Shadow**: the result is logged as one `DECISION_SHADOW_LOG_PREFIX`
  (`[decision-shadow]`) line — mission short id, per-criterion labels and
  confidences, fingerprints, latency, tokens, cost; no criterion text — and the
  `warned` rows of §3 are written. The response is unchanged. In shadow the call
  MUST NOT delay the response (it runs after the response is sent).
- **Fails open** — disabled capability, no decision key, sensitive workspace,
  timeout, provider error, parse error or a throw all return null: no advisory,
  no `warned` row, the write unaffected. A bounded timeout (proposed 3s, like
  `STRAND_CHOICE_TIMEOUT_MS`).
- **Surface**: a code constant (shaped like `STRAND_CHOICE_MODE`, values
  `shadow` | `surface`) moves from `shadow` to `surface` in its own PR after the
  readout. Only then do the POST and PATCH responses carry an `advisory` field:
  per weak criterion its index, fingerprint, which question was weak, and the
  rendered rewrite suggestion. Never raised by configuration, workspace setting
  or request flag.

---

## 6. Removal: the cheap-default suggestion

**Capability statement**: The "at least one mechanical criterion" 400 in
`validateGoalCriteria` MUST stay, and its message MUST stop recommending
bookkeeping as the default.

- The rule (a non-empty array needs at least one of
  `MECHANICAL_CRITERION_TYPES`) is unchanged and still returns 400 from both
  routes with the `goal_criteria` gate row.
- The message no longer contains `all_prs_merged + no_open_tasks` or "cheap
  default". It says what a proof criterion is instead: a `command` that exits 0
  only when the outcome holds, or an `artifact_exists` for a named
  deliverable.

---

## Acceptance criteria

- AC-1: GIVEN a team with the goal-criteria quality capability off WHEN
  `POST /api/missions` is called with valid goal criteria THEN the response is
  2xx, no decision call is made, and no `goal_criteria_quality` row is written.
- AC-2: GIVEN the decision call times out, errors, or throws WHEN
  `POST /api/missions` is called with valid goal criteria THEN the mission is
  created with the submitted criteria and the response is 2xx with no
  `advisory` field.
- AC-3: GIVEN the capability is on and every criterion is graded weak WHEN
  `POST /api/missions` is called THEN the response status is the same as with
  the capability off (2xx) — the verdict never blocks.
- AC-4: GIVEN the capability is on and a criterion is graded weak with a
  rewrite suggested WHEN `POST /api/missions` or `PATCH /api/missions/[id]`
  completes THEN the stored `goalCriteria` equals the submitted array exactly
  (deep-equal) — the verdict never rewrites.
- AC-5: GIVEN a workspace with `gitConfig.dataClass === 'sensitive'` and the
  capability on WHEN goal criteria are written THEN the decision call is never
  invoked and no `warned` row is written.
- AC-6: GIVEN the capability is on WHEN the decision call is made THEN its state
  contains only each criterion's `type`, `label` and (for `description`) its
  description text — no command string, mission title, mission description or
  id.
- AC-7: GIVEN the capability is on and one criterion is graded weak WHEN the
  write completes THEN exactly one `goal_criteria_quality` row with outcome
  `warned` exists for that mission whose `detail.fingerprint` equals
  `criterionFingerprint` of that criterion, and `detail` contains no criterion
  text.
- AC-8: GIVEN a mission with a `warned` row for fingerprint F WHEN a later
  `PATCH /api/missions/[id]` writes goal criteria that still include a criterion
  with fingerprint F THEN one `goal_criteria_quality` row with outcome
  `bypassed` and `detail.fingerprint` F is recorded, and a further PATCH that
  still includes it records no second `bypassed` row.
- AC-9: GIVEN a mission with a `warned` row for fingerprint F WHEN a later PATCH
  removes or changes that criterion THEN no `bypassed` row is recorded.
- AC-10: GIVEN an active accepted-pattern memory for the workspace carrying
  fingerprint F WHEN a new mission in that workspace is created with a criterion
  of fingerprint F THEN that criterion is not sent to the decision call and no
  `warned` row is written for it.
- AC-11: GIVEN the rubric memory read throws WHEN goal criteria are written with
  the capability on THEN the decision call is still made with the code default
  rubric and the write succeeds.
- AC-12: GIVEN the mode constant is `shadow` and the capability is on and a
  criterion is graded weak WHEN `POST /api/missions` or
  `PATCH /api/missions/[id]` responds THEN the response body has no `advisory`
  field, and one `[decision-shadow]` line is logged.
- AC-13: GIVEN a non-empty goal-criteria array with no mechanical criterion WHEN
  `POST /api/missions` is called THEN it rejects with HTTP 400, and the error
  message does not contain `all_prs_merged + no_open_tasks` and does contain
  `command` and `artifact_exists`.
- AC-14: GIVEN a `PATCH /api/missions/[id]` whose goal criteria are
  byte-identical to the stored ones WHEN it completes THEN no decision call is
  made.

## Code surface

Existing:

- `packages/core/mission-helpers.ts` — `validateGoalCriteria` (the 400 whose
  message §6 changes), `criterionFingerprint` (criterion identity for the
  ledger and accepted patterns), `MECHANICAL_CRITERION_TYPES`.
- `packages/core/gate-slugs.ts` — `GATE_SLUGS`, where the new slug is added.
- `packages/core/gate-events.ts` — `recordGateEvent`, the ledger writer.
- `apps/web/src/app/api/missions/route.ts` — `POST /api/missions`.
- `apps/web/src/app/api/missions/[id]/route.ts` — `PATCH /api/missions/[id]`.
- `packages/core/decision-client.ts` — `decisionCall`, `resolveDecisionAccess`.
- `packages/core/inference-policy.ts` — `INFERENCE_CAPABILITIES`, where the
  opt-in capability is added.
- `apps/web/src/lib/strand-choice-decision.ts` — `adviseStrandChoice`, the
  pattern to follow (fail open, cache, receipts, shadow line).
- `packages/core/memory-store.ts` and `packages/core/project-scope.ts`
  (`normalizeProject`) — rubric and accepted-pattern storage.
- `packages/core/db/schema.ts` — `memories`, `gateEvents`,
  `missions.criteriaEscalatedAt`.

- `apps/web/src/lib/goal-criteria-quality-decision.ts` — the verdict: facts
  builder (`buildGoalQualityState`), questions, the code-default rubric,
  `adviseGoalQuality`, the shadow line, `GOAL_QUALITY_MODE`, and the `warned`
  rows (`goalQualityWarnings`).
- `apps/web/src/lib/goal-criteria-quality-shadow.ts` —
  `scheduleGoalQualityShadow`, which runs it after the response from both
  routes and reads the workspace's data class, failing closed.

Planned (does not exist yet):

- Rubric fetch and bound from memory, accepted-pattern suppression, and
  `bypassed` recording.

## Out of scope

- The implicit Bookkeeping completion gate (§1) — later, separately scoped.
- Any change to how criteria are evaluated, folded, or gate completion
  (`docs/specs/mission-task-lifecycle.md`).
- Grading at completion time, or re-grading criteria that were not changed.
- Free-text rewrites from the model.
- Dashboard UI for the `advisory` field; the surface PR specifies its own
  rendering.
- Moving the mode constant to `surface`; that is its own PR after the readout.

## Related

- `docs/design/decision-calls.md` — the decision-call primitive and shadow
  policy.
- `docs/design/mission-goal-criteria.md` — original (superseded) goal-criteria
  design.
- `docs/specs/mission-task-lifecycle.md` — the completion gate these criteria
  feed.
