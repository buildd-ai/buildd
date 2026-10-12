---
title: Decision Model Selection (Per-Decision Model, Measured Thresholds, Signal Collection)
status: draft
owner: max
last_verified: 2026-10-12
summary: A decision kind MUST act only at a threshold measured for its model on graded cases, MAY switch model when a challenger measurably wins, and MUST collect every grading signal it can.
domain: tasks
surfaces: [packages/core/decision-model.ts, packages/core/decision-client.ts, packages/core/orchestration-outcomes.ts, apps/web/src/lib/prompt-evals/compare-run.ts]
related: [decision-kinds, orchestration-decisions-shadow, settings-models]
keywords: [decision model, jev, clef, clef flash, threshold, calibration, top p, margin, wilson, comparison, replay, outcome, override, champion, challenger, optimizer, undo, signal collection]
verified_by: []
assertions:
  - id: decision-model-lookup
    type: symbol
    name: decisionModelFor
    path: packages/core/decision-model.ts
  - id: decision-model-normalize
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
- **Offline challengers, not live parallel calls.** Challengers are scored on
  replays, so the live path makes one call per decision.
- **Self-optimizing (opt-in per team).** On a schedule, for each kind, the
  model with the highest share of cases it would act on and get right, at its
  own derived threshold, replaces the current one only when it wins by a clear
  margin on the same cases and its test decision passes. Ties keep the current
  model. Every switch is recorded with the comparison it came from.
- **Undo and revert.** A person can undo a switch; the previous model is then
  pinned for a while. If live graded decisions show the new model below the
  bar, the previous model is restored without a person.
- **Data stays where the team allows.** A team's collected decisions are
  replayed to a model provider only if the team opted in to that provider
  receiving them.

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

## What the team sees

Flows, not explanations:

- Which model a decision uses, only where it differs from the team default, as
  one line ("Start or wait uses Clef").
- One line when buildd switches a decision's model or switches it back, with
  Undo.
- A decision model that is failing, where it blocks, with the fix.

Scores, thresholds, calibration and comparison runs, which span teams and
models, are operator data and are not part of the team product.

## Acceptance criteria

- AC-1: GIVEN a per-kind model and a different team default WHEN that kind is decided THEN the per-kind model is asked.
- AC-2: GIVEN a model with no stored threshold for a kind WHEN it answers confidently THEN its answer is recorded and the rule's answer applies.
- AC-3: GIVEN a stored threshold on top p WHEN the model's top p is at or above it THEN its answer applies, whatever its confidence field says.
- AC-4: GIVEN a challenger that beats the current model by less than the margin WHEN the scheduled comparison runs THEN the model is not switched.
- AC-5: GIVEN a team that has not opted in WHEN the scheduled comparison runs THEN none of its decisions are replayed to any provider.
- AC-6: GIVEN a switch the person undid WHEN the next scheduled comparison prefers the same challenger THEN the model is not switched while the pin holds.
- AC-7: GIVEN a held task a person then starts anyway WHEN outcomes are read THEN the hold decision carries a human label marking it wrong.
- AC-8: GIVEN a decision whose evidence window has not closed WHEN it is graded THEN it is unknown and is not counted as right or wrong.

## Out of scope

- Fine-tuning or training models.
- Moving merge readiness to a model: no model clears its rule today.
