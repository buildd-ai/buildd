# Task-Scoped Workspace Memory (experiment arm)

**Status:** Implemented — `task_scoped` arm and the composition record ship with this doc; enrolment defaults to nobody.
**Related:** `apps/runner/src/memory-digest-policy.ts`, `apps/runner/src/prompt-builder.ts`, `apps/runner/src/workers.ts`, `docs/design/mission-context-clusters.md`, `docs/design/retrieval-policy-evaluation.md`

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

Enrolment is a fraction in `[0, 1]`, default `0`. At `0` every prompt is
byte-identical to the behaviour that preceded this doc — including the blind
slice, which is deliberately *not* fixed here. Straightening the truncation is a
genuine improvement, but doing it in the same change would move the control while
the experiment runs, and then neither result means anything.

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

## Non-goals

- **Fixing the blind truncation.** Line-boundary truncation is right and is
  deliberately deferred so the control stays fixed.
- **Changing the task-conditional half.** Match count and per-observation cap are
  untouched in both arms.
- **Retrieval-side changes.** Nothing here alters what `getCompactObservations`
  or `searchObservations` return; this is purely about what reaches the prompt.
- **A durable analysis rail.** See below.

## Open questions

**Where the record durably lands.** Today it goes to the per-worker session log
and to runner stdout. The session log is pruned after 48 hours, which is shorter
than the rework chains the experiment is measured on, so stdout is currently the
only rail that outlives the window. That is enough to *run* the arm and not
enough to *analyse* it. I lean towards a small server-side event rather than a
column on `workers`: the record is per prompt build, and a looped task builds
several, so a column would silently keep only the last one.

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
