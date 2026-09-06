# Mission Context Clusters — situational, observable, measurable retrieval

**Status:** Partially implemented — `tool-infra-error-v1` and the assembly
record are built and emitted as logs; the assembly table and every plan-time
recipe are not. See "Decisions taken" for what changed between the proposal and
the code, and "Implementation sketch" for what is left.
**Related:**
- `apps/web/src/lib/knowledge-context.ts` — the shared retrieval path this changes
- `apps/web/src/lib/mission-context.ts` — plan-time caller
- `apps/web/src/app/api/workers/claim/context-injection.ts` — exec-time caller
- `apps/web/src/lib/workspace-state-context.ts` — the cause-scoped precedent to copy
- `packages/core/mcp-tools.ts` → `case 'spec_compare'` — the multi-hop precedent to lift
- `packages/core/subject-anchor-extractor.ts` — `KNOWN_ERROR_SLUGS`, the error identity catalog
- `docs/design/task-subject-anchors.md` — where `subjectKind` comes from
- `docs/design/path-claims-coordination.md` — where conflict causes come from
- `packages/core/scripts/eval-retrieval.ts`, `packages/core/eval/regression.ts` — offline scoring to reuse

---

## Decisions taken (2026-09-05)

Recorded here because the sections below are written as an argument, and an
argument reads as an open question long after it has been settled.

**1. `tool-infra-error-v1` ships against tool/infra errors only.** Step 0 is
resolved in favour of the narrow scope. `error-trace-scanner.ts` and
`KNOWN_ERROR_SLUGS` are NOT extended first; widening the catalog is a separable
PR that can land whenever, and the recipe widens with it automatically because
the scope check reads the catalog rather than restating it.

**2. The scope is enforced in code, and much more narrowly than
`normalizeErrorSignature`.** That validator accepts any `namespace:slug`, and
review caught that this is not a hypothetical loophole: the repo's one
namespaced producer, `toFrictionSignature`, renders **any** error prose into
`worker-failure:<stem>_<hash>`. A stale-worker timeout and a type error both
pass it. An earlier version of this design allowed that namespace and claimed
the scope was enforced — which would have been false in the most damaging
possible way, mixing tool/infra failures with whatever a worker last died on
while the docs asserted it could not.

`isToolInfraSignature` therefore accepts **only a bare `KNOWN_ERROR_SLUGS`
member**. That costs coverage: `worker-failure:*` is the common anchor for
agent-filed friction, so most error-subject tasks now take the default fan-out.
It is the right trade for a phase whose entire output is a cohort comparison —
a small clean population beats a large mixed one — and coverage is recoverable
by widening the scanner catalog, which widens the check automatically because it
reads the catalog rather than restating it.

**3. `stack_symbol_query_hit` and `regex_stack_extract` are not implemented,
because within this scope they cannot occur.** The scanner emits `{ pattern,
excerpt }` and nothing else — no file, no line, no symbol, no exit code — and
runtime stack traces have no scanner pattern, so they never select the recipe in
the first place. Step 4 therefore keys the `code` query on **paths**, and the two
symbol values are reserved rather than shipped. This is the first real
consequence of decision 1: the narrow scope makes part of the vocabulary
unreachable, and shipping unreachable reason values would have created cohorts
over an empty set.

**4. Step 1 of the implementation sketch was wrong, and is dropped.** It said to
add the `spec` corpus to the shared fan-out. `spec` is not the corpus that holds
`docs/SPEC.md` — `docs` is. PR #2130 landed the same correction for
`spec_compare` and the corpora hint on the day this was written. One qualification
on that PR's reasoning, since it matters to anyone extending the recipe: its
claim of "zero writers" is not quite right. `knowledge-ingest.ts:182` double-writes
every docs file into the `spec` namespace as well, reachable whenever a runner
host has `DATABASE_URL` + `VOYAGE_API_KEY` (`:232`). So `spec` is either empty or
a duplicate of `docs`, depending on the runner's environment — never a distinct
corpus, and never the right thing to query. The dead double-write is worth
removing separately; it is paid for in embedding calls.

**5. One `fallbackFired` boolean was two signals.** "An `onlyWhenWeak` step had
to fire" and "the recipe produced nothing and the prose fan-out served the
request" are different failures, and a single flag would have blunted the one
metric that needs no outcome labels. The record carries `weakEscalationFired`
and `fallbackFired` separately.

**6. Path provenance is per assembly, not per step.** A step declares the source
it expects; the record stores where the key actually came from — `path_manifest`
when read off the column, `regex_path_extract` when pulled out of the error
excerpt because the column held nothing but the `'**'` scope sentinel. Recording
the step's expectation would have put a claim in the log that the code never
made.

**7. The assembly record ships before the assembly table.** One structured line
per assembly under `[context-assembly]`, greppable in production — the shape the
worker-lease rollout used before its own table landed. Fallback rate per recipe,
the day-one signal, is answerable from the logs. The table is the next step, and
because the record is already complete that step is a writer rather than a
redesign.

**8. The weakness predicate cannot threshold `QueryResult.score`, and the first
version did.** This was the most serious defect review found, and it was
arithmetic, not judgement. `PgVectorStore._finalize` runs
`applyRecencyAuthority` **after** rerank, so the `score` a caller sees is
`relevance × CORPUS_AUTHORITY[corpus] × recencyDecay(age)`. The `task` corpus has
authority 0.4, so a perfectly relevant brand-new task chunk scores at most 0.4 —
and the recipe thresholded every step at 0.5. Step 2 was therefore
**provably weak for every possible input**, steps 1 and 3 (authority 0.5) weak
for all but an unreachable perfect score, the escalation flag a constant, and
the day-one metric a measurement of nothing. Without a reranker it is worse:
`score` is raw RRF, ceiling ≈ 0.033.

The unit tests could not see it, because the fixture store returned
`score: 0.9` — a value the real pipeline cannot produce for any of these
corpora. A fixture that can express impossible states will hide exactly this.

The fix judges strength on `scoreBreakdown` instead, preferring `rerank` (the
only corpus- and age-independent figure available), then `rrf`, then `dense`,
then `lexical`, and records which one was used. Thresholds are keyed on the
**signal**, not the step: an RRF value of 0.02 is strong and a rerank value of
0.02 is not, so one constant across both is meaningless. When no breakdown is
present, strength is unjudgeable and the step falls back to counting results,
recorded as `countOnly` rather than blended in.

The earlier "thresholds are per step" note was aimed at the right problem —
numbers from different pipelines are not on one scale — but at the wrong axis.
The scale is set by which signal produced the number, not by which step asked
for it.

**9. Graph neighbours do not get to claim the step's key.** `useGraph` defaults
to true, so `_graphExpand` appends chunks reached by a 1-hop entity walk from a
seed. Stamping those with `error_signature_query_hit` asserts "a query keyed on
the signature returned this at rank N" about an item the query never returned —
a direct breach of the crux, from inside the code meant to uphold it. They now
carry `graph_expansion_hit` and their `graphProximity`, and they are excluded
from the strength evaluation, since letting a neighbour satisfy a step would
credit the key for what an entity edge produced.

Expansion stays **on**. Turning it off would have been the easy fix and the
wrong one: the fan-out has it on, so disabling it for recipes would make the two
cohorts differ on two axes at once and confound the only comparison this phase
is for.

**10. The fan-out emits a record too — that is the denominator.** Recording only
recipe assemblies leaves "no `tool-infra-error-v1` lines today" indistinguishable
from "no eligible tasks" and from "the selector regressed". A metric with no
denominator is the same green-over-an-empty-set shape this design keeps citing,
so shipping one here would have been self-refuting. Every claim now emits exactly
one record; the fan-out's carries no chunk references because the fan-out
produces no per-item provenance, and that asymmetry is precisely what recipes
change.

**11. The record is two log lines, not one reordered line.** An earlier revision
put the aggregate fields first on the theory that truncation would then cost only
per-item detail. That does not work: a line truncated mid-array is invalid JSON,
so `JSON.parse` rejects the whole line and the leading fields go with it. Field
order only helps a prefix-tolerant parser, and no standard log consumer is one.

The risk itself is real — worst case is roughly 5-6 KB against a ~4 KB ceiling,
and the longest records are the escalated many-hit assemblies, so the loss would
be non-random and biased against exactly the population the metric is about. The
remedy is a size guarantee, not an ordering hope: a bounded summary line carrying
every metric field, and a separate detail line joined on `assemblyId`. Length-
unbounded fields (`derivedKeys.paths`) ride the detail line, and a test asserts
the worst-case summary stays under the ceiling. That test failed on the first
attempt, which is the only reason the guarantee is real.

**12. Several smaller records were lying, and are not now.** Each was found by
review, and each was a claim the code did not support:

- `weakEscalationFired` was set after the escalated step resolved its key, so an
  escalation that passed the gate and then had nothing to query recorded
  `false` — undercounting the recipe's single most likely failure mode. It is
  now set when the gate opens.
- `fallbackFired` was set by the caller, while the executor is what knows the
  body came back empty. A second caller that forgot would have logged
  `fallbackFired: false` with zero items.
- An `onlyWhenWeak` step whose gate held emitted **no row at all**, making "the
  gate held" indistinguishable from "this recipe has no step 4". Now
  `step_skipped_priors_strong`. Every step of every assembly emits exactly one
  row.
- Items recorded `corpus` but not `namespace`. `knowledge_chunks` is unique on
  `(namespace, source_id)` and source ids are composite `path#line` values, so
  the same id exists in every workspace's `:code` namespace: the join the
  no-content decision rests on was **ambiguous across tenants**, not merely
  liable to dangle. The record now carries `namespace`, plus `workspaceId` /
  `teamId` and an `at` timestamp, without which the lines cannot be bucketed,
  ordered, or segmented.
- `mode` recorded what the step **requested**, and the store silently downgrades
  `hybrid` to lexical-only with no embedder configured. It is now
  `modeRequested`, alongside a `signals` list of which score components actually
  came back — the mechanical record of what pipeline served the query.
- `reranked` was read as "a reranker exists", but `_finalize` reranks only when
  more than one result came back, so a single-hit step legitimately has none. It
  is now `rerankApplied`, named for the observation.
- `regex_path_extract` was stamped on paths that came from
  `inferFrictionManifest`'s **static per-slug component table**, which is a guess
  about which file owns a slug, not a path the error named. Those two are now
  distinguished (`pattern_component_table`), because otherwise the most obvious
  cohort question — does a named path retrieve better than a guessed one — is
  unanswerable from the log. The extractor's two halves were split apart in
  `friction-manifest.ts` to make the distinction honest rather than inferred.
- Whitespace-only paths passed the sentinel filter into real queries, and
  `derivedKeys` recorded the pre-filter values, so the log named keys no query
  ever used. Keys are trimmed, deduped, capped, and recorded **as queried**.
- A budget too tight for a single hit produced a block containing only a
  truncation notice, which suppressed the fan-out in exchange for nothing; the
  emptiness check ran before the budget rather than after. Truncation also cut
  between a hit and its `⚠ MAY ALREADY BE SHIPPED` warning — showing the hit
  while dropping the reason not to trust it. The budget now drops whole hit
  groups and accounts for the headers it emits.
- Error tasks lost the `query_knowledge before diagnosing` corpora hint, which
  every claim previously received, because the hint rode on the fan-out. The
  recipe emits it too.

## Problem

One retrieval shape serves every question the system asks.

`buildKnowledgeContext` (`knowledge-context.ts:131`) takes a single prose string
and fans it to five namespaces — `memory`, `plan`, `task`, `pr`, `code` — at
`topK: 3` each (`:147-153`). The same function, with the same signature, serves:

- the organizer planning a mission (`mission-context.ts:849`), where the query is
  `[mission.title, mission.description].join('\n')`
- a worker claiming a task (`context-injection.ts:197`), where the query is the
  task goal

Nothing varies. Not the corpora, not the query text, not the depth. An organizer
woken by a path-claim conflict and a worker acting on an OOM kill receive
identically-shaped context.

Three consequences, all observable in the code today:

**1. The written-down half of the system is counted, advertised, and never
retrieved.** `buildCorporaHint` counts the docs namespace and emits
`knowledge: … docs N — query_knowledge before diagnosing`, while the `sources`
list that decides what is actually queried omits `docs` entirely. The organizer
is told the docs corpus exists and handed everything except it. In push mode the
only namespaces ever queried are `memory`, `plan`, `task`, `pr`, `code`; `docs`,
`artifact`, `initiative`, and `session` are reachable only through pull-mode
`query_knowledge`.

Originally written as a claim about the `spec` corpus, which was wrong in an
instructive way — see decision 4. The gap is real; the corpus name was not.

**2. Code is searched with prose.** A mission goal such as "reduce p95 on the
claim route" is sent verbatim to the `code` namespace. buildd already found and
solved this: `spec_compare` (`mcp-tools.ts:4301`) queries `docs` semantically,
extracts implementation anchors — file paths, camelCase symbols, PascalCase
types, route paths — then issues a **second lexical** query against `code` using
those anchors, and fuses. The extractor is a private function at
`mcp-tools.ts:4617`, reachable only from one admin/dev MCP action. The shared
path never got the fix.

**3. Typed cause is already plumbed and already discarded.** Two keys exist in
the schema and neither changes retrieval:

| Layer | Key | Values | State |
|---|---|---|---|
| Plan | `OrganizerCause` (`workspace-state-context.ts:32`) | `task_completed`, `pr_merged`, `conflict_escalation`, `claim_409`, `mission_evaluate`, `first_decomposition`, `fallback` | plumbed via `templateContext.cause` |
| Exec | `tasks.subjectKind` (`schema.ts:951`, indexed `:1006`) | `pull_request`, `error`, `mission`, `branch` | shipped |

`buildWorkspaceStateContext` consumes `OrganizerCause` correctly — per-cause
sections, seven named `BUDGET_*` char caps (`:118-124`). It is the only
cause-aware block in the system. `attachSubjectPriorWork` uses the subject anchor
for sibling-task lookup, while `attachKnowledgeContext` sitting beside it in the
same file ignores it.

The only mission-shape signal in plan-time context is `isBuildMission()`
(`mission-context.ts:52`), a heuristic over skills and role patterns that gates
exactly one block: PR awareness.

And there is no record of any of it. Retrieval-hit tracking exists
(`pg-vector-store.ts:413` increments `hit_count` / `last_hit_at`,
`schema.ts:1779-1780`) but it is a global per-chunk counter with no assembly
identity and no outcome, so it cannot answer *which retrieval process preceded
an observed outcome* — a question the system currently has no way to ask.

## Current state

Before this design (the shape that motivated it):

```
plan time                                      exec time
─────────                                      ─────────
buildMissionContext (~685 lines, ~25 blocks)   claim → context-injection.ts
  ├─ buildWorkspaceStateContext  ← cause-aware   ├─ attachExternalContextProviders
  ├─ buildKnowledgeContext       ← NOT aware     ├─ attachKnowledgeContext  ← NOT aware
  └─ buildEntityCatalogContext                   └─ attachSubjectPriorWork  ← anchor-aware
```

After the exec-time half landed. Plan time is unchanged, which is the point of
the no-op default — the shared fan-out it calls is byte-for-byte the same
function:

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
`opts.paths`, which triggers one extra `pr` lookup. That is the closest thing to
a recipe in the shared path: one conditional hop, no budget, no record.

## Proposal

A **cluster** is a named retrieval recipe selected by trigger. Three parts, none
of which is "more context":

1. **Ordered steps** — which corpus, with which key, derived how. Steps are
   priorities, not exclusions: a later step fires when earlier ones come back
   weak, and the fallback is logged as an event.
2. **Token budget** — a per-section cap, in the shape of `BUDGET_*` in
   `workspace-state-context.ts`. A cluster that cannot crowd out its neighbours
   is composable; one that can is not.
3. **Uncertainty note** — a short trailer telling the consumer how this could be
   wrong. `spec_compare`'s "scores SURFACE candidates; they do NOT decide" and
   `renderHit`'s `⚠ MAY ALREADY BE SHIPPED` are the existing primitives.

Every assembly emits a record: trigger, recipe, derived keys, per-item selection
reason, whether fallback fired, and the identifiers needed to reconstruct what
followed.

### What this design is actually for

Not "different missions need different context." That is the surface motivation
and the weakest version of the claim. The load-bearing idea:

> **Retrieval becomes an observable decision made by code, with enough
> provenance to evaluate that decision later.**

Situational recipes are the occasion for building that; they are not the point.
A reviewer who accepts the recipes and drops the provenance has kept the part
that is easy to guess at and discarded the part that compounds. If scope has to
be cut, cut a recipe — never the record.

### The crux

**Selection reason must be emitted by the retrieval code, never inferred
afterwards by a model.**

The code knows, with certainty, which step issued which query with which key and
what came back at what rank. A model asked to explain a finished assembly can
only produce a plausible story about it. If the reason field is model-generated,
the telemetry becomes another artifact to audit rather than the ground truth the
whole measurement loop rests on — and every cohort comparison built on it is
worthless.

Corollary: reasons are **provenance, not judgment**. `stack_symbol_query_hit` means
"a step issued a lexical query keyed on a stack symbol and this returned at rank
N." It does not assert the item is relevant. Naming reasons after relevance
smuggles the same unverifiable claim back in through the vocabulary.

An LLM may participate *before* retrieval, transforming intent into search keys,
but only when deterministic extraction returns nothing — and it is recorded in a
separate `derived_by` field so cohorts can be split on it.

If the crux is wrong — if reasons can only be had from a model — the honest
outcome is to ship clusters without the measurement loop and stop calling it
measurable.

### Reason vocabulary

Small, closed, code-emitted. Each value names a retrieval step, not a judgment.

**Naming rule, binding on additions.** Item-level reasons name the key:
`<key>_query_hit` for a result. Step-level reasons are `step_*` /
`<subject>_skipped_<why>`, because they are facts about the step rather than
about any item — `step` and `corpus` are already fields, so restating the key
would duplicate a column.

A value ending in `_match` is misnamed — "match" reads as a claim that the
result was correct, which is exactly the relevance judgment the code is not
entitled to make. The mechanical truth is only ever "a query keyed on X returned
this at rank N."

Emitted today, and therefore members of the union in
`packages/core/retrieval-clusters.ts`. Item-level first — a query keyed on X
returned this:

```
error_signature_query_hit   touched_file_query_hit   pr_path_query_hit
graph_expansion_hit         fallback_semantic_search
```

Then step-level — what a step did instead of returning a hit. These four are
mutually exclusive and exhaustive: **every step of every assembly emits exactly
one row.** A step with no row would be indistinguishable from a recipe that has
no such step, which is how the escalation gate first managed to hold silently.

```
step_query_empty            step_skipped_no_keys
step_skipped_priors_strong  memory_skipped_sensitive
```

`step_query_empty` and `step_skipped_no_keys` are deliberately distinct: a query
that came back empty and a query that was never issued are different facts about
the recipe, and collapsing them makes the fallback rate unreadable. Neither is a
`_query_hit` at rank 0 — a "hit" that did not happen would break the naming rule
from the inside, which is how the first draft of the record had it.

`graph_expansion_hit` exists because the store appends 1-hop entity-walk
neighbours to every query. They are real retrieved items, but the step's key did
not return them, so they must not wear the step's reason.

Named and reserved, but deliberately **not** members of the union, so no cohort
query can be written over a value that cannot occur:

```
failing_test_query_hit      needs CI check names (normalizeFailingCheckNames)
stack_symbol_query_hit      needs a subject the scanner cannot produce — decision 3
spec_symbol_query_hit       needs the docs-corpus recipe
memory_semantic_query_hit   needs a recipe keying memory on prose, not a signature
```

Add the member in the same commit that emits it, not before. A closed union of
things that never happen is the same defect as a green check over an empty set,
which this repo has been bitten by repeatedly — and review caught one anyway:
`fallback_semantic_search` sat in the union with no emitter until the fan-out
record (decision 10) gave it one.

One note for whoever adds the next path-keyed step, not a decision to resolve
first: `touched_file_query_hit` and `pr_path_query_hit` differ only by corpus,
which is already its own field on the item. They can collapse to a single
`path_query_hit` if that reads better in the data — a reason value should not
restate a column.

`derived_by` is separate and equally closed. Emitted today:

```
subject_anchor   path_manifest   regex_path_extract
pattern_component_table   prose_goal
```

`regex_path_extract` and `pattern_component_table` are separate on purpose —
see decision 12. One is a path the error named; the other is a static guess
about which file owns a slug.

Reserved: `regex_anchor_extract` (symbol extraction, lands with the conflict
recipe), `regex_stack_extract`, `llm_query_transform`.

### `tool-infra-error-v1`

Scope: **the thirteen tool/infra slugs in `KNOWN_ERROR_SLUGS`, and nothing
else.** All thirteen are produced by `apps/runner/src/error-trace-scanner.ts`
and every one is a tool/infra failure: `cd_no_such_file`, `no_such_file`,
`permission_denied`, `command_not_found`, `enoent`, `oom_killed`, `git_fatal`,
`git_error`, `rate_limit`, `connection_refused`, `timeout`,
`bwrap_namespace_denied`, `sandbox_mount_gap`.

Compiler errors, test failures, and runtime stack traces have **no pattern and
therefore no subject**. They are out of scope, permanently as far as this recipe
is concerned — not pending. CI failures arrive through a different field,
`normalizeFailingCheckNames`, not a slug.

The name carries the scope deliberately: a recipe called `error-v1` would be
read as covering all failures, which is the opposite of true.

**And the scope is enforced by `isToolInfraSignature`, which is deliberately
stricter than `normalizeErrorSignature`** — see decision 2 for why that gap
matters. The validator accepts any `namespace:slug`, and
`toFrictionSignature` turns *any* error prose into `worker-failure:<stem>_<hash>`,
so accepting namespaced signatures would have admitted every failure family the
scope claims to exclude. Only bare catalog members select the recipe. A new
scanner pattern widens it automatically, because the check reads the catalog
rather than restating it.

The scanner emits `{ pattern, excerpt }` (`error-trace-scanner.ts:17`): one raw
line, truncated to 500 chars, first match per pattern, throttled per
`(workerId, pattern)`. No file, no line, no symbol, no exit code.

Steps:

| # | Corpus | Mode | Key | `derived_by` | Reason on hit |
|---|---|---|---|---|---|
| 1 | `memory` (team) | hybrid | error signature | `subject_anchor` | `error_signature_query_hit` |
| 2 | `task` | hybrid | error signature | `subject_anchor` | `error_signature_query_hit` |
| 3 | `pr` | hybrid | implicated paths, if any | `path_manifest` / `regex_path_extract` / `pattern_component_table` | `pr_path_query_hit` |
| 4 | `code` | **lexical** | implicated paths | same | `touched_file_query_hit` |

Steps 1-3 are unconditional and run **concurrently** — they have no data
dependency, and awaiting them in sequence cost one embed-plus-rerank round trip
each, per claimed worker, on a route with no `maxDuration`. Step 4 fires only
when all three come back weak **and** concrete keys exist. Step 1 is skipped in
sensitive workspaces (see Safety) and logged as `memory_skipped_sensitive`.

Step 4 is lexical because its key is a list of literal repo-relative paths.
Sending those through a dense embedder is the prose-against-code mismatch
consequence 2 above is about, so the recipe would be reintroducing the defect it
exists to fix. It keys on paths rather than symbols for the reason in decision 3.

Any hit the store reached by graph expansion rather than by the step's key
carries `graph_expansion_hit` instead of the reason in that last column, and is
excluded from the strength judgement — decision 9.

**Two extractors, not one.** `apps/web/src/lib/error-signature.ts`
deliberately destroys exactly the fields step 4 needs: it keeps only the first
non-empty line, and collapses `RE_PATH → <path>`, `RE_NUMBER → <n>`,
`RE_UUID`/`RE_HEX_ID → <id>`. That is correct for its job — a stable cluster key
so recurring failures collapse to one row — and useless as a search key. So:

- **identity extractor** — exists, untouched. `normalizeErrorSignature` →
  `toFrictionSignature` (`packages/core/failure-friction-signature.ts`) →
  `worker-failure:<stem>_<hash>`
- **search-key extractor** — turned out to already exist.
  `packages/core/friction-manifest.ts` runs on the raw excerpt and extracts
  repo-relative paths, falling back to a slug-keyed component table for the
  patterns whose errors never name a file (`bwrap`, `oom_killed`, `git_fatal`).
  `POST /api/tasks` already calls it to populate `tasks.path_manifest`, so the
  recipe reads the column first and re-runs the same extraction only when the
  column holds nothing but the `'**'` sentinel. Both paths therefore agree by
  construction rather than by coincidence.

  Nothing new needed writing here, which is the useful outcome: the design
  called for a second extractor because the identity extractor destroys paths,
  and the repo had already built exactly that for a different reason.

  **Its two halves are now separate functions** (`extractExcerptPaths` and
  `componentTablePaths`) because they are not the same evidence. One is a path
  the error named; the other is a static guess about which file owns a slug.
  Recording both as `regex_path_extract` — which the first version did — makes
  the most obvious cohort question unanswerable, so the split exists to keep the
  provenance honest rather than inferred.

Implementation hazard worth a comment at the call site: `normalizeErrorSignature`
names **two different functions with incompatible contracts** — the prose
normalizer in `apps/web/src/lib/error-signature.ts` and the strict slug validator
in `packages/core/subject-anchor-extractor.ts`. The bridge between them is
`failure-friction-signature.ts`, whose header already documents the trap.

Record from an actual run against a fixture store (synthetic values, real
shape — the previous hand-written example in this section could not have been
produced by the code, which is how it managed to make the broken 0.5 threshold
look attainable).

The bounded summary line, which carries everything the day-one metrics need:

```json
[context-assembly]
{
  "assemblyId": "<uuid>",
  "at": "2026-09-05T12:00:00.000Z",
  "recipe": "tool-infra-error-v1",
  "source": "live",
  "workspaceId": "<ws>", "teamId": "<team>",
  "trigger": { "layer": "exec", "subjectKind": "error", "signature": "oom_killed" },
  "weakEscalationFired": false,
  "fallbackFired": false,
  "chain": { "taskId": "<task>", "workerId": "<worker>", "missionId": null },
  "itemCount": 4, "pathCount": 1
}
```

The detail line, joined on `assemblyId`:

```json
[context-assembly-items]
{
  "assemblyId": "<uuid>",
  "derivedKeys": { "paths": ["apps/runner/src/workers.ts"] },
  "items": [
    { "step": 1, "corpus": "memory", "namespace": "<team>:memory",
      "chunkId": "docs/runbook.md#12", "sourcePath": "docs/runbook.md",
      "reason": "error_signature_query_hit", "derivedBy": "subject_anchor",
      "modeRequested": "hybrid", "signals": ["rerank", "rrf", "dense", "lexical"],
      "strength": 0.87, "strengthSignal": "rerank", "rerankApplied": true,
      "graphProximity": 1, "rank": 1, "score": 0.435,
      "scoreBreakdown": { "dense": 0.81, "lexical": 0.44, "rrf": 0.031, "rerank": 0.87 } },

    { "step": 2, "corpus": "task", "namespace": "<ws>:task",
      "reason": "step_query_empty", "derivedBy": "subject_anchor",
      "modeRequested": "hybrid" },

    { "step": 3, "corpus": "pr", "namespace": "<ws>:pr",
      "chunkId": "apps/runner/src/workers.ts#88",
      "sourcePath": "apps/runner/src/workers.ts",
      "reason": "graph_expansion_hit", "derivedBy": "path_manifest",
      "modeRequested": "hybrid", "signals": ["rrf", "dense"],
      "strength": null, "rerankApplied": false, "graphProximity": 0.6,
      "rank": 1, "score": 0.12,
      "scoreBreakdown": { "dense": 0.3, "rrf": 0.016 } },

    { "step": 4, "corpus": "code",
      "reason": "step_skipped_priors_strong", "derivedBy": "path_manifest" }
  ]
}
```

Four things in that output are worth reading closely, because each is a defect
this design previously had:

**`"score": 0.435` on a strong item.** That is `0.87 × 0.5` — relevance times
the `memory` corpus authority. It is the whole of decision 8 in one field: the
item is strong on the only comparable signal available (`rerank` 0.87, above the
0.5 threshold for that signal) while its `score` sits below the same number. A
predicate thresholding `score` would have called this weak.

**Step 3 is a `graph_expansion_hit` with `strength: null`.** Its
`graphProximity` is 0.6, so the store reached it by walking an entity edge from
a seed rather than returning it for the path key. It renders into the prompt —
it is a real retrieved item — but it does not claim the key returned it and it
does not count toward step 3's strength.

**Step 2 ran and got nothing; step 4 never ran.** Different rows, different
reasons. Step 4's `step_skipped_priors_strong` is the gate holding, because step
1 was strong — and it is a row rather than an absence, so "the gate held" is
distinguishable from "this recipe has no step 4".

**Every step has exactly one row.** Four steps, four rows, whatever happened.

### `conflict-v1`

Trigger: `OrganizerCause` of `conflict_escalation` or `claim_409` — the causes
raised by path-overlap serialization (`path_overlap_blocked` in the claim route,
`pathClaims` at `schema.ts:2555`).

The key is already computed: `knowledgePathsFromManifests`
(`mission-context.ts:24`) over the conflicting tasks' `pathManifest`.

| # | Corpus | Key | `derived_by` | Reason on hit |
|---|---|---|---|---|
| 1 | `pr` | contested paths | `path_manifest` | `pr_path_query_hit` |
| 2 | `code` | symbols at those paths | `regex_anchor_extract` | `touched_file_query_hit` |
| 3 | `task` | contested paths | `path_manifest` | `touched_file_query_hit` |
| 4 | `memory` + `plan` | mission prose | — | `fallback_semantic_search` |

Step 4 is the demotion of today's default behaviour, not its removal — which is
what makes this a priority ordering rather than an exclusion list.

### The weakness predicate

**It cannot be a threshold on `QueryResult.score`.** That is the single most
important constraint here and the first version of this design got it wrong; see
decision 8 for the arithmetic. `score` is post-rerank *and* post-decay —
`relevance × CORPUS_AUTHORITY[corpus] × recencyDecay(age)` — so any absolute
threshold on it encodes corpus authority and chunk age rather than strength. A
`task` hit cannot exceed 0.4 no matter how relevant it is.

So strength is judged on `scoreBreakdown`, in this preference order, and the
choice is recorded per item:

| Signal | Scale | Why |
|---|---|---|
| `rerank` | [0,1] | Cross-encoder relevance. The only corpus- and age-independent figure available. |
| `rrf` | ≤ 2/61 | Reciprocal Rank Fusion, k=60. One list's first place is 1/61. |
| `dense` / `lexical` | pipeline-specific | Single-retriever fallbacks. |
| `none` | — | No breakdown at all: strength is unjudgeable, so the step falls back to counting results and records `countOnly`. |

**Thresholds are keyed on the signal, not on the step.** An RRF value of 0.02 is
strong; a rerank value of 0.02 is not. One constant across both is meaningless,
which is what made the original single `MIN_STRONG_SCORE` degenerate rather than
merely imprecise. The earlier "per step" framing was aimed at the right problem
— numbers from different pipelines are not on one scale — but at the wrong axis.

`minStrongHits` stays on the step, because counting strong hits is scale-free and
therefore meaningful on day one in a way no score threshold is.

A step that returned nothing is **weak, not neutral**: a silent corpus and a
corpus full of bad answers are equally good reasons to escalate, and the
alternative reading would let an unindexed namespace quietly pin a recipe to its
first few steps forever. Same for a step that could not run — sensitivity-skipped
or key-less. Graph-expansion neighbours are **excluded** from the judgement
entirely, since the step's key did not return them (decision 9).

Two escalations follow, recorded separately:

- `weakEscalationFired` — an `onlyWhenWeak` step's gate opened because every
  preceding step was weak. Set **when the gate opens**, not when the query
  succeeds: an escalation that passed the gate and then had no key to query
  still escalated, and that is the recipe's most likely failure mode.
- `fallbackFired` — the recipe produced nothing renderable and the default prose
  fan-out served the request. Set by the executor, which is what knows.

Keeping them apart is not tidiness. "Step 4 had to fire" and "the recipe
produced nothing at all" are different failures, one flag cannot express both,
and a recipe can do the first without the second on the same assembly.

**These two rates are the load-bearing measurement, and they are scoreable on
day one with no outcome labels at all.** A recipe that falls back ninety percent
of the time does not work, and you know that before a single goal criterion has
moved. `spec_compare` already has the prose version of this signal ("retrieval
inconclusive — no implementation anchors could be extracted") and discards it.

That is also exactly why the threshold bug mattered: an always-weak predicate
makes the escalation rate a constant, and a constant looks like a working
recipe.

**Score incomparability, recorded but not solved.** Each item stores
`modeRequested`, the `signals` that actually came back, `rerankApplied`, and
`graphProximity`. No cohort analysis may compare `score` across rows differing
on any of them — and `score` is not even on the same scale as its own
breakdown, since it is post-decay and the components are pre-decay. This is a
known bug class here, not a hypothetical: `mcp-tools.ts:4310` records that
omitting the reranker on a fallback path made it "rank by age decay while the
server-built store ranked by cross-encoder relevance, so the same query got
different semantics depending on which path served it."

### The measurement loop

```
trigger → recipe → query transformation → retrieved context → action → goalCriteria before/after
```

**What this measures, stated precisely: which retrieval process preceded an
observed outcome.** Not which context caused a correct change. The distinction is
not pedantic — it is the constraint on every later use of this data. Designing
optimization around the stronger reading would be optimizing against an
attribution the log cannot support.

The gap is worst at plan time. A planning assembly may precede several actions
before any criterion moves, so a naive `assembly → next criterion transition`
join is last-touch attribution: it credits whichever assembly happened most
recently. An exec assembly is much closer causally — one claim, one worker, one
task outcome — but still not proof.

So the log stores the identifiers needed to **reconstruct the chain**, rather
than a single outcome field:

```
assembly_id
  → organizer pass id | claim id            (which decision consumed this context)
  → task id | worker id                     (what acted)
  → resulting task ids | pr number          (what was produced)
  → criterion key + transition + timestamp  (what moved, and when)
```

**What the record carries today is the left-hand side of that chain, not all of
it.** `AssemblyChain` holds `taskId`, `workerId`, and `missionId` — enough to
join an exec assembly to the task and worker that consumed it. The later links
are joins against rows that already exist (`workers.prNumber`,
`missions.goalCriteriaState`) and are only *usable* as a query once the assembly
rows are queryable, which is step 6. The chain fields are in the record now so
that step is a join rather than a backfill: an assembly whose task id was never
recorded cannot be reattached to its outcome afterwards at any price.

There is no claim id, because no claim-request identifier exists to record. The
chain diagram above lists one as the plan-time analogue of `taskId`; a declared
field that nothing ever sets is worse than an absent one, so it is absent. The
consequence is that the several workers of one claim request cannot be grouped —
`at` plus `taskId` is the closest available substitute.

Outcome side reads `missions.goalCriteriaState` (`schema.ts:763`) plus the
existing rearm fields (`criteriaRearmFingerprint`, `criteriaRearmCycles`) — a
rearm means the gate refused, which is a labeled negative and causally tighter
than a success, since the refusal is a direct response to that pass.

With the chain stored, cohort analysis can be restricted to the links it can
actually defend (exec assembly → its own task outcome) and can treat plan-time
links as weak evidence, instead of that choice being foreclosed by the schema.

Two existing facilities cover part of this and must not be confused with it:

- **Hit tracking** (`pg-vector-store.ts:413`) — global per-chunk counters, no
  assembly identity, no outcome. Untouched by this design.
- **Offline eval** (`packages/core/scripts/eval-retrieval.ts` over
  `packages/core/scripts/eval/golden-queries.json`, thresholds in
  `packages/core/eval/regression.ts`, baseline in
  `packages/core/eval/retrieval-baseline.json`) — recall@k / MRR / NDCG against a
  golden set. **Reuse this for cohort scoring rather than inventing metrics.**

**Every claim emits exactly one record, including the ones that took the
fan-out.** That is the denominator, and it is what makes the two day-one rates
computable rather than merely present:

```
grep '[context-assembly]' | jq -s 'group_by(.recipe)[] | {
  recipe: .[0].recipe,
  n: (map(.assemblyId) | unique | length),
  fallbackRate:       (map(select(.fallbackFired))       | length) / length,
  weakEscalationRate: (map(select(.weakEscalationFired)) | length) / length }'
```

Without the fan-out record that aggregation has no denominator: zero
`tool-infra-error-v1` lines would be indistinguishable from no eligible tasks and
from a regressed selector. It also supplies the control arm — the fan-out is the
cohort the recipe has to beat.

`at` is on the record rather than left to the log platform's line timestamp,
because the first step of any pipeline that treats these as records is to strip
the prefix, and that takes the platform timestamp with it.

**This phase instruments only.** No policy is learned from `goalCriteriaState`.
Cohorts are compared by hand; a learned retrieval policy is explicitly deferred
(see Non-goals).

### What the assembly row stores

References and provenance, **not retrieved content.** Full chunk text is never
copied — join back to `knowledge_chunks`. That keeps rows small and shrinks the
retention and disclosure surface to something manageable.

Per item: `namespace`, `corpus`, `chunkId`, `sourcePath`, step, reason,
`derivedBy`, `modeRequested`, `signals`, `strength` + `strengthSignal`,
`rerankApplied`, `graphProximity`, rank, `score`, `scoreBreakdown`. Per
assembly: `assemblyId`, `at`, recipe, `source`, `workspaceId`, `teamId`,
trigger, `derivedKeys`, the two escalation flags, and the chain.

Three qualifications, all of them things review had to correct:

**`namespace`, not just `corpus` — the join was ambiguous, not merely
dangling.** `knowledge_chunks` is unique on `(namespace, source_id)`, and source
ids are composite `path#line` values, so the same id exists in every workspace's
`:code` namespace. Recording `chunkId` + `corpus` alone meant the join the
no-content decision rests on could not identify a row across tenants. The
assembly also carries `workspaceId` / `teamId`, without which the namespace
cannot be reconstructed and no cohort can be segmented or have a noisy tenant
excluded.

**The join can still dangle.** Chunks are pruned and superseded —
`pruneOrphans` in `apps/runner/src/knowledge-ingest.ts`,
`supersedes`/`supersededBy` and `contentDedup` in `knowledge-store/types.ts`. A
chunk retrieved today may be gone before anyone analyses the cohort. Hence
`sourcePath` alongside the id: enough to tell what an evicted item *was* without
storing what it *said*. Note the limit of that mitigation — `memory` chunks are
upserted with no `sourcePath`, so it is null on exactly the recipe's first step.

**Derived keys are production data.** The record contains the error signature
and repo-relative paths — that is the point of logging the transformation. The
raw excerpt is **not** stored: it is read to extract paths and then dropped, and
whether that stays true is the thing to guard if a future step keys on excerpt
text directly. Paths are clamped, deduped, and capped. One honest gap:
`friction-manifest.ts` returns a path unchanged when it matches neither
`/apps/` nor `/packages/`, so an absolute host path from an error line can reach
the log. No credential material, but host layout — and such a path is also
useless as a search key, so dropping non-repo-relative paths would improve both.

### Where CBM fits

CBM stays worker-side. Server-side references are `skill-and-role-injection.ts`
(mounts the MCP for a worker), the metrics route, and `packages/core/cbm-health.ts`
— nothing in `apps/web` queries the graph, and `BY_DESIGN_SKIP_REASONS`
(`cbm-insight.ts:27`) records why: `codex_task`, `no_worktree`, `role_opt_out`.
The graph exists only where a worktree exists, so plan time cannot reach it.

If the organizer ever needs structural facts, it gets a **small derived
summary** — blast radius, inbound callers, test-coverage presence, on the order
of five lines — never graph output or code snippets. Out of scope here.

## Safety

- **Defaults are a no-op.** Cluster selection defaults to the current
  five-corpus fan-out. A trigger with no registered recipe behaves exactly as
  today, so merging changes nothing until a recipe is registered.
- **Retrieval never blocks.** `buildKnowledgeContext` returns `[]` on any
  failure and both callers are best-effort. Clusters inherit it:
  `buildClusteredKnowledgeContext` catches everything and returns no parts, the
  caller then runs the fan-out, and the claim still succeeds. A store that is
  down therefore costs a claim nothing but a log line.
- **Bounded assembly.** `budgetChars` per recipe, truncating on whole lines so a
  clipped block never ends in half a file path that reads as a real one; `topK`
  and the step list are both per-recipe constants. No recipe can grow the prompt
  without a committed constant changing. A clustered block is smaller than the
  fan-out it replaces, but that is a side effect — see Non-goals.
- **Sensitivity is a recipe change, not a filter.** `buildKnowledgeContext`
  drops the team `memory` corpus entirely when `sensitive` is set. `tool-infra-error-v1`
  therefore *loses its own step 1* in a sensitive workspace. This must be logged
  as `memory_skipped_sensitive` or cohorts silently mix two populations — the
  same green-over-an-empty-set shape the test suite has been bitten by before.
- **Eval runs must not pollute live cohorts.** `eval-retrieval.ts` and
  `assess-knowledge.ts` already pass `trackHits: false` for exactly this reason.
  The record carries a `source: 'live' | 'eval'` discriminator with the same
  purpose; it defaults to `live`, and an offline caller has to set it.
- **The record is production data.** Derived keys carry error signatures and
  repo-relative paths even though retrieved content is not copied. Today it goes
  to stdout, so it lands wherever the platform's logs land and nowhere else —
  no new store, no new retention decision, and nothing added to a response body
  or a prompt. Every example in this doc is synthetic; fixtures must not carry
  captured values.

## Implementation sketch

Ordered; the load-bearing piece is the record, since without it the recipes are
unfalsifiable.

**Done.**

0. ~~Scope decision for `tool-infra-error-v1`.~~ Resolved narrow — decision 1,
   enforced by `isToolInfraSignature`.
1. ~~Query `spec` in `buildKnowledgeContext`.~~ Dropped: wrong corpus, and the
   hint half was fixed by PR #2130 — decision 4. The real gap (the `docs`
   corpus is counted and never queried) moves to step 7.
3. ~~`tool-infra-error-v1` behind cluster selection, with the shared weakness
   predicate.~~ `packages/core/retrieval-clusters.ts` holds the vocabulary,
   recipe, scope check, selector, and predicate; `buildClusteredKnowledgeContext`
   in `knowledge-context.ts` executes it; `attachKnowledgeContext` selects. The
   default is the untouched fan-out, and a recipe that yields nothing falls
   through to it.
4. ~~Token caps + uncertainty notes.~~ `budgetChars` per recipe, truncating on
   whole lines, plus a per-recipe uncertainty trailer.
5. ~~Assembly record.~~ Emitted as two lines per assembly —
   `[context-assembly]` (bounded aggregate) and `[context-assembly-items]`
   (detail, joined on `assemblyId`) — references and provenance only, never
   chunk content, with chain identifiers rather than an outcome field. Every
   claim emits one, including fan-out claims, so the rates have a denominator.
   **Not yet persisted** — decision 7.

   Complete for the metrics it was built for. Not complete in the abstract:
   there is no claim id (nothing to record), plan-time triggers and
   `source: 'eval'` are unreachable until a plan-time selector and an offline
   caller exist, and `sourcePath` is null for `memory` chunks.

**Next, in order.**

6. **Assembly table.** Indexed `assembly_id`, a `source: live | eval`
   discriminator so offline scoring cannot pollute live cohorts, and the
   criterion-transition join. This is now a writer against a settled record
   shape rather than a design question. Needs a retention answer (see Open
   questions).
7. **Evaluate `tool-infra-error-v1` before adding a second recipe.** Fallback
   rate and weak-escalation rate per recipe first, against the fan-out cohort —
   both answerable from the logs today with no outcome labels. This gate is the
   point of the phase; skipping it to add `conflict-v1` would forfeit the
   comparison that justifies the whole design.

   Read the escalation rate before touching `MIN_STRONG_BY_SIGNAL`. The
   thresholds are guesses; what makes them checkable now rather than later is
   that a rate pinned at 0% or 100% is visible in the logs, which is exactly
   what the previous `score`-based threshold hid.
8. **Then plan-time.** `conflict-v1`, querying the `docs` corpus in the shared
   path, and lifting `extractImplementationAnchors` out of `mcp-tools.ts:4617`
   into a shared module for symbol-keyed `code` queries (regex, no model;
   `spec_compare` keeps calling the same function). Each of these is a
   plan-time concern and none of them is needed to evaluate the exec-time
   recipe.

Separable, unblocked, and worth doing whenever: extend
`error-trace-scanner.ts` + `KNOWN_ERROR_SLUGS` with test, compiler, and
stack-trace patterns. The recipe widens with the catalog automatically, and
`stack_symbol_query_hit` becomes reachable at that point — but the scanner would
also have to start emitting more than one raw line for a symbol key to exist.

Also worth removing separately: the `spec`-namespace double-write at
`knowledge-ingest.ts:182`, which now feeds nothing and costs embedding calls.

## Open questions

- ~~**Cluster registry shape.**~~ Settled: a `selectExecCluster` switch. One
  recipe does not justify a registry. Revisit at four.
- **Where the assembly log lives.** Still open, deliberately. The record is a
  log line today (decision 7), which answers the day-one questions without a
  migration. When it lands: a new table, not an existing jsonb column — the
  outcome join needs an indexed `assembly_id`, and stuffing it into
  `tasks.context` makes every cohort query a jsonb scan.
- **Retention.** These rows accumulate per assembly, which is per organizer pass
  and per claim. Storing references rather than content makes each row small
  enough that I lean on a generous window with per-item detail pruned and
  aggregates kept — but the window length is still a cost question I do not have
  the numbers for. Note the interaction with chunk eviction: pruning assembly
  detail and pruning chunks are independent clocks, and analysis needs both.
- ~~**Do both layers share one recipe namespace?**~~ Settled by construction:
  the vocabulary and recipe types are shared in `packages/core/retrieval-clusters.ts`,
  the selector is layer-specific (`selectExecCluster`). A plan-time selector
  lands with `conflict-v1`.
- **Weakness thresholds.** Still open, and still the sharpest question — but a
  different one than before. `MIN_STRONG_BY_SIGNAL` ships `rerank: 0.5`,
  `rrf: 1/61`, `dense: 0.5`, `lexical: 0.05`. Those are guesses. What changed is
  that they are now guesses on a comparable scale rather than on a number whose
  ceiling was below the threshold, so a rate pinned at 0% or 100% shows up in
  the logs instead of looking like a working recipe. Order: ship the guess, read
  the escalation rate against the fan-out cohort, then set the value — ideally
  cross-checked against the golden-query baseline
  (`packages/core/scripts/eval/golden-queries.json`).
- **Whether `worker-failure:*` should ever select a recipe.** Excluding it
  (decision 2) is right for a cohort-comparison phase, and it cuts the eligible
  population hard, since that namespace is the common anchor for agent-filed
  friction. The honest way back in is not to widen the allowlist but to widen
  the scanner catalog, so those failures acquire a real slug. Worth revisiting
  once there is a fallback rate to compare against.
- **Non-repo-relative paths in derived keys.** `friction-manifest.ts` passes
  through absolute host paths that match neither `/apps/` nor `/packages/`.
  They are useless as search keys and they put host layout in the log, so
  dropping them looks strictly better — but it changes `tasks.path_manifest`
  inference for every friction task, not just this recipe, so it wants its own
  change.

## Non-goals

- **No learned retrieval policy.** No optimization against
  `goalCriteriaState` in this phase. Instrument, then compare cohorts by hand.
- **No `missions.kind` column.** Mission type is the wrong selector; the
  question being answered on this pass is the right one, and `OrganizerCause` +
  `subjectKind` already express it. A kind enum is a taxonomy that would be
  guessed wrong and then migrated.
- **No plan-time graph access.** CBM stays worker-side. Organizer-facing
  structural summaries are a separate design.
- **No LLM-generated selection reasons**, ever — that is the crux, not a phasing
  decision.
- **No changes to hit tracking**, `spec_compare`'s behaviour, or the identity /
  friction-dedupe signature path.
- **No new corpora.** `docs`, `artifact`, `initiative`, and `session` remain
  pull-mode only until a recipe needs one.
- **Not a prompt-size reduction project.** Clusters may make some assemblies
  larger. The claim is situational relevance and measurability, not fewer tokens.
