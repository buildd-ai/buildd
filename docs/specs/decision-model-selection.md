---
title: Decision Model Selection (Per-Decision Model, Measured Thresholds, Signal Collection)
status: draft
owner: max
last_verified: 2026-10-13
summary: A decision kind MUST act only at a threshold measured for its model on graded cases, MAY switch model when a challenger measurably wins, and MUST collect every grading signal it can.
domain: tasks
surfaces: [packages/core/decision-model.ts, apps/web/src/lib/prompt-evals/compare-run.ts, apps/web/src/lib/decision-model-optimizer/optimizer.ts, apps/web/src/app/api/cron/decision-model-optimizer/route.ts]
related: [decision-kinds, orchestration-decisions-shadow, settings-models]
keywords: [decision model, jev, clef, clef flash, threshold, calibration, top p, margin, wilson, comparison, replay, outcome, override, champion, challenger, optimizer, undo, signal collection]
verified_by: [apps/web/src/lib/decision-model-optimizer/optimizer.test.ts, apps/web/src/lib/prompt-evals/calibration.test.ts, apps/web/src/app/api/teams/[id]/decision-model-switches/route.test.ts]
assertions:
  - id: decision-model-lookup
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: symbol
    name: decisionModelFor
    path: packages/core/decision-model.ts
  - id: decision-model-normalize
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: symbol
    name: normalizeDecisionModel
    path: packages/core/decision-model.ts
---

# Decision Model Selection

A decision kind (see `decision-kinds`) never names a model. This spec says which
model answers it, when that answer may act, how that choice is made and changed,
and what has to be collected so the choice can be made on evidence.

## Model and threshold

- **One model per kind.** A team has a default decision model and MAY have a
  model per kind; the per-kind entry wins. No per-kind entry means the default.
- **A threshold belongs to (kind, model, confidence signal).** It is never a
  constant. The signal is the model's confidence field, the probability of the
  chosen label (top p), the gap to the second label (margin), or top p after
  calibration. A model whose confidence field is poorly calibrated is measured
  on another signal.
- **Measured, then stored as data, then applied at once.** The threshold is the
  lowest one whose 95% Wilson lower bound on precision is at least the larger
  of the rule's accuracy and the kind's target, over at least the kind's
  minimum of graded cases (defaults: 0.9 and 50). `deriveThreshold` computes
  it. Storing it is the decision to act; there is no shadow period.
- **No measurement, no action.** A model without a stored threshold for a kind
  records its answer and the rule decides. A stored threshold retires itself
  when the kind's question or the model version changes.
- **A kind no model can carry stays on its rule.** If no model clears the bar
  for a kind, the rule decides.
- **Failure is loud.** A model that cannot be reached is refused when chosen
  (one test decision through the real route), and repeated provider errors on
  a live kind raise an attention item. A fallback reason is never only a
  ledger value.

## Choosing and changing the model

- **Compared on the same cases.** A comparison asks several models the same
  questions over labelled sets and collected decisions (replayed from their
  stored input, graded by outcome), never pooling the two, and reports per
  (kind, source, model): accuracy, the rule's accuracy, agreement with the
  production model, calibration per signal, the derived threshold, latency and
  cost. `runModelComparison` is the entry point.
- **Every signal is measured.** The comparison derives a threshold on each of
  the four signals: confidence, top p, margin, and calibrated top p. For
  calibrated top p, the isotonic map is fitted on the graded cases, but the
  threshold is swept on cross-fitted values (each case is mapped through the
  map fitted on the other half), so it is never derived on the points that
  shaped the map. The model's derived threshold is the signal that covers the
  most cases. On a tie, confidence or top p is used before margin, and margin
  before calibrated top p. A calibrated top p threshold always carries the
  map it is read through.
- **Offline challengers, not live parallel calls.** Challengers are scored on
  replays, so the live path makes one call per decision.
- **Self-optimizing (opt-in per team).** Weekly per team (a daily cron reaches
  each opted-in team once its last scheduled comparison is a week old), for
  each kind, the candidates (Jev, Clef, Clef Flash and the models the team uses
  now) answer the team's collected decisions of the last 30 days. A model's
  score is the share of cases it would act on and get right at its own derived
  threshold (coverage x precision); it has one only where that threshold
  clears the bar above. The best model replaces the current one only when it
  wins by at least 5 points on the same cases and its test decision passes.
  Ties keep the current model; a kind with too few graded cases, or whose
  current model was not asked every case, is left alone. A switch stores the
  winner's measurement (never loosening a stricter one for the same signal)
  and changes that kind's model only, never the team default. The stored
  measurement names the winner's signal and, for calibrated top p, its
  isotonic map; a calibrated top p result with no usable map has no score.
- **Measurements are shared across teams.** A stored threshold belongs to
  (kind, model), not to a team, so the first winning run for a model creates a
  row that every other team already using that model for that kind also acts
  on. One team's run therefore never revives a retired measurement and never
  replaces one in force on another signal; it leaves that kind on its current
  model instead. Every switch is
  a decision-ledger event (`decision_model_switch`) with the eval run id and
  both scores. `optimizeTeam` is the entry point; a platform admin can run it
  now (`POST /api/admin/decision-model-optimizer`).
- **A hard call cap.** Workers AI is unpriced, so the cost cap cannot bound a
  run: each team run stops starting calls at a call cap, says so, and the kinds
  it cut short are left alone.
- **Undo and revert.** A person can undo a switch; the previous model is then
  pinned for 30 days and the scheduled run leaves that kind alone. Once the
  switched-to model has at least 20 live graded decisions on that kind and its
  acted precision is below the bar it was switched at, the previous model is
  restored without a person, with the same one line and Undo.
- **Data stays where the team allows.** A team's collected decisions are
  replayed to a model provider only if the team opted in to that provider
  receiving them.
- **One bad set never sinks a run.** A labelled set that cannot load (an
  unknown prompt id, a missing template variable) is skipped with its reason,
  and the run completes on the rest. The result lists every set as ran or
  skipped, so a missing set is never read as a missing difference.
- **Synthetic sets are marked.** A threshold derived only from synthetic cases
  is stored as synthetic and is derived again once collected cases for that
  kind reach the minimum. A synthetic result never retires a measurement from
  collected cases.
- **Weighed by how often a kind fires.** Every comparison reports each kind's
  recent volume and the share of it the current model acted on, so a gain is
  read as decisions changed per day, not only as accuracy. The same pair
  ranks where collection work goes first: high volume and a low graded share.
- **Switching never goes silent.** When a person picks a default model, the
  live kinds it has no measurement for are named where they pick it, in one
  line ("Start or wait will follow the rule until this model is measured").
  Picking a model never quietly turns live kinds into recording-only ones.

## Collecting signal

A kind that cannot be graded cannot be measured, so collection is part of the
contract:

- **Replay copy.** Every live kind keeps a redacted, expiring copy of what it
  was asked, so any model can be asked again later.
- **Outcome grade where the truth is mechanical.** Each kind has an outcome
  grader from what happened afterwards (for start or wait,
  `labelDecisionOutcomes`: conflicts, collisions, merge-base refusals and the
  files each task actually touched). A grade is right, wrong or unknown;
  missing or still-open evidence is unknown, never guessed.
- **People's corrections are grades.** When a person changes what a decision
  applied (a role, a category, starting a task a decision held, another
  strand), that change labels the decision.
- **Both branches are graded.** Where one answer produces evidence and the
  other does not (an analysis that ran vs one that was skipped), a small random
  sample of the silent branch is checked so misses are measured, not assumed
  zero.
- **The weekly agent audit** grades a sample of each feature's decisions from
  later evidence (see `decision-kinds`).
- **Coverage is visible.** Feature health reports, per kind, how much is being
  collected (replay copies, graded decisions) before any accuracy figure, and a
  kind collecting nothing says so in words.
- **A kind that never reaches a model is a defect, not a quiet kind.** If a
  kind falls back before asking (for example role pick finding too few
  candidates while the workspace has enough roles that say when to use them),
  that fallback is counted apart from the rule's own decisions and raised.

Where each kind's grade comes from. A kind with no source here records only
until it gets one:

| Kind | Outcome grade | Person's correction | Silent branch |
|---|---|---|---|
| Start or wait (`orchestration_claim`) | `labelDecisionOutcomes` | starting a held task | sample of starts with no overlap evidence |
| Creation manifest (`orchestration_manifest`) | declared paths vs paths the task touched | editing the manifest | none |
| Merge ordering (`orchestration_ordering`) | conflicts and refreshes after the chosen order | reordering | none |
| Post-session triage | the analysis produced a finding that was acted on | a person asking for the analysis | sample of skipped sessions, analysed anyway |
| Task verdict | merged PR vs reopened, reverted or corrected result | `correct_task_result` | none |
| Strand choice | the chosen strand's task finished vs failed or was abandoned | a person moving the task | none |
| Role pick (`task_role`) | the role's task finished without a role change | changing the role | none |
| Task category | type of the merged PR's conventional title | changing the category | none |
| Question and escalation gates | the question was answered vs dismissed or answered with the default | a person overriding the gate | sample of questions the gate let through |

## What the team sees

Flows, not explanations:

- Which model a decision uses, only where it differs from the team default, as
  one line ("Start or wait uses Clef").
- One line when buildd switches a decision's model or switches it back, with
  Undo.
- A decision model that is failing, where it blocks, with the fix.

Scores, thresholds, calibration and comparison runs, which span teams and
models, are operator data and are not part of the team product.

## When this lands, the older specs change

Until then they describe the code as it is:

- `orchestration-decisions-shadow`: hold/start applies a confident START from
  any model with a stored threshold for that kind, not only from Jev
  (`isJevModel`), and the threshold is the stored one, not
  `CLAIM_HOLD_MIN_CONFIDENCE`.
- `decision-kinds`: the measured-model check in a kind's apply step reads stored
  measurements instead of a model list in code (`measuredModels`), and a
  binding's threshold is a default that a stored measurement replaces.
  `shadow` stays only as a rollback setting, never the state a new model starts
  in.

## Acceptance criteria

- AC-1: GIVEN a per-kind model and a different team default WHEN that kind is decided THEN the per-kind model is asked.
- AC-2: GIVEN a model with no stored threshold for a kind WHEN it answers confidently THEN its answer is recorded and the rule's answer applies.
- AC-3: GIVEN a stored threshold on top p WHEN the model's top p is at or above it THEN its answer applies, whatever its confidence field says.
- AC-4: GIVEN a challenger that beats the current model by less than the margin WHEN the scheduled comparison runs THEN the model is not switched.
- AC-5: GIVEN a team that has not opted in WHEN the scheduled comparison runs THEN none of its decisions are replayed to any provider.
- AC-6: GIVEN a switch the person undid WHEN the next scheduled comparison prefers the same challenger THEN the model is not switched while the pin holds.
- AC-7: GIVEN a held task a person then starts anyway WHEN outcomes are read THEN the hold decision carries a human label marking it wrong.
- AC-8: GIVEN a decision whose evidence window has not closed WHEN it is graded THEN it is unknown and is not counted as right or wrong.
- AC-9: GIVEN a comparison over three labelled sets where one has an unknown prompt id WHEN it runs THEN it completes on the other two and lists the third as skipped with that reason.
- AC-10: GIVEN a team switching its default to a model with no measurement for a live kind WHEN the person picks it THEN that kind is named as following the rule until measured.
- AC-11: GIVEN post-session triage skipping a session WHEN that session falls in the sample THEN it is analysed anyway and the skip decision is graded from the result.
- AC-12: GIVEN a workspace with at least two roles that say when to use them WHEN role pick falls back for too few candidates THEN the fallback is counted as a defect, not as a rule decision.
- AC-13: GIVEN a threshold stored from synthetic cases only WHEN collected cases for that kind reach the minimum THEN the threshold is derived again from them.
- AC-14: GIVEN an opted-in team where a challenger beats the current model by 5 points or more on the same cases and passes its test decision WHEN the scheduled comparison runs THEN that kind switches to it, the team default is untouched, and the switch is a ledger event naming the eval run.
- AC-15: GIVEN a switched kind with at least 20 live graded decisions and acted precision below its bar WHEN the daily check runs THEN the previous model is restored.
- AC-16: GIVEN a comparison that reaches its call cap WHEN it stops THEN it names the limit and no kind it cut short is switched.
- AC-17: GIVEN a winning challenger whose shared measurement for that kind is retired, or in force on another signal WHEN the scheduled comparison runs THEN no measurement is written and the kind keeps its current model.

## Out of scope

- Fine-tuning or training models.
- Moving merge readiness to a model: no model clears its rule today.
