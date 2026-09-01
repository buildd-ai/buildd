# Task model visibility

**Status:** Implemented
**Related:** `packages/core/db/schema.ts` (`tasks.tier`, `tasks.predicted_model`,
`task_outcomes.actual_model`), `apps/web/src/app/api/workers/claim/route.ts`,
`apps/runner/src/prompt-builder.ts` (`resolveSessionModel`),
`apps/web/src/lib/usage-stats.ts` (`buildModelRollup`),
`apps/web/src/app/app/(protected)/health/HealthClient.tsx`,
`docs/specs/model-routing-and-tiers.md`, `docs/specs/usage-and-cost-accounting.md`

## Problem

You cannot tell, from any surface in the product, which model a task ran on.

The data is there. Three values are persisted per task and they are allowed to
disagree:

| | Meaning | Storage | Written by |
|---|---|---|---|
| **Requested** | The tier the caller asked for | `tasks.tier` (nullable) | `POST /api/tasks` |
| **Resolved** | The concrete id the router picked | `tasks.predicted_model` + `context.resolvedTier{tier,provider,source}` | claim route |
| **Actual** | What the SDK reported running | `worker.result_meta.modelUsage` keys, `task_outcomes.actual_model` | worker PATCH |

Not one of the three is rendered as a model anywhere a person looks at a task.
The task detail page's own `Details` disclosure exists for "billing, routing,
debugging" and lists Priority, Runner, Backend, Claimed by, Workers, Created and
Task ID — but not the model. Neither task-list select fetches `tier` or
`predicted_model` at all, so the grid could not show it even if it wanted to.

Fleet-wide it is worse than absent, it is thrown away. `buildModelRollup`
already computes per-model tokens, cost and share keyed by the actual model id,
the Health page pays for it on every load, and `HealthClient.tsx:1002`
destructures `{ totals, perTask, tools, groups, window }` — dropping `byModel`
on the floor. Same shape as the five mechanisms revived in #1987: computed,
then discarded.

Two consequences that have already cost real money and went unnoticed for
months because nothing displayed a model:

- The standard tier sat on a model that was both a generation old and 50% more
  expensive per token than its replacement (#2012). It was caught by a person
  reading a config file, not by a surface.
- Until #1988 the runner discarded the resolved model entirely and ran its own
  global `MODEL`, so *resolved* and *actual* disagreed for every task in the
  fleet. Nothing measured the disagreement, so nothing reported it.

## Current state

Verified against `origin/dev` at the time of writing, because much of this
changed the same day:

- The runner **does** honour the resolved model: `resolveSessionModel(task.context,
  this.config.model)` in `apps/runner/src/workers.ts`, passed to the SDK as
  `model: sessionModel`, including the Codex path (#1988).
- `actualModel` **is** resolved from `result_meta` in the worker PATCH and **is**
  passed to `recordTaskOutcome`, so `task_outcomes.actual_model` is populated
  going forward. Rows written before that remain NULL and must be excluded from
  any rate, not counted as agreement.
- Per-task cost has a runner self-report path and an `effectiveCost` fallback
  derived from `modelUsage`.

Three known shapes any renderer must survive:

1. `predicted_model` is polymorphic — a full id normally, but a bare alias
   (`sonnet`/`haiku`/`opus`) when the task has no team, and a user-pinned id on
   the explicit-override path (where `context.resolvedTier` is **absent**, so
   there is no tier to show).
2. `modelUsage` can name **several** models — a fallback firing is a real
   feature — so "the model it ran on" is not always singular.
3. On seat/OAuth auth `modelUsage` is empty by construction, and a Codex worker
   reports the literal string `codex`. `priceForModel` matches by substring and
   silently falls back to Sonnet pricing, so `codex` is currently *priced as
   Sonnet*.

## Proposal

Show the **tier as the primary label and the concrete id as secondary**, on the
surfaces where the answer is actionable, and report the fleet distribution plus
the one number that would have caught both incidents above: how often actual
disagrees with resolved.

**Crux: divergence is the product, not a footnote.** If the only goal were
labelling, `tasks.tier` alone would do and this would be a one-line change. The
reason to build it properly is that the three values disagreeing is the failure
mode — a stale tier, a runner ignoring its instructions, a silent fallback — and
each of those is invisible today. If that is wrong, and the tiers are in practice
always in agreement, then the divergence metric is noise, the `DerivedMetric`
plumbing is wasted, and the honest version of this design collapses to "add a
`<dt>` to the details list".

### One shared humaniser, first

There are four independent implementations of "turn a model id into a name", and
one of them is wrong: `team/[slug]/page.tsx` maps `role.model === 'opus'` to the
literal `'Claude Opus 4'`, so it mislabels the current premium model by two
generations. The best implementation is `getModelDisplayName` in the runner's
`ui/app.js` (a name map plus a `claude-(\w+)-(\d[\d.]*)` fallback).

Extract it to `packages/core` beside `model-tier-defaults.ts` (documented as
dependency-free and safe to import anywhere), retire the other three onto it,
and fix the stale map. This is a prerequisite: shipping a fifth humaniser inside
a task card is how this becomes unfixable.

### Surfaces

| Surface | Renders | Why here |
|---|---|---|
| Task detail — `Details` disclosure | Tier, concrete id in mono beneath, and `source` (`workspace`/`team`/`default`) | The disclosure's stated purpose is billing/routing/debugging. "Why did it pick this?" is the question people actually ask, and `source` is the only field that answers it |
| Task detail — triage row, pending only | Tier word only | Already renders `runner · backend` for the pending family as the "should this run, and how?" inputs. Tier belongs in that sentence, and pre-flight is the one moment it is still changeable |
| Worker view — existing Model Usage panel | Tier prefix + humanised ids | Already lists what actually ran, including mid-run fallbacks. Highest-truth surface; only needs the shared humaniser instead of `.replace('claude-','')` |
| Health — Consumption section | The discarded `byModel` rollup, plus counts and divergence | Zero new queries for the rollup itself |

Follow the existing "primary + secondary" idiom rather than inventing one:
`ModelPicker` already stacks a display name over `font-mono text-[10px]
text-text-muted`, and chips put secondary detail inline at `opacity-70`.

### Health metrics

Ordered by value per unit of risk:

1. **Tokens, cost and share by model** — already computed, currently discarded.
2. **Workers reporting each model** — one counter in the existing rollup. Labelled
   "workers reporting this model", not "workers", because a multi-model worker
   counts in more than one bucket.
3. **Divergence rate** — resolved versus actual, over an explicit `n of m`
   denominator, excluding workers with no model attribution rather than
   counting them as agreement.

Divergence needs alias normalisation before comparison: `predicted_model` may be
`sonnet` where `modelUsage` says `claude-sonnet-5`. Compared naively it reports
100% divergence, which is fiction.

**Deliberately not** a success or failure rate by model. Model choice correlates
with task difficulty — premium gets the hard work — so a per-model success rate
invites exactly the wrong conclusion. Spend and distribution are unambiguous; a
quality metric here is not.

## Non-goals

- **No schema change.** All three values are already persisted.
- **No change to which model a task gets.** One additive write was needed: the
  claim route now records `context.routingReason` (the router's own
  `explicit_override` / `baseline` / `budget_downshift` / `paused`). It is
  diagnostic only — nothing reads it to choose a model. Without it, "why this
  model?" is unanswerable after the fact, because `context.model` is overwritten
  at claim time: an explicit pin becomes indistinguishable from a tier
  resolution that happened to match, and a budget downshift looks like a
  deliberate choice. Fill-forward — rows claimed before it shipped report
  unknown rather than a guess.
- **No model label on the mission timeline or the grid's `inline` density.** One
  13px line with an either/or right slot; a model token there costs the elapsed
  time or the merge status, and the timeline's job is sequence and blocking.
- **No colour-coded tier.** `premium` is not a warning and `budget` is not an
  error. A coloured chip would compete with `StageChip`, which must win the eye.
- **Not making seat/OAuth auth attributable.** `usage.byModel` is empty there by
  construction. Render an em-dash with a reason, never a zero.

## Open questions

1. **RESOLVED — no model label in the task grid row.** The only place it fits is
   one more `·` token on the existing muted meta line. If the real need turns out
   to be "which of these rows burned premium", the honest answer is a filter or a
   grid-level grouping, not a label repeated down every row. Cheap to add later,
   hard to remove once people scan for it.
2. **OPEN — should `context.model` stop being overwritten at claim time?** The
   claim route writes the resolved id over the requested value in place.
   `tasks.tier` survives, so the *tier* is always recoverable, but an exact
   pinned request is not distinguishable afterwards from a resolution that
   happened to match. Leaving it for now: the fix is a `requested_model` column
   and this design promised no schema change. The cost is that the detail page
   cannot say whether a pin was honoured or merely coincidental — it can only say
   what was pinned and what ran.
3. **RESOLVED — a diverging task shows a marker on its own detail page**, as
   muted text and not a warning colour. A fallback firing is normal; only the
   fleet aggregate is alarming. Health reports the rate, the task page tells you
   which task caused it.

   Corrected during implementation: the marker was first placed beside the model
   row inside the `Details` disclosure, which is collapsed — so it was only ever
   visible to someone who had already gone looking for it, which is precisely
   the audience that does not need prompting. It now renders on the per-worker
   line that is visible by default, beside that worker's turns and cost. That is
   also the more correct altitude: divergence is a per-worker fact, since a
   retry is a second worker and a fallback fires inside one.

4. **RESOLVED — "Pinned" requires evidence, not inference.** A pin was initially
   inferred from "a concrete model id and no `resolvedTier`". That is what a pin
   looks like, but it is also what every task claimed before `resolvedTier`
   existed looks like, so the label would have asserted a decision nobody made
   on historical rows. It is now driven by the recorded `routingReason`; with no
   reason recorded, the requested tier stays the label and no pin is claimed.
