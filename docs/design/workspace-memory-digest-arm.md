# Task-Scoped Workspace Memory (experiment arm)

**Status:** Implemented — `task_scoped` arm and the composition record ship with this doc; enrolment defaults to nobody.
**Related:** `apps/runner/src/memory-digest-policy.ts`, `apps/runner/src/prompt-builder.ts`, `apps/runner/src/workers.ts`, `apps/runner/__tests__/unit/memory-digest-policy-version-pin.test.ts` (guards the control against mid-flight change), `packages/core/db/schema.ts` → `worker_prompt_composition_events`, `docs/design/mission-context-clusters.md`, `docs/design/retrieval-policy-evaluation.md`

## Problem

Every worker prompt carries a `## Workspace Memory` block. Its first and much
larger half is a digest built by `BuilddClient.getCompactObservations(workspaceId)`
— keyed on the workspace and nothing else, so it is **identical for every task in
the workspace**. Its second half, `### Relevant to This Task`, comes from
`searchObservations(workspaceId, task.title, …)` and is task-conditional.

Three observations, in increasing order of how much they should bother you:

1. The digest is the single largest block in a typical prompt, and larger than
   the task description by a wide margin. A worker reads far more about the
   workspace in general than about the thing it was asked to do.
2. It is truncated by a blind `slice()` at a byte cap. Nothing makes the cut fall
   on a line boundary, so the block routinely ends mid-sentence — and which
   lines survive is an artifact of digest ordering, not of relevance.
3. Measured against CLI session transcripts, the paths named in retrieved
   context barely predict the paths a task goes on to touch, and most of what is
   retrieved duplicates what the agent reads for itself anyway. On the
   navigational job the block appears to be doing, it is not doing it.

Everything shipped in `mission-context-clusters.md` improved the *task-conditional*
retrieval and never touched the task-independent digest, which is where the bytes
actually are.

## Proposal

Introduce two arms of the memory block, selected per task:

| arm | workspace-wide digest | `### Relevant to This Task` | `recall`/`learn` pointer |
|---|---|---|---|
| `full` (default) | yes, blind-sliced at the cap | yes | yes |
| `task_scoped` | **no** | yes | yes |

Enrolment is a fraction in `[0, 1]`, default `0`, set per runner by
`BUILDD_MEMORY_DIGEST_TASK_SCOPED_FRACTION` or by
`memoryDigestTaskScopedFraction` in the runner's `config.json`. At `0` every
prompt renders the control.

The control has been corrected twice relative to the pre-experiment rendering,
both times before any enrolment so there were no collected rows to invalidate:

1. The digest used to arrive from `getCompactObservations` carrying its own
   `## Workspace Memory (N memories)` heading, which landed *underneath* this
   block's header — so every prompt in the fleet showed the heading twice. The
   digest is now pure content and the block header owns the count, in **both**
   arms, which keeps the arms one axis apart.
2. The cap used to be a blind `slice()`, so an oversized digest routinely ended
   mid-sentence or mid-word and which entries survived was an artifact of
   digest ordering. It now backs up to the last complete line at or below the
   cap (`policyVersion` bumped to `memory-digest-v2` for this change).
3. `### Relevant to This Task` was retrieved by matching the whole task title
   as one `ILIKE '%…%'`. Measured in production that returned **nothing** for
   every prompt build in the sample — a whole title only appears verbatim in a
   memory written by a prior run of the *same recurring task*, so it worked for
   repeating scheduled work and failed for all novel work. Retrieval is now
   declared paths first (`tasks.path_manifest` against `memories.files`) with
   the title as fallback (`policyVersion` bumped to `memory-digest-v3`).

4. The title-fallback step then changed again, from a whole-title phrase match
   to filtered, ranked tokens. An unfiltered token split would have matched most
   of the corpus on a stopword and returned the most recently updated rows, so
   tokens are filtered and results ranked by how many matched
   (`policyVersion` bumped to `memory-digest-v4`).

That third change matters more than it looks for this experiment. Under v1/v2
the treatment was effectively *"no memory at all, use `recall`"*, because the
task-conditional half was empty in both arms. Under v3 the arms are what was
originally intended: **task-scoped memory versus workspace-wide memory.** The
version bump re-randomises (the draw is salted with it), so no task carries an
arm it drew against a different definition of what that arm means.

Any of these made *after* enrolment starts would still require a policy-version
bump — moving the control mid-flight silently rebases the comparison. All three
landed before anyone was enrolled, which is the only time it is free.

**The crux: the digest is not being used for navigation, and losing it costs
nothing that the `recall` tool cannot recover on demand.**

If that is wrong, it is wrong in a specific way — the digest may be shaping *how*
code gets written (conventions, house patterns, prior decisions) rather than
*where* the agent looks. Path-overlap measurement is blind to that entirely. This
is precisely why the change ships as an arm with nobody enrolled rather than as a
smaller cap: a proxy metric is enough to justify an experiment and not enough to
justify editing every prompt in the fleet.

### Randomisation unit

The task, not the worker. A retried task gets a fresh worker, and the outcomes
this is judged on — the rework columns (`ciRetryPrNumber`, `conflictRetryPrNumber`,
`reviewerRetryPrNumber`, `criteriaRearmCycles`) — span attempts. Randomising per
worker would split a single outcome across both arms.

Assignment is a deterministic hash of the task id, so it is stable across runner
restarts and reproducible at analysis time without storing an assignment table.
The hash is **salted with `MEMORY_DIGEST_POLICY_VERSION`**, so bumping the
version re-randomises: without the salt every task would keep the arm it drew
under `v1`, and a `v2` comparison would silently inherit both `v1`'s assignment
and any carry-over effect from it.

The hash is FNV-1a, which is measurably less uniform for ids differing only in a
short suffix. Task ids are v4 UUIDs (`tasks.id` is `uuid().defaultRandom()`), so
this does not bite — but it is why the distribution test uses UUID-shaped
fixtures rather than `task-1`, `task-2`.

### One axis, deliberately

`task_scoped` still emits the block header and the `recall`/`learn` pointer even
when nothing matched the task. That pointer is behavioural instruction, not
context: dropping it would change how often agents record knowledge, and the
result would confound a context-size effect with an instruction-removal effect.
The arms differ on exactly one thing, and a test asserts it — deleting the digest
lines from a control block yields the treatment block character for character.

### The composition record

Each prompt build emits one `prompt-composition` record — **in both arms**. A
control row is as necessary as a treatment row: without it, "no enrolled prompts"
and "no prompts at all" are the same observation. It carries the arm, the
propensity it was drawn at, the policy version, and the block sizes, including
`digestBytesAvailable` — what the digest *would* have cost — so the saving is
computable from a control row alone instead of requiring the two arms to be
joined first.

Sizes are UTF-8 byte lengths. The cap slices by code unit, as it always has, but
the prompt-budget question is about bytes and workspace memory carries non-ASCII.

The record is built at the **last** line that mutates the prompt, not at the end
of prompt assembly: the Codex branch prepends an AGENTS.md pointer much later, so
a record built earlier understates `promptBytes` and inflates `memoryShare`. It
also carries `backend`, because the Codex path delivers the role persona, inlined
skills and project instructions through a file on disk rather than through the
prompt — `memoryShare` therefore means a different thing per backend and rows
must be segmented, never pooled.

## Turning it on

```bash
# 10% of tasks lose the workspace-wide digest.
BUILDD_MEMORY_DIGEST_TASK_SCOPED_FRACTION=0.1
```

Env var wins over `config.json`; a set-but-empty env var falls through to the
saved value rather than shadowing it with `''`. A value outside `[0, 1]` runs the
control — `15` meant as 15% does not become 15× or clamp to full enrolment, it
becomes 0. The knob is per runner, so a fleet with several runners needs it set
on each; the *assignment* is per task and identical on every runner, so a task
does not change arm depending on who claims it.

Check what is actually happening by grepping runner stdout for
`[prompt-composition]`. Every prompt build emits one line, in both arms.

Before changing anything about the block itself, confirm nobody is enrolled —
the `full` arm is the control and moving it mid-flight invalidates the result.

## Non-goals

- **Changing the task-conditional half.** Match count and per-observation cap are
  untouched in both arms.
- **Retrieval-side changes.** Nothing here alters what `getCompactObservations`
  or `searchObservations` return; this is purely about what reaches the prompt.
- **A durable analysis rail.** Out of scope when this was written. It has since
  shipped — see "Where the record durably lands" below.

## Resolved

**Where the record durably lands.** `worker_prompt_composition_events`
(`packages/core/db/schema.ts`, migrations `0152_rainy_miek.sql` and
`0153_greedy_mad_thinker.sql`). One row per prompt build, queryable, with
`policy_version` and `arm` indexed together so a cohort can be selected without
a scan.

The path: the runner appends each record to a per-worker buffer
(`appendPromptCompositionEvent`), `worker-sync.ts` drains the buffer onto the
next `PATCH /api/workers/[id]`, and the route inserts the rows. The insert is
`onConflictDoNothing` against a unique index on `(worker_id, build_index)`, so a
retried sync re-sends the same buffer without duplicating rows — which is why
`build_index` is threaded through explicitly rather than reset per build.

It landed as an event table rather than columns on `workers` for the reason
predicted here: the record is per prompt build and a looped or bwrap-retried task
builds several, so columns would silently keep only the last one.

Two columns are deliberately NULLable — `task_match_derived_by` and `backend`.
A row written by a runner predating either field is genuinely unknown, and
defaulting it would encode an inference as data: it would pool a Codex row into
the Claude cohort, or make a stopword hit indistinguishable from a declared-path
hit. Filter those rows out rather than imputing them.

The two older sinks — the per-worker session log (pruned after 48 hours) and
runner stdout — still exist and are still worth grepping for
`[prompt-composition]` to confirm the arm fires at all. Neither is the analysis
source any more.

## Open questions

**Whether an intermediate arm is worth adding.** A `task_scoped` result that comes
out negative would leave open whether a *smaller but non-empty* digest is better
than either arm. I lean towards not adding it pre-emptively — three arms triples
the exposure needed for the same power, and the binary comparison answers the
question that is actually blocking.

**Whether the digest should be task-conditional rather than absent.** The
strongest version of this change is not subtraction at all: retrieve the digest
against the task, the way `searchObservations` already does, and drop the
workspace-keyed call entirely. That is a server-side change to what
`getCompactObservations` means, it makes the arm no longer one axis, and it
should wait until the binary result says the block matters at all.
