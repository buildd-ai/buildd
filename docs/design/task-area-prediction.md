# Predicting a task's file area from what similar completed tasks touched

**Status:** Implemented
**Related:** `packages/core/task-area-prediction.ts`, `packages/core/task-area-prediction-source.ts`, `packages/core/task-area-readout.ts`, `packages/core/task-area-readout-source.ts`, `packages/core/scripts/task-area-readout.ts`, `packages/core/experiment-randomizer.ts`, `packages/core/task-path-inference.ts`, `packages/core/db/schema.ts` → `taskAreaPredictionEvents`, `apps/web/src/app/api/workers/claim/context-injection.ts`, `apps/runner/src/task-memory-retrieval.ts`, `docs/design/experiment-lifecycle.md`, `docs/design/workspace-memory-digest-arm.md`

## Problem

The `### Relevant to This Task` block picks memories in ordered steps —
declared paths (`tasks.path_manifest`), then paths regexed out of the task's own
text (`inferPathsFromText`), then title tokens — and the store behind it has no
relevance ranking, so within a step it falls back to most-recently-updated.

Measured over the memory-digest experiment's cohort: about **6%** of prompts
matched on a declared manifest, **~57%** on regex-inferred paths, **~36%** on
title tokens. So most "relevant" memories reaching an agent are selected by a
regex over prose and sorted by recency. That is the weak point, and it is a
plausible reason the memory-digest experiment could not detect a quality
difference in either direction: the content of the block was varied while the
selection of what went in it stayed noisy.

## Proposal

Compute the neighbourhood **at query time**, from stores that are already
maintained. No new store, no clustering, no labels, no index to refit:

1. Retrieve the top-k **completed** tasks most similar to the new task's title
   and description. The `task` corpus is already embedded on every completion
   and is therefore already current.
2. Take the files those tasks actually touched. Prefer the merged **diff** (the
   `pr` corpus, whose chunks carry `metadata.taskId` and `metadata.path`) over
   the declared manifest: the diff is what happened, the manifest is what
   someone predicted.
3. The capped union of those paths is the predicted area.

Used for two things, and nothing else: the file filter for knowledge/memory
recall, and an advisory scope hint in the prompt for narrowing
`codebase-memory` queries.

**The crux: the prediction stays out of `tasks.path_manifest`.** That column
feeds path-overlap serialisation and inferred `dependsOn` in the claim route. A
wrong value there does not degrade a prompt — it defers or serialises unrelated
real work, and the failure presents as ordinary contention rather than as a bad
inference. Existing text-based path inference is kept out of that column for
exactly this reason (see the header of `task-path-inference.ts`). If that
boundary is wrong, the cost of this feature stops being "one slightly-off memory
in a prompt" and becomes correctness. The prediction therefore lives in its own
table and is read by retrieval alone.

Three alternatives were weighed and rejected:

- **A third semantic store.** A maintenance liability next to `codebase-memory`
  and the knowledge store, for a signal both already carry.
- **Clustering on declared file manifests.** They are often empty or wrong at
  creation time, so anything clustering on them clusters on noise.
- **Precomputing the areas.** Anything precomputed goes stale the moment the
  codebase moves.

### Everything is a runtime parameter

Nothing here is a compiled-in setting. `TaskAreaConfig` carries top-k, the
similarity floor, the union cap, the per-neighbour cap, the neighbour path
source (`diff` | `manifest`), the enrolment fraction, the policy version, and
whether the feature runs at all. Resolution is in-code fallback ← env ←
`system_cache.task_area_prediction_config`, so the DB row — the layer needing no
deploy — wins. Out-of-range values are **refused, not clamped**, and the refusal
is logged naming the field: a fat-fingered `15` meant as 15% must run the
control, not enrol the fleet.

**The shipped default is a no-op for behaviour:** `enabled: true`,
`fraction: 0`. Every task gets a prediction recorded, so the metric accrues from
the first deploy; no task's retrieval changes until an operator sets a fraction.

### Enrolment

Rides the generic randomiser extracted by the previous experiment
(`packages/core/experiment-randomizer.ts` — moved there from
`apps/runner/src/`, which now re-exports it, because this experiment draws its
arm server-side at claim time). This experiment supplies its own id, version and
arm pair; there is no second copy of the draw. Assignment is per task,
version-salted, with the propensity recorded at assignment.

Arms: `regex_paths` (control — today's behaviour exactly) and `neighbour_area`
(treatment). **Both arms compute both predictions**; only the treatment arm's
reaches retrieval. On the runner, the presence of the
`task.context.predictedTaskArea` hint *is* enrolment, so no arm logic exists
there and a control session is indistinguishable from one built before this
shipped.

### The rail

`task_area_prediction_events`, one row per (task, policy version), holding the
arm, propensity, fraction, the predicted paths, the neighbour ids and count, the
top score, **the regex baseline over the same task**, and — written once at
terminal worker status — the paths the diff actually touched.

Deliberately not a widening of `worker_prompt_composition_events`: that table is
memory-digest-specific down to its `arm` union, and
`docs/design/experiment-lifecycle.md` says prospectively that a new experiment
brings its own payload table.

### The one number

Overlap between predicted paths and the paths in the actual diff at completion,
computed **for both predictors over the same tasks in the same run**. Reported
as recall (headline: share of the actual diff the prediction covered), precision
(share of predicted paths that covered something real) and mean predicted-path
count — because recall alone is won by predicting the whole repo, and the two
predictors emit different numbers of paths.

Readable without SQL: `bun run readout:task-area` (`--json`, `--policy <v>`).

Arms are **never pooled**. In the treatment arm the prediction scoped the
agent's retrieval, so the ground truth is partly downstream of the prediction;
the control arm is where the predictor is measured against files it could not
have steered.

**"No better than the regex" is a completely acceptable outcome** and the
readout is built to state it plainly. There is no significance test and no
winner line — the exit is one function and one advisory table, so the decision
costs a conversation, not a stopping rule.

### Safety properties

- The claim path is best-effort throughout: a prediction that cannot be computed
  attaches nothing and the claim still succeeds.
- The union is bounded by `maxPaths` (12 by default) and by
  `maxPathsPerNeighbour` (8), so one 200-file refactor in the neighbourhood
  cannot become the whole prediction.
- `topK` bounds the neighbour query; the readout bounds its scan at
  `READOUT_ROW_LIMIT`.
- Ground truth is written with `WHERE actual_paths IS NULL`, so a second
  terminal PATCH cannot overwrite the first observation.
- Nothing in this feature writes to `tasks`.

## Open questions

- **Is `observed_touches` the right ground truth?** It is the union of what
  `git diff --name-only` saw across the session, captured at terminal status
  just before the column is cleared. It leans slightly generous (it includes
  files touched and reverted). The alternative — the merged PR's file list from
  the `pr` corpus — is cleaner but only exists for work that merged AND was
  ingested, which would silently restrict the cohort to successful tasks. Taking
  the broader, unbiased source; if the readout shows the difference matters, the
  narrower one can be recorded alongside it.
- **Should the similarity floor be per-workspace?** Score distributions differ
  with corpus size, so a floor tuned on a large workspace may admit noise in a
  small one. Leaning no for now: it is one more knob for a difference nobody has
  yet measured, and the floor is already runtime-configurable.
- **Should a failed neighbour count?** Currently yes — a failed task still
  touched real files in the right area, and excluding them biases the
  neighbourhood toward work that went smoothly. Reversible via the readout if
  it shows up as noise.

## Non-goals

- **Named areas** ("UI", "API") for dashboards. They fall out of the same data
  later and must be earned with the overlap metric first. No taxonomy here.
- Replacing the title-token fallback.
- Changing `buildKnowledgeContext`'s corpus fan-out.
- Any change to claim-route serialisation, path claims, or inferred `dependsOn`.
- An experiment registry. `docs/design/experiment-lifecycle.md` proposes one;
  this experiment is a consumer of the extracted randomiser, not the registry's
  implementation.
