# Mission Context Clusters — situational, observable, measurable retrieval

**Status:** Partially implemented — `tool-infra-error-v1` and the assembly
record are built and emitted as logs. The assembly table and every plan-time
recipe are not. PR #2138.
**Related:**
- `apps/web/src/lib/knowledge-context.ts` — the shared retrieval path; holds `buildClusteredKnowledgeContext`
- `packages/core/retrieval-clusters.ts` — vocabulary, recipe, scope check, selector, weakness predicate
- `apps/web/src/app/api/workers/claim/context-injection.ts` — exec-time caller
- `apps/web/src/lib/workspace-state-context.ts` — the cause-scoped precedent
- `packages/core/subject-anchor-extractor.ts` — `KNOWN_ERROR_SLUGS`
- `packages/core/friction-manifest.ts` — the path extractor the recipe reuses
- `docs/design/retrieval-policy-evaluation.md` — how the recipes get compared
- `docs/design/task-subject-anchors.md`, `docs/design/path-claims-coordination.md`

---

## Problem

One retrieval shape serves every question the system asks.

`buildKnowledgeContext` (`knowledge-context.ts:131`) takes a single prose string
and fans it to five namespaces — `memory`, `plan`, `task`, `pr`, `code` — at
`topK: 3` each (`:147-153`). The same function, same signature, serves the
organizer planning a mission (`mission-context.ts:849`, query = title +
description) and a worker claiming a task (`context-injection.ts:197`, query =
the task goal). Nothing varies: not the corpora, not the query text, not the
depth. An organizer woken by a path-claim conflict and a worker acting on an OOM
kill get identically-shaped context.

Three consequences, all in the code today:

**1. The written-down half of the system is counted, advertised, never
retrieved.** `buildCorporaHint` counts the docs namespace and emits
`knowledge: … docs N — query_knowledge before diagnosing`, while the `sources`
list that decides what is actually queried omits `docs`. In push mode only
`memory`, `plan`, `task`, `pr`, `code` are ever queried.

**2. Code is searched with prose.** A goal like "reduce p95 on the claim route"
goes verbatim to the `code` namespace. buildd already solved this once:
`spec_compare` (`mcp-tools.ts:4301`) queries `docs` semantically, extracts
implementation anchors, then issues a **second lexical** query against `code`
using those anchors. The extractor is private (`mcp-tools.ts:4617`), reachable
only from one admin MCP action. The shared path never got the fix.

**3. Typed cause is already plumbed and already discarded.**

| Layer | Key | Values | State |
|---|---|---|---|
| Plan | `OrganizerCause` (`workspace-state-context.ts:32`) | `task_completed`, `pr_merged`, `conflict_escalation`, `claim_409`, `mission_evaluate`, `first_decomposition`, `fallback` | consumed only by `buildWorkspaceStateContext` |
| Exec | `tasks.subjectKind` (`schema.ts:951`, indexed `:1006`) | `pull_request`, `error`, `mission`, `branch` | shipped; ignored by retrieval |

`attachSubjectPriorWork` uses the subject anchor for sibling lookup while
`attachKnowledgeContext`, beside it in the same file, ignored it.

And there was no record of any of it. Hit tracking exists
(`pg-vector-store.ts:413` → `schema.ts:1779-1780`) but it is a global per-chunk
counter with no assembly identity and no outcome, so it cannot answer *which
retrieval process preceded an observed outcome*.

## Current state

Plan time is unchanged by this design — that is the point of the no-op default.
The fan-out both layers call is the same function it was.

```
plan time                                      exec time
─────────                                      ─────────
buildMissionContext                            claim → context-injection.ts
  ├─ buildWorkspaceStateContext  ← cause-aware   ├─ attachExternalContextProviders
  ├─ buildKnowledgeContext       ← NOT aware     ├─ attachKnowledgeContext  ← recipe-aware,
  └─ buildEntityCatalogContext                   │    falls back to the fan-out
                                                 └─ attachSubjectPriorWork  ← anchor-aware
```

`knowledgePathsFromManifests` (`mission-context.ts:24`) already derives paths
from active tasks' `pathManifest` (`schema.ts:934`) and passes them as
`opts.paths`, triggering one extra `pr` lookup. That was the closest thing to a
recipe: one conditional hop, no budget, no record.

## Proposal

A **cluster** is a named retrieval recipe selected by trigger. Three parts:
ordered steps (corpus + key + derivation), a token budget, an uncertainty note.
Steps are **priorities, not exclusions** — a later step fires when earlier ones
come back weak, and a recipe that yields nothing falls through to the fan-out.

Every assembly emits a record: trigger, recipe, derived keys, per-item selection
reason and provenance, the escalation flags, and the identifiers needed to
reconstruct what followed.

### What this is actually for

Not "different missions need different context" — that is the surface motivation
and the weakest version of the claim. The load-bearing idea:

> **Retrieval becomes an observable decision made by code, with enough
> provenance to evaluate that decision later.**

Situational recipes are the occasion for building that, not the point. A
reviewer who keeps the recipes and drops the provenance has kept the part that
is easy to guess at. **If scope has to be cut, cut a recipe — never the record.**

### The crux

**Selection reason must be emitted by the retrieval code, never inferred
afterwards by a model.**

The code knows with certainty which step issued which query with which key and
what came back at what rank. A model asked to explain a finished assembly can
only produce a plausible story. If the reason field is model-generated the
telemetry becomes another artifact to audit rather than ground truth, and every
cohort comparison built on it is worthless.

Corollary: reasons are **provenance, not judgment**. `error_signature_query_hit`
means "a step issued a query keyed on the error signature and this returned at
rank N" — not that the item is relevant. An LLM may participate *before*
retrieval, turning intent into search keys, recorded separately in `derived_by`
so cohorts can split on it.

If the crux is wrong — if reasons can only be had from a model — the honest
outcome is to ship clusters without the measurement loop and stop calling it
measurable.

### Reason vocabulary

Small, closed, code-emitted; full rationale in `retrieval-clusters.ts`.
Item-level reasons name the key; step-level reasons name what the step did
instead.

```
item:  error_signature_query_hit  touched_file_query_hit  pr_path_query_hit
       graph_expansion_hit        fallback_semantic_search
step:  step_query_empty           step_skipped_no_keys
       step_skipped_priors_strong memory_skipped_sensitive
```

**Naming rule, binding on additions.** `<key>_query_hit` for a result;
`step_*` / `<subject>_skipped_<why>` for a step, because `step` and `corpus` are
already fields and restating the key would duplicate a column. A value ending in
`_match` is misnamed — "match" asserts the result was correct, which is exactly
the judgment the code is not entitled to make.

The four step-level values are **mutually exclusive and exhaustive: every step
of every assembly emits exactly one row.** A step with no row is
indistinguishable from a recipe that has no such step.

`derived_by` is separately closed: `subject_anchor`, `path_manifest`,
`regex_path_extract`, `pattern_component_table`, `prose_goal`.

Reserved and deliberately **not** union members, so no cohort can be written
over a value that cannot occur: `failing_test_query_hit` (needs CI check names),
`stack_symbol_query_hit` (needs a subject the scanner cannot produce),
`spec_symbol_query_hit` (needs the docs recipe), `memory_semantic_query_hit`
(needs a prose-keyed memory step), `regex_anchor_extract`,
`regex_stack_extract`, `llm_query_transform`. **Add the member in the same
commit that emits it.** A closed union of things that never happen is the same
defect as a green check over an empty set.

### `tool-infra-error-v1`

Scope: **the thirteen tool/infra slugs in `KNOWN_ERROR_SLUGS`, and nothing
else.** Compiler errors, test failures, and runtime stack traces have no scanner
pattern and therefore no subject; CI failures arrive through
`normalizeFailingCheckNames`, not a slug. The name carries the scope because a
recipe called `error-v1` reads as covering all failures, which is the opposite of
true.

**Enforced by `isToolInfraSignature`, which is deliberately stricter than
`normalizeErrorSignature`.** That validator accepts any `namespace:slug`, and
`toFrictionSignature` turns *any* error prose into `worker-failure:<stem>_<hash>`
— so accepting namespaced signatures would admit every family the scope claims
to exclude. Only bare catalog members select. A new scanner pattern widens the
recipe automatically, because the check reads the catalog rather than restating
it.

| # | Corpus | Mode | Key | Reason on hit |
|---|---|---|---|---|
| 1 | `memory` (team) | hybrid | error signature | `error_signature_query_hit` |
| 2 | `task` | hybrid | error signature | `error_signature_query_hit` |
| 3 | `pr` | hybrid | implicated paths | `pr_path_query_hit` |
| 4 | `code` | **lexical** | implicated paths | `touched_file_query_hit` |

Steps 1-3 are unconditional and run **concurrently** — no data dependency, and
awaiting them serially cost an embed-plus-rerank round trip each, per claimed
worker, on a route with no `maxDuration`. Step 4 fires only when all three come
back weak **and** concrete keys exist. Step 1 is skipped in sensitive workspaces
and logged as `memory_skipped_sensitive`.

Step 4 is **lexical** because its key is a list of literal repo-relative paths;
sending those through a dense embedder is the prose-against-code mismatch this
design exists to stop. It keys on paths, not symbols, because the scanner emits
`{ pattern, excerpt }` (`error-trace-scanner.ts:17`) — one raw line, no file, no
symbol, no exit code. There are no stack symbols to key on, which is why
`stack_symbol_query_hit` is reserved.

**Two extractors, not one.** `apps/web/src/lib/error-signature.ts` deliberately
destroys the fields a search key needs — first line only, `RE_PATH → <path>`,
`RE_NUMBER → <n>` — which is correct for its job (a stable dedupe key) and
useless for retrieval. The search-key extractor turned out to already exist:
`friction-manifest.ts`, which `POST /api/tasks` already calls to populate
`tasks.path_manifest`. The recipe reads the column first and re-extracts only
when it holds nothing but the `'**'` sentinel, so both paths agree by
construction. Its two halves are separate functions (`extractExcerptPaths`,
`componentTablePaths`) because a path the error named and a static guess about
which file owns a slug are not the same evidence.

Hazard worth a comment at any new call site: `normalizeErrorSignature` names
**two functions with incompatible contracts** — the prose normalizer in
`apps/web/src/lib/error-signature.ts` and the strict slug validator in
`packages/core/subject-anchor-extractor.ts`. `failure-friction-signature.ts`
bridges them and its header documents the trap.

### `conflict-v1` (not built)

Trigger: `OrganizerCause` of `conflict_escalation` or `claim_409`. The key is
already computed by `knowledgePathsFromManifests` over the conflicting tasks'
manifests.

| # | Corpus | Key | Reason on hit |
|---|---|---|---|
| 1 | `pr` | contested paths | `pr_path_query_hit` |
| 2 | `code` | symbols at those paths | `touched_file_query_hit` |
| 3 | `task` | contested paths | `touched_file_query_hit` |
| 4 | `memory` + `plan` | mission prose | `fallback_semantic_search` |

Step 4 is the demotion of today's default, not its removal — which is what makes
this an ordering rather than an exclusion list.

### The weakness predicate

**It cannot be a threshold on `QueryResult.score`, and the first version was.**
`PgVectorStore._finalize` runs `applyRecencyAuthority` *after* rerank, so the
score a caller sees is `relevance × CORPUS_AUTHORITY[corpus] ×
recencyDecay(age)`. The `task` corpus has authority 0.4; the recipe thresholded
every step at 0.5. Step 2 was therefore **provably weak for every possible
input**, the escalation flag a constant, and the day-one metric a measurement of
nothing. The tests could not see it: the fixture returned `score: 0.9`, which
that corpus cannot produce.

Strength is judged on `scoreBreakdown`, preferring `rerank` — the only corpus-
and age-independent figure — then `rrf`, `dense`, `lexical`. **Thresholds are
keyed on the signal, not the step:** an RRF value of 0.02 is strong and a rerank
value of 0.02 is not, so one constant across both is meaningless. With no
breakdown, strength is unjudgeable and the step counts results instead, recorded
as `countOnly`. `minStrongHits` stays on the step because counting is scale-free.

The original "thresholds are per step" note was aimed at the right problem —
numbers from different pipelines are not on one scale — but at the wrong axis.
The scale is set by which signal produced the number, not by which step asked.

A step that returned nothing is **weak, not neutral**: a silent corpus and a
corpus full of bad answers are equally good reasons to escalate. Same for a step
that could not run. Graph-expansion neighbours are **excluded** from the
judgement entirely, since the step's key did not return them.

Two escalations, recorded separately:

- `weakEscalationFired` — an `onlyWhenWeak` gate opened. Set **when the gate
  opens**, not when the query succeeds: an escalation that passed the gate and
  then had no key still escalated, and that is the likeliest failure mode.
- `fallbackFired` — the recipe produced nothing renderable and the fan-out
  served the request. Set by the executor, which is what knows.

One flag cannot express both. **These two rates are the load-bearing
measurement, scoreable on day one with no outcome labels at all** — a recipe
that falls back ninety percent of the time does not work, and you know that
before a criterion has moved. Which is exactly why the threshold bug mattered:
an always-weak predicate makes the rate a constant, and a constant looks like a
working recipe.

**Score incomparability, recorded but not solved.** Items store
`modeRequested`, the `signals` that came back, `rerankApplied`, and
`graphProximity`. No cohort may compare `score` across rows differing on any of
them — and `score` is not on the same scale as its own breakdown, being
post-decay where the components are pre-decay. Known bug class, not
hypothetical: `mcp-tools.ts:4310` records the same shape.

### Graph neighbours do not claim the key

`useGraph` defaults on, so `_graphExpand` appends chunks reached by a 1-hop
entity walk. Stamping those with the step's reason asserts a query returned an
item it never returned. They carry `graph_expansion_hit` and their
`graphProximity`, render into the prompt as real retrieved items, and count
toward no step's strength.

Expansion stays **on**. Turning it off was the easy fix and the wrong one: the
fan-out has it on, so disabling it for recipes would make the two cohorts differ
on two axes at once and confound the only comparison this phase is for.

### The measurement loop

```
trigger → recipe → query transformation → retrieved context → action → criterion outcome
```

**What this measures, precisely: which retrieval process preceded an observed
outcome.** Not which context caused a correct change. That distinction is the
constraint on every later use of this data; designing optimization around the
stronger reading would optimize against an attribution the log cannot support.

The gap is worst at plan time: a planning assembly may precede several actions
before any criterion moves, so a naive `assembly → next transition` join is
last-touch attribution. An exec assembly is much closer — one claim, one worker,
one task outcome — but still not proof.

So the record stores identifiers to **reconstruct the chain** rather than an
outcome field:

```
assembly_id
  → organizer pass id | claim id            (which decision consumed this context)
  → task id | worker id                     (what acted)
  → resulting task ids | pr number          (what was produced)
  → criterion key + transition + timestamp  (what moved, and when)
```

`AssemblyChain` holds the left-hand side: `taskId`, `workerId`, `missionId`. The
later links are joins against rows that already exist (`workers.prNumber`,
`missions.goalCriteriaState` `schema.ts:763`, plus `criteriaRearmFingerprint` /
`criteriaRearmCycles` — a rearm means the gate refused, a labeled negative that
is causally tighter than a success). They become *queryable* only once assembly
rows are, which is step 6. The chain fields are recorded now so that step is a
join rather than a backfill: an assembly whose task id was never recorded cannot
be reattached to its outcome afterwards at any price.

There is **no claim id**, because no claim-request identifier exists to record.
A declared field nothing sets is worse than an absent one. Consequence: the
several workers of one claim request cannot be grouped; `at` + `taskId` is the
closest substitute.

**Every claim emits exactly one record, fan-out included.** That is the
denominator:

```
grep '[context-assembly]' | jq -s 'group_by(.recipe)[] | {
  recipe: .[0].recipe,
  n: (map(.assemblyId) | unique | length),
  fallbackRate:       (map(select(.fallbackFired))       | length) / length,
  weakEscalationRate: (map(select(.weakEscalationFired)) | length) / length }'
```

Without the fan-out record that aggregation has no denominator — zero
`tool-infra-error-v1` lines would be indistinguishable from no eligible tasks and
from a regressed selector — and no control arm. `at` is on the record rather than
left to the platform's line timestamp, because the first step of any pipeline
that reads these strips the prefix and takes that timestamp with it.

Two existing facilities cover part of this and must not be confused with it:
**hit tracking** (`pg-vector-store.ts:413`, global per-chunk counters, untouched)
and **offline eval** (`packages/core/scripts/eval-retrieval.ts` over
`packages/core/scripts/eval/golden-queries.json`, thresholds in
`packages/core/eval/regression.ts`, baseline in
`packages/core/eval/retrieval-baseline.json`). Reuse the latter for cohort
scoring rather than inventing metrics — see
`docs/design/retrieval-policy-evaluation.md`.

**This phase instruments only.** No policy is learned from
`goalCriteriaState`; cohorts are compared by hand.

### The record

Two lines per assembly, joined on `assemblyId`: a bounded `[context-assembly]`
summary and a `[context-assembly-items]` detail line.

Two lines rather than one reordered line because **a line truncated mid-array is
invalid JSON** — `JSON.parse` rejects the whole line, so leading aggregate fields
go with it. Field order only helps a prefix-tolerant parser, and no standard log
consumer is one. The risk is real (~5-6 KB worst case against a ~4 KB ceiling)
and non-random: the longest records are the escalated many-hit assemblies, the
exact population the metric is about. So the remedy is a size guarantee — every
metric field on a line short enough that truncation cannot reach it, with the
length-unbounded `derivedKeys` on the detail half and a test on worst-case size.

References and provenance, **never retrieved content** — join back to
`knowledge_chunks`. Per item: `namespace`, `corpus`, `chunkId`, `sourcePath`,
step, reason, `derivedBy`, `modeRequested`, `signals`, `strength` +
`strengthSignal`, `rerankApplied`, `graphProximity`, rank, `score`,
`scoreBreakdown`. Per assembly: `assemblyId`, `at`, recipe, `source`,
`workspaceId`, `teamId`, trigger, `derivedKeys`, both flags, the chain.

Three qualifications:

**`namespace`, not just `corpus`.** `knowledge_chunks` is unique on
`(namespace, source_id)` and source ids are composite `path#line` values, so the
same id exists in every workspace's `:code` namespace. `chunkId` + `corpus` alone
is an **ambiguous** join across tenants, not merely one liable to dangle.
`workspaceId`/`teamId` are on the assembly for the same reason, and because a
cohort with no tenancy cannot be segmented or have a noisy tenant excluded.

**The join can still dangle.** Chunks are pruned and superseded (`pruneOrphans`,
`supersedes`/`supersededBy`, `contentDedup`). Hence `sourcePath` alongside the
id: enough to say what an evicted item *was* without storing what it *said*.
Limit of that mitigation — `memory` chunks are upserted with no `sourcePath`, so
it is null on exactly the recipe's first step.

**Derived keys are production data.** The signature and repo-relative paths are
recorded; the raw excerpt is **not** — it is read to extract paths and dropped.
Guard that if a future step keys on excerpt text. One gap:
`friction-manifest.ts` passes through a path matching neither `/apps/` nor
`/packages/`, so an absolute host path can reach the log.

### Example record

From an actual run against a fixture store. Synthetic values, real shape — the
earlier hand-written example could not have been produced by the code, which is
how it made the broken 0.5 threshold look attainable.

```json
[context-assembly]
{ "assemblyId": "<uuid>", "at": "2026-09-05T12:00:00.000Z",
  "recipe": "tool-infra-error-v1", "source": "live",
  "workspaceId": "<ws>", "teamId": "<team>",
  "trigger": { "layer": "exec", "subjectKind": "error", "signature": "oom_killed" },
  "weakEscalationFired": false, "fallbackFired": false,
  "chain": { "taskId": "<task>", "workerId": "<worker>", "missionId": null },
  "itemCount": 4, "pathCount": 1 }

[context-assembly-items]
{ "assemblyId": "<uuid>",
  "derivedKeys": { "paths": ["apps/runner/src/workers.ts"] },
  "items": [
    { "step": 1, "corpus": "memory", "namespace": "<team>:memory",
      "chunkId": "docs/runbook.md#12", "sourcePath": "docs/runbook.md",
      "reason": "error_signature_query_hit", "derivedBy": "subject_anchor",
      "modeRequested": "hybrid", "signals": ["rerank","rrf","dense","lexical"],
      "strength": 0.87, "strengthSignal": "rerank", "rerankApplied": true,
      "graphProximity": 1, "rank": 1, "score": 0.435,
      "scoreBreakdown": { "dense": 0.81, "lexical": 0.44, "rrf": 0.031, "rerank": 0.87 } },
    { "step": 2, "corpus": "task", "namespace": "<ws>:task",
      "reason": "step_query_empty", "derivedBy": "subject_anchor", "modeRequested": "hybrid" },
    { "step": 3, "corpus": "pr", "namespace": "<ws>:pr",
      "chunkId": "apps/runner/src/workers.ts#88", "sourcePath": "apps/runner/src/workers.ts",
      "reason": "graph_expansion_hit", "derivedBy": "path_manifest",
      "modeRequested": "hybrid", "signals": ["rrf","dense"],
      "strength": null, "rerankApplied": false, "graphProximity": 0.6,
      "rank": 1, "score": 0.12, "scoreBreakdown": { "dense": 0.3, "rrf": 0.016 } },
    { "step": 4, "corpus": "code",
      "reason": "step_skipped_priors_strong", "derivedBy": "path_manifest" }
  ] }
```

Four things in that output each correspond to a defect this design previously had:

- **`score: 0.435` on a strong item** is `0.87 × 0.5` — relevance times memory
  authority. The item is strong on the only comparable signal (`rerank` 0.87)
  while its `score` sits below the same number. A `score` threshold called this
  weak.
- **Step 3 is a `graph_expansion_hit` with `strength: null`** — proximity 0.6, so
  an entity edge reached it, not the path key. It renders, but claims nothing and
  counts for nothing.
- **Step 2 ran and got nothing; step 4 never ran.** Different rows, different
  reasons. `step_skipped_priors_strong` is the gate holding, as a row rather than
  an absence.
- **Four steps, four rows,** whatever happened.

### Where CBM fits

CBM stays worker-side. Server-side references are `skill-and-role-injection.ts`,
the metrics route, and `packages/core/cbm-health.ts`; nothing in `apps/web`
queries the graph, and `BY_DESIGN_SKIP_REASONS` (`cbm-insight.ts:27`) records
why — `codex_task`, `no_worktree`, `role_opt_out`. The graph exists only where a
worktree exists, so plan time cannot reach it. If the organizer ever needs
structural facts it gets a **small derived summary** — blast radius, inbound
callers, test presence, on the order of five lines — never graph output. Out of
scope here.

## Safety

- **Defaults are a no-op.** Any trigger with no registered recipe behaves exactly
  as before, so merging changed nothing until a recipe was registered.
- **Retrieval never blocks.** The executor catches everything and returns no
  parts; the caller then runs the fan-out. The claim route calls
  `attachKnowledgeContext` with no try/catch, after worker rows are committed, so
  a throw would be a 500 with tasks stranded in `assigned`. `crypto.randomUUID()`
  is inside the try for the same reason, and `path_manifest` is checked for array
  shape because it is jsonb with only a compile-time assertion.
- **Bounded assembly.** `budgetChars` per recipe, dropping whole hit groups and
  accounting for its own headers; `topK` and the step list are per-recipe
  constants. No recipe grows the prompt without a committed constant changing.
- **Sensitivity is a recipe change, not a filter.** `tool-infra-error-v1` loses
  its own step 1 in a sensitive workspace, and that is logged, or cohorts
  silently mix two populations.
- **Eval must not pollute live cohorts.** `source: 'live' | 'eval'` on the
  record, defaulting to `live`; offline callers set it. Same discipline as the
  `trackHits: false` that `eval-retrieval.ts` already passes.
- **The record is production data.** Signature and repo-relative paths, no
  retrieved content, no raw excerpt. Stdout only — no new store, no retention
  decision, nothing added to a response body or a prompt. Every example here is
  synthetic; fixtures must not carry captured values.

## Implementation sketch

**Done** (PR #2138): scope decision, the recipe behind cluster selection with
the shared weakness predicate, per-recipe budget and uncertainty note, and the
assembly record emitted as logs with a fan-out denominator. Default remains the
untouched fan-out.

Dropped: the original step 1, "query `spec` in `buildKnowledgeContext`". Wrong
corpus — `docs` holds `SPEC.md`, and PR #2130 landed the same correction for
`spec_compare`. One footnote on that PR's reasoning, since it matters to anyone
extending this: its "zero writers" claim is not right.
`knowledge-ingest.ts:182` double-writes every docs file into `spec` as well,
reachable whenever a runner host has `DATABASE_URL` + `VOYAGE_API_KEY` (`:232`).
So `spec` is either empty or a duplicate of `docs`, never a distinct corpus. The
dead double-write costs embedding calls and is worth removing separately.

**Next, in order.**

6. **Assembly table.** Indexed `assembly_id`, the `source` discriminator, the
   criterion-transition join. A writer against a settled record shape, not a
   design question. Needs a retention answer.
7. **Evaluate before adding a second recipe.** Fallback and weak-escalation rate
   per recipe against the fan-out cohort — both answerable from the logs today.
   Read the escalation rate **before** touching `MIN_STRONG_BY_SIGNAL`; the
   thresholds are guesses, and what makes them checkable now is that a rate
   pinned at 0% or 100% is visible where the old `score` threshold hid it.
   Offline replay over historical tasks is the cheaper half of this and has its
   own design: `docs/design/retrieval-policy-evaluation.md`.
8. **Then plan-time.** `conflict-v1`, querying `docs` in the shared path, and
   lifting `extractImplementationAnchors` out of `mcp-tools.ts:4617` into a
   shared module for symbol-keyed `code` queries (regex, no model). None is
   needed to evaluate the exec-time recipe.

Separable and unblocked: extend `error-trace-scanner.ts` + `KNOWN_ERROR_SLUGS`
with test, compiler, and stack-trace patterns. The recipe widens with the
catalog automatically — but the scanner would also have to emit more than one
raw line for a symbol key to exist.

## Open questions

- **Weakness thresholds.** `MIN_STRONG_BY_SIGNAL` ships `rerank: 0.5`,
  `rrf: 1/61`, `dense: 0.5`, `lexical: 0.05`. Guesses — but now guesses on a
  comparable scale rather than against a ceiling below the threshold. Ship, read
  the escalation rate, then set the value, cross-checked against the golden set.
- **Whether `worker-failure:*` should ever select a recipe.** Excluding it is
  right for a cohort-comparison phase and cuts the eligible population hard,
  since it is the common anchor for agent-filed friction. The way back in is
  widening the scanner catalog so those failures acquire a real slug, not
  widening the allowlist.
- **Where the assembly log lives.** A log line today. When it lands: a new table,
  not an existing jsonb column — the outcome join needs an indexed `assembly_id`
  and `tasks.context` makes every cohort query a jsonb scan.
- **Retention.** Rows accumulate per organizer pass and per claim. References
  rather than content keeps them small, so I lean generous with per-item detail
  pruned and aggregates kept — but the window is a cost question I do not have
  numbers for. Note that pruning assembly detail and pruning chunks are
  independent clocks and analysis needs both.
- **Non-repo-relative paths in derived keys.** Dropping them looks strictly
  better — useless as search keys, and they put host layout in the log — but it
  changes `path_manifest` inference for every friction task, so it wants its own
  change.
- ~~Cluster registry shape~~ — settled: a `selectExecCluster` switch. One recipe
  does not justify a registry; revisit at four.
- ~~Do both layers share one recipe namespace?~~ — settled by construction:
  shared vocabulary and types, layer-specific selector.

## Non-goals

- **No learned retrieval policy in this phase.** Instrument, then compare
  cohorts by hand. The progression past that is
  `docs/design/retrieval-policy-evaluation.md`, and it does not start with RL.
- **No `missions.kind` column.** Mission type is the wrong selector; the question
  being answered on this pass is the right one, and `OrganizerCause` +
  `subjectKind` already express it.
- **No plan-time graph access.** CBM stays worker-side.
- **No LLM-generated selection reasons**, ever — that is the crux, not a phasing
  decision.
- **No changes to hit tracking**, `spec_compare`'s behaviour, or the identity /
  friction-dedupe signature path.
- **No new corpora.** `docs`, `artifact`, `initiative`, `session` stay pull-mode
  only until a recipe needs one.
- **Not a prompt-size reduction project.** The claim is situational relevance and
  measurability, not fewer tokens.
