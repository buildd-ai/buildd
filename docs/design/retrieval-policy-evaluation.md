# Retrieval Policy Evaluation — offline replay before online learning

**Status:** Proposed
**Related:**
- `docs/design/mission-context-clusters.md` — the recipes and the assembly record this evaluates
- `packages/core/retrieval-clusters.ts` — the recipe registry and the closed vocabulary
- `packages/core/scripts/eval-retrieval.ts` — recall@k / MRR / NDCG harness to reuse
- `packages/core/scripts/eval/golden-queries.json` — the query format replay must emit
- `packages/core/eval/regression.ts`, `packages/core/eval/retrieval-baseline.json` — thresholds and baseline
- `packages/core/knowledge-store/pg-vector-store.ts` — `_finalize`, `_graphExpand`, and the missing time filter
- `packages/core/db/schema.ts` → `knowledgeIngestJobs.changedFiles` — the diff label

---

## Problem

`tool-infra-error-v1` shipped with a fallback rate and a weak-escalation rate
that are readable from logs, and nothing else. Those two numbers can tell us a
recipe is broken. They cannot tell us it is **better than the fan-out**, and they
cannot compare two candidate recipes at all.

The obvious next move is to wait for production volume. That is slow and, for
this recipe, may never arrive: scope is thirteen scanner slugs with
`worker-failure:*` deliberately excluded, so the eligible population is small by
construction. Waiting for enough claims to compare cohorts means waiting a long
time to learn something a replay could answer this week.

Meanwhile the thing that made comparison impossible historically is now fixed:
until PR #2138 the system recorded *what* it retrieved (global per-chunk hit
counters) but never the retrieval **action** — which recipe ran, which keys it
derived, which items it selected, and why. The assembly record adds exactly that.
So the state side and the action side both exist now. The outcome side has
existed all along, in task status, PRs, and criterion transitions.

Which raises the actual question: **can historical tasks bootstrap the
comparison, without rerunning anything?** Mostly yes — but not the way it first
looks, because the naive version scores near-perfectly while measuring nothing.

## Current state

What we can reconstruct for a historical task, and what we cannot.

**Available.** Task goal and description; `subjectKind` and the projected
subject columns; `pathManifest`; `missionId` and the criterion state with its
rearm fields; the worker's `prNumber` / `prUrl` / `mergedAt` /
`prLifecycleStatus`, `commitCount`, `filesChanged` (a **count**, not a list),
cost and token totals; and `knowledgeIngestJobs.changedFiles` — a `string[]` of
the paths in each merged-PR diff ingest, keyed by `prNumber` and `sha`.

**Not available.** Four gaps, each of which changes the design:

1. **No time filter on queries.** `QueryParams.filters`
   (`knowledge-store/types.ts:126-129`) offers `corpus` and `sourceType` and
   nothing else. There is no way to ask a namespace what it contained on a past
   date.
2. **`QueryResult.createdAt` is not a creation time.** It maps to
   `row.updated_at` (`pg-vector-store.ts:855`), which is last-ingest time.
   `knowledge_chunks` has no `created_at` column at all — only `updated_at`
   (`defaultNow`, `notNull`) and a nullable `source_ts`. For code and docs,
   `updated_at` is rewritten on every full ingest, so it carries no information
   about when the underlying work happened.
3. **`code` and `docs` have no history.** `pruneOrphans`
   (`knowledge-store/ingest.ts:220-236`) deletes every stored path absent from
   the current tree, so those namespaces are HEAD-shaped by construction. There
   is no corpus state to replay against for an old commit; files deleted since
   are simply gone.
4. **`workers.observedTouches`** — the per-worker list of files actually touched
   — is cleared on terminal worker status (`workers/[id]/route.ts:840`), so it
   does not survive for historical tasks.

`source_ts` is the one real event timestamp, and it is populated where a chunk
was mirrored from a dated event (`mcp-tools.ts:1441`, `:1478`) rather than from a
file.

## Proposal

Four stages, in order, each gated on the previous one producing a number.
**Historical retrieval replay → historical agent replay → controlled online A/B
→ contextual bandit.** Not "train a policy".

The framing for stage 4 is **offline policy evaluation over a small set of
auditable recipes**, not reinforcement learning over context. The action space is
`{ default fan-out, tool-infra-error-v1, conflict-v1, … }` — on the order of
single digits — and each action is a deterministic recipe whose behaviour is
already recorded per item. That is what keeps the provenance property intact:

```
state → choose recipe → deterministic recipe retrieves → outcome
```

rather than

```
state → policy invents arbitrary context
```

A policy that selects chunks directly has an action space the size of the corpus
and produces assemblies nobody can audit, which would discard the one thing the
clusters design was built to establish.

### The crux

**Replay must reconstruct what was retrievable at the time, and the naive
version cannot, because a task's own outcome is in the corpus.**

On task completion, `mirrorWorkProduct` writes the task's summary into the
`task` corpus (`mcp-tools.ts:1444`) and its PR into the `pr` corpus (`:1549`).
So replaying task T's retrieval against today's namespaces retrieves **T's own
completion summary and T's own PR** — which are precisely the labels the
evaluation intends to score against.

Every policy then looks excellent, the differences between policies vanish into
a shared ceiling, and the resulting benchmark is a green check over an empty
set. This is the same defect the clusters design kept citing, arrived at from a
new direction, and it is the reason to state it as the crux rather than as a
caveat: **if as-of reconstruction is not solved, stage 1 produces a number that
is worse than no number, because it looks like evidence.**

Two things follow, and both are requirements rather than refinements.

**Self-exclusion is mandatory and must fail closed.** Every replay query
excludes chunks attributable to the task under evaluation and to its worker and
PR. A replay that cannot identify the task's own chunks must **refuse to score
that task**, not score it anyway. A silent miss here inflates every number
uniformly, which is the hardest kind of error to notice.

**As-of filtering needs a real cutoff, and only some corpora can have one.** The
honest split:

| Corpus | As-of possible? | How |
|---|---|---|
| `task`, `pr`, `memory` | Yes | `source_ts` cutoff at the task's start, where populated; refuse rows with a null `source_ts` rather than assuming they are old |
| `code`, `docs` | **No** | HEAD-only; `pruneOrphans` deleted the history |

So stage 1 is really two experiments that must never be added into one number:

- **As-of replay** over `task` / `pr` / `memory`. Defensible: the corpus is
  restricted to what existed, and the recipe's own steps 1-3 are exactly these
  corpora.
- **Present-corpus replay** over `code` / `docs`. Measures whether the recipe's
  *key derivation* beats prose against an identical corpus — a real question,
  and the one step 4 turns on — but it says nothing about what the worker could
  have found at the time. Reported separately, labeled as such.

Implementing the cutoff means adding a `sourceTsBefore` filter to `QueryParams`
and applying it **inside** the ranking, not after. Post-filtering a `topK` result
set and calling the remainder recall@k is wrong: the ranking already spent its
budget on rows that were then discarded, so the metric measures a shorter list
than it reports.

### Stage 1 — historical retrieval replay

For a sample of historical tasks, reconstruct the query the recipe would have
built and run each candidate policy against the as-of corpus.

The label is the **actual merged diff**, from
`knowledgeIngestJobs.changedFiles` joined on `workers.prNumber`. This is the
detail that makes the stage cheap: the file list is already stored locally, so no
GitHub API pass and no rate limit.

**Do not use `tasks.pathManifest` as the label.** It is the *declared* manifest,
and the recipe's steps 3 and 4 key on it — scoring a recipe against its own
input measures nothing but a join. That circularity is easy to introduce and
invisible once it is in.

The generated dataset is the shape the existing harness already reads:

```json
{ "id": "<taskId>", "corpus": "pr",
  "query": "<derived key, e.g. the error signature>",
  "expectedSourcePaths": ["<paths from the merged diff>"] }
```

so `eval-retrieval.ts` scores recall@5 / recall@10 / MRR / NDCG@10 unchanged,
and `eval/regression.ts` thresholds apply.

**One trap that will silently zero the score.** `golden-queries.json` documents
its own convention: source paths are root-relative *within each sub-app or
package* — `core/knowledge-store/pg-vector-store.ts`, not the repo-relative
form with a `packages/core` prefix — because that is how ingestion stores
them. A generator
emitting repo-relative paths — which is what `changedFiles` and `pathManifest`
both contain — scores zero recall on every query and looks like a retrieval
failure rather than a path-format bug. So the generator normalizes, and the
first thing the runner asserts is a **non-zero baseline recall on the existing
curated set**. A replay run that scores zero everywhere must fail rather than
report.

What stage 1 answers: does a policy surface the files, prior PRs, and memories
the work eventually touched, before the worker discovered them itself? Plus the
cheap operational figures — fallback rate, escalation rate, retrieved-token cost,
and how much retrieved context the diff never touched.

It is a weak label. It is not proof the context would have caused success. It is
an automatic relevance signal available across the whole task history at
approximately zero marginal cost, which is a much better basis than invented
synthetic queries.

### Stage 2 — historical agent replay

For a much smaller sample, restore the task at its original starting state and
run the worker under different context policies, scoring criterion movement,
tests, task success or refusal, retries, corrective follow-up tasks, and
tokens/time.

This is the first stage producing counterfactual evidence: *for approximately the
same state and task, policy B succeeded more often than A.*

Two things to size honestly before committing to it:

**Agent runs are non-deterministic, so an arm is a distribution, not a result.**
The number of runs per arm is set by the effect size worth detecting and the
baseline success rate — and the baseline rate is something stage 2 must *measure
first* rather than assume. Required sample grows with the inverse square of the
effect size, so the difference between "detect a large effect" and "detect a
modest one" is one or two orders of magnitude in cost. This is the stage where
the plan can quietly become unaffordable, so the run count comes out of the
observed baseline, not out of a guess.

**Replay must not be able to starve production work.** Worker runs consume the
same team budget and the same OAuth session capacity as real tasks, and budget
exhaustion already manifests as work stalling until a runner restart. So replay
runs under a separate account or workspace with its own `monthlyBudgetUsd`, and
the record marks them `source: 'eval'` — the discriminator the assembly record
already carries for exactly this reason.

Stage 2 is also where "approximately the same state" needs stating plainly: the
`code` corpus is HEAD, the repo can be checked out at the original SHA, and those
two disagree. Either accept the mismatch and say so, or restrict stage 2 to tasks
recent enough that the corpus has not moved much. The mismatch is not fatal, but
a comparison that hides it is.

### Stage 3 — controlled online A/B

Randomize recipe selection for eligible claims and compare arms on the same
outcome set as stage 2, with the assembly record supplying the action side.

This is the first stage whose evidence is not conditional on a reconstruction
argument. It is also the first that can hurt production, so it needs the ordinary
protections: an eligibility predicate narrow enough to reason about, an arm that
is exactly today's behaviour, and a kill switch that returns every claim to the
fan-out.

### Stage 4 — contextual bandit

State: `subjectKind`, `OrganizerCause`, error signature, path count, task
history, corpus availability, and the retrieval-confidence figures the record now
carries. Action: one of a handful of recipes. Reward: deliberately boring —

```
+ task succeeded
+ criterion advanced
- rearm or refusal
- corrective task filed soon after
- excessive retrieved tokens
```

Every term is already recorded or derivable, and every term is arguable, which is
the point: a reward nobody can dispute the derivation of is worth more here than
a clever one.

**One thing must be recorded from the moment stage 3 starts, or stage 4 is
impossible.** As soon as selection stops being deterministic, the logged data is
off-policy, and off-policy evaluation needs the **propensity** — the probability
the acting policy assigned to the action it took — alongside the policy's own
identity. Without it, later analysis cannot correct for the fact that the logs
over-represent whatever the deployed policy preferred, and no amount of volume
fixes that afterwards.

This is the same lesson as the chain identifiers in the clusters design: the
field is cheap to write now and unrecoverable later. So `selection: { policyId,
propensity }` goes on the assembly record in the same change that introduces
randomized selection — not in the change that first wants to learn from it.

## The decision record — what to log now

The four stages above are worthless if the decision-time record is missing a
field, because **the missing field is never recoverable**. Everything in this
section is cheap; the point of listing it is that each item costs nothing today
and cannot be added retroactively at any price.

**One guard first, because it cuts against the instinct this whole document
encourages.** Booking.com measured a Pearson correlation of roughly **-0.1**
between offline metric gains and business-value gains across a couple of dozen
model comparisons. So: log the fields, they are genuinely unrecoverable — but do
**not** build the estimator layer to match. With an action space of about five
recipes, a sequence of small online experiments may beat an offline
policy-evaluation programme outright. Build the log; be sceptical of the
machinery.

### What the record already has

`assemblyId`, `at`, `recipe`, `source`, `workspaceId`, `teamId`, `trigger`,
`derivedKeys`, `items[]`, `weakEscalationFired`, `fallbackFired`, and
`chain{taskId, workerId, missionId}`.

That covers the decision key, the tenancy scope, the decision timestamp, and —
via `(taskId, at)` ordering — the position of a decision within its task. The
last one is load-bearing and easy to mistake for redundant: **`at` is what makes
the ordered decision path reconstructable**, and every credit-allocation method
beyond last-touch takes that ordered path as its input.

### What is missing, ordered by regret

**1. The candidate set.** `candidates[]`, each with `eligible` and, when not,
`ineligibleReason`. We log which recipe ran and never which recipes were
*offerable*. Corpus availability, flags and rollouts all shift, so "not chosen"
becomes indistinguishable from "not offerable", and a forced move reads as a
preference. This is the field most likely to be skipped and most regretted:
Yahoo's news-recommendation logs omitted exactly this, leaving unlogged
business-rule constraints across every serving bucket that had to be corrected
for after the fact.

**2. `selected` versus `executed`, plus `overrideSource`.** Two columns wherever
anything can change the action after selection. **We have this hazard live
today**: `selectExecCluster` picks a recipe, and if it yields nothing renderable
the default fan-out serves the request instead. The record encodes that only as
`fallbackFired: true` — an analyst has to know that flag means "executed was
actually the fan-out". Make it explicit. Microsoft's Decision Service measured a
**3.0x** train/test discrepancy from precisely this bug, where logged
probabilities corresponded to the chosen action while the *overridden* action was
the one recorded.

**3. `actionExecuted`.** Was the assembled context ever actually put in front of
an agent? We log at claim time; the worker can die, the task can be cancelled,
the output can be discarded. Without this field every such row becomes a
**fabricated zero reward**, which is worse than a missing row. Azure Personalizer
built a whole Activate API for this: content never shown must not be assumed to
have earned the default reward.

**4. `contextSnapshot` — the literal values the selector consumed.** Task kind,
error signature, path count, corpus availability, as inline literals rather than
references or a recompute recipe. Rows mutate between decision and analysis, and
any feature the rule used but we did not log becomes unobserved confounding —
which biases the estimators with no diagnostic able to detect it.

  **Sub-requirement, non-obvious and worth its own line: log `pathCount` raw,
  never pre-bucketed.** Under a deterministic logging policy the one consistent
  estimator available is a regression-discontinuity argument around a threshold,
  and it only works on a continuous variable. Bucketing at write time destroys
  the sole viable estimator for the data we are actually collecting.

**5. `propensity`, and `propensityVector` over the candidate set. Log `1.0`
today.** Selection is deterministic, so the value carries no information yet —
but propensity is a property of the sampling *event*, not of the state, and the
rule table is versioned and will change. Logging it now means the day a
randomization floor is added there is no migration and no discontinuity in the
table.

**6. `policyVersion` and `recipeDescriptor`.** Which rule table decided, and a
config fingerprint of the recipe *as it then was* — its `topK`, corpora,
thresholds, template version, not just its name. We will tune
`MIN_STRONG_BY_SIGNAL`, and `tool-infra-error-v1` under two different threshold
sets is two different actions silently pooled under one id, with no way to unpool
them later.

**7. `decisionIndexWithinTask`.** Derivable from `(taskId, at)` today, so this is
belt-and-braces — but it makes the episode position explicit rather than an
artefact of a sort order someone could reasonably "clean up".

**8. `sampleProb` — one uniform draw, stored at decision time.** A stable
train/eval partition key. Drawn later, the split shifts on every re-join and
silently invalidates cross-run comparisons.

**9. `schemaVersion`.** No jsonb payload in this repo carries one. For a record
intended to feed analysis, changing a field's meaning midway corrupts every prior
row with nothing marking the boundary.

### The outcome side, and one rule about it

Outcomes stay **out** of the decision record and are joined. Three requirements:

**Never scalarize.** Log `taskSucceeded`, `criterionAdvanced` (and which),
`refused` (and kind), `correctiveFollowUp` (and which), plus latency and cost, as
**separate raw indicators, each with its own event time**. Two independent
reasons. First, a scalar cannot be re-scored under a revised definition and the
definition will be revised. Second, and sharper:
`criteriaRearmCycles`-style progress signals are *shaping* rewards, and shaping
rewards change the optimal policy when they are not potential-based — so
collapsing one into a scalar alongside task success at write time bakes in a
distortion. Weighting is an offline decision precisely so it can be changed. (A
technical corollary: the IPS estimator is not equivariant, so even translating a
reward by a constant changes the finite-sample estimate.)

**Three timestamps, not one.** Decision time, outcome event time, and outcome
*ingest* time. Without ingest time we cannot reconstruct what was knowable at a
past moment, so every backfilled or corrected outcome leaks into any later
analysis; without both we cannot distinguish "no outcome" from "outcome has not
arrived yet".

**The attribution link is written by the outcome producer.** When a PR merges or
a criterion flips, that event records the ordered list of decision ids in the
episode — it is not inferred afterwards. Recording only "the decision before the
merge" hard-codes last-touch attribution into the data, and no later method can
undo it. Keep the credit rule as an offline function over the stored path.

Also: make the outcome column **accumulate-and-retract**, not last-write-wins. A
PR that merges and is then reverted *is* a retraction, and last-write-wins
destroys the fact that it changed.

### What needs nothing logged

Worth stating so it does not become a schema discussion later. Direct-method and
doubly-robust estimators fit their reward model offline from the fields above, so
"adopt DR" is never a schema item. Learned action embeddings are unnecessary at
this action-space size — the config fingerprint is the cheap structural
substitute. Slot and position fields do not apply: one recipe is chosen, not a
ranked slate.

### The one thing determinism costs us

Worth being explicit because it bounds what stage 3 can ever deliver. Under a
fully deterministic logging policy the failure is **directional, not just
noisy**: importance-weighted estimators systematically *underestimate* a target
policy's value, because every disagreement between target and logging policy
contributes zero and improvement is never credited. Standard tooling refuses the
data outright rather than returning a biased number.

The honest mitigation is an **epsilon floor over the eligible set** — a few
percent exploration, which at this action-space size costs very little and is
what makes the propensity fields above mean anything. "We will estimate the
propensities later" does not work: the method that would do so assumes the policy
actually *varied*, and a frozen rule table closes that door.

## Safety

- **Replay is read-only by default.** Stage 1 issues queries and writes no
  chunks. Every replay query passes `trackHits: false`, as
  `eval-retrieval.ts` and `assess-knowledge.ts` already do, so replay cannot
  move the per-chunk hit counters that other features read.
- **Eval records never join live cohorts.** `source: 'eval'` on every assembly
  the replay produces; cohort queries filter on it. Without this a replay run
  silently doubles the denominator of the live fallback rate.
- **Stage 2 spends real money and real session capacity.** Separate account or
  workspace, own budget cap, and no ability to claim production tasks. A replay
  that can exhaust the team's OAuth budget converts an experiment into an
  outage.
- **Stage 3 defaults to the current behaviour.** The control arm is today's
  fan-out, eligibility is an explicit predicate, and a single switch returns
  everything to it.
- **Scoring must fail closed.** A task whose own chunks cannot be identified is
  refused, not scored. A replay run whose baseline recall on the curated set is
  zero fails rather than reports. Both defaults exist because the failure mode
  here is an inflated number that looks like a result.
- **Replay reads production data by construction** — task text, error
  signatures, diffs. It stays server-side and database-only; the generated
  dataset is not committed, and nothing derived from real tasks goes into
  `golden-queries.json`, which is a tracked file in a public repo.

## Implementation sketch

The load-bearing piece is the as-of cutoff, because every number in stage 1 is
uninterpretable without it.

0. **The decision-record fields above**, in the regret order given. Independent
   of every stage below, cheap, and the only item here that is *unrecoverable*
   if deferred — a stage-1 replay can be re-run next month, a decision not
   logged today cannot. Candidate set, selected-vs-executed, and
   `actionExecuted` first; those three are the ones with published failure
   costs attached.
1. **`sourceTsBefore` on `QueryParams`**, applied inside the ranking. Plus
   self-exclusion by task, worker, and PR, failing closed when attribution is
   unavailable.
2. **Replay dataset generator.** Historical task → derived keys → the
   `golden-queries.json` entry shape, with `expectedSourcePaths` from
   `knowledgeIngestJobs.changedFiles` normalized to the ingestion path
   convention. Asserts non-zero baseline recall on the curated set before
   emitting anything.
3. **Policy runner.** Run N policies over the generated set through the existing
   harness, reporting as-of and present-corpus results **separately**, never
   summed.
4. **Read the result before building stage 2.** If policies are
   indistinguishable on the weak label, that is the finding, and agent replay is
   the wrong next spend.
5. **Stage 2 harness**, sized from the measured baseline success rate, under its
   own budget.
6. **Randomized selection with `selection: { policyId, propensity }`** on the
   record from the first commit.

## Open questions

- **Whether to run an offline policy-evaluation programme at all.** The
  Booking.com calibration above (~-0.1 correlation between offline metric gain
  and business value) argues for logging the fields and then reaching for small
  online experiments rather than estimators. At roughly five recipes I lean that
  way: build the log, skip the machinery, revisit if the action space grows.
- **Sample size and selection for stage 1.** A uniform sample of history is
  simplest and over-weights whatever the system did most of. Stratifying by
  `subjectKind` and cause gets a more useful spread but makes the aggregate rate
  no longer a population estimate. I lean stratified with the strata reported
  separately, and no pooled number.
- **What counts as a hit for a memory chunk.** Diff paths score `code` and `pr`
  naturally. Memory chunks have no `sourcePath` at all, so `expectedSourcePaths`
  cannot score step 1 — the recipe's *first* step is the one the label cannot
  reach. Options: score memory only on whether a later successful task cited the
  same chunk, or leave step 1 unscored in stage 1 and admit it. I lean admitting
  it, loudly, over inventing a proxy.
- **Whether to fix `QueryResult.createdAt`.** It reports `updated_at` under a
  name that means creation, which also means `isStaleBaseline`'s 14-day
  "MAY ALREADY BE SHIPPED" window is measured off re-ingest time rather than off
  when the work shipped — a live bug in a warning agents act on, found while
  establishing whether replay could use the field. It wants its own change; the
  question is whether replay should wait for it. I lean no, and use `source_ts`.
- **How to handle tasks with no merged PR.** Refusals, superseded tasks, and
  tasks that ended in a corrective follow-up have no diff and therefore no
  label. Dropping them biases the set toward work that succeeded, which is
  exactly the population where retrieval mattered least. No good answer yet.
- **Whether stage 3 is worth it given the eligible population.** With scope at
  thirteen slugs, randomized online selection may take a very long time to reach
  significance. Stage 1 and 2 may be the whole of what is affordable until the
  scanner catalog widens.

## Non-goals

- **No RL over chunks, ever.** The action space is a small set of named,
  deterministic, auditable recipes. A policy that assembles arbitrary context
  destroys the provenance property that
  `docs/design/mission-context-clusters.md` exists to establish, and it is not a
  tradeoff worth making for any accuracy gain.
- **No learned policy before stage 1 produces a comparison.** The order is the
  design.
- **No new metrics.** recall@k / MRR / NDCG through `eval-retrieval.ts` and
  `eval/regression.ts`. Inventing a bespoke score here would make the result
  incomparable to the existing baseline for no gain.
- **No claim of causality from stage 1.** Weak labels over a reconstructed
  corpus support "this policy surfaced what the work touched", not "this policy
  caused the work to succeed".
- **No historical `code` corpus.** Rebuilding per-commit code namespaces is a
  far larger project than this and is not required for any stage above.
- **Not a benchmark for publication.** This is an internal decision aid. The
  dataset is derived from production tasks and stays private; see Safety.
