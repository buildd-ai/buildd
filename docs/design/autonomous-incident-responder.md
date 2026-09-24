# Autonomous incident responder

**Status:** Proposed
**Related:** `apps/web/src/app/api/cron/queue-stall/route.ts` (the detector that
went unheard), `apps/web/src/lib/cron-run.ts` (`withCronRun`, `cron_runs.alerted_at`),
`packages/core/signal-registry.ts` + `scripts/signal-fire-coverage.test.ts` (fire-test
convention), `apps/web/src/app/api/workers/claim/route.ts` (the path that failed),
`apps/web/src/lib/gate-ledger.ts`, `apps/runner/src/doctor.ts` (in-runner self-heal),
`docs/design/DESIGN-FORMAT.md`

## Problem

A dispatch outage ran for most of a night. The queue was non-empty, the runner was
healthy and heartbeating, and no work started.

**The detector was already there, already scheduled, and already right.**
`queue-stall?scope=fleet-idle` is registered in `cron-manifest.json` on an hourly
schedule. It ran on every one of fourteen consecutive hours, succeeded every time,
and recorded a non-zero alarm count on every run.

The alarm was computed and discarded, fourteen times. The outage was found by a
human opening a terminal.

### Why it was silent

`apps/web/src/app/api/cron/queue-stall/route.ts` has two branches. The default
branch runs `runCronJob`, which calls `notify(...)`. The `scope=fleet-idle`
branch calls its detector, passes the result to `report(...)`, and returns the
JSON:

```ts
if (req.nextUrl.searchParams.get('scope') === 'fleet-idle') {
  return withCronRun('queue-stall:fleet-idle', req, async report => {
    const result = await detectFleetIdle();
    report({ processed: result.accountsChecked, changed: result.alarms, errors: 0, result });
    return NextResponse.json(result);        // no notify() on this path
  });
}
```

There is exactly one `notify(` call in the file and it is in the other branch. So
the fleet-idle scope **cannot** notify — not misconfigured, not throttled, not
deduplicated. It has no notification path.

### Why the cron health check could not save it

`withCronRun` does have its own alarm: `checkHealth` in
`apps/web/src/lib/cron-run.ts` evaluates recent runs of the job, notifies, and
stamps `cron_runs.alerted_at`. It did not fire, and it was right not to — its
alarm condition is a job *"running but accomplishing nothing"*, judged partly on
the `changed` counter.

That is the inversion at the heart of this incident. The fleet-idle job reported
`changed` = the number of alarms it found. Finding a problem every single hour
therefore reads as **maximally healthy work** to the only supervisor watching it.
The worse the outage got, the healthier the detector looked.

So `alerted_at` being NULL on those rows is correct and consistent — it records
job-health paging, not finding paging. There is no field anywhere that records
"this job found something and told someone", because on this branch nothing ever
could.

### The second, larger problem: nothing responds

Suppose the page had been delivered. Nothing would have acted on it.

buildd's remediation loop runs *on* buildd: work items live in the production
database, dispatch goes through `POST /api/workers/claim`, and the runner needs
the API to receive anything. When the dispatch path is the broken thing, buildd
cannot dispatch a repair for it. The dependency is circular, and the outage is
exactly when the circle closes.

The same window also produced intermittent 5xx responses from the claim route at
a low hourly rate, with an empty body and several times the latency of a success
— the shape of a resource-acquisition timeout rather than a logic error. Nobody
saw them until a human read a log. A responder that classified "endpoint X began
returning 5xx shortly after release Y" would have had a candidate cause and a
rollback target within minutes.

## Proposal

Four changes, smallest and most general first. The first two are cheap and stand
on their own; the responder only earns its complexity after them.

### 1. Make `changed` mean one thing, then assert the consequence (do this first)

The `changed` counter is currently overloaded: for most jobs it counts *work
done*, and for a detector job it counts *problems found*. Those are opposite
signals feeding one supervisor, which is why the supervisor read an outage as
health.

Declare the polarity on the job, in `packages/core/signal-registry.ts` — a job's
`changed` is either `work` or `findings`. Nothing is inferred from the result
shape; inference silently misclassifies the next job someone adds.

Then two consequences follow mechanically:

- **A `findings` job must have a notification path.** Assert it with a test, not a
  convention — a `findings` job that can raise an alarm and has no way to report it
  is a build failure. This is the check that would have caught the present bug
  before it shipped, and it catches the next one written the same way.
- **`checkHealth` must invert for `findings` jobs.** Sustained non-zero `changed`
  on a `findings` job is the alarm, not the all-clear.

Register both in the signal registry so `scripts/signal-fire-coverage.test.ts`
requires a test proving each can fire — the convention that a signal without a
demonstrated failure mode is not a signal.

### 2. Close the specific gap

`scope=fleet-idle` must notify, and must stamp `alerted_at` when it does. Any
alarm-shaped cron branch that can raise an alarm must either notify or record
explicitly why it chose not to; "returned JSON to a scheduler that discards it"
is not a choice, it is an omission.

### 3. The responder

A small daemon whose defining property is that **it does not depend on the system
it watches.**

- **Runtime:** its own process with its own lifecycle, not inside the worker
  container and not on Vercel. A container rebuild or a serverless outage must not
  remove the watcher.
- **Credentials: reuse the existing OAuth credential.** The tempting answer is a
  dedicated credential per responder, isolated from the platform's. Rejected, for an
  operational reason that outweighs the isolation: a separate credential is one more
  thing to provision, rotate and remember, and credential rot has already been a
  real failure mode here — an expired refresh token and a stale encryption key have
  each taken out working systems. A responder disarmed by a credential nobody
  renewed is worse than one that shares the platform's.

  The shared-fate objection is real and is answered by design rather than by a
  second secret: **every detector must be evaluable without a model call.** The
  detectors are deterministic queries over status codes, timestamps and counters. A
  dead credential therefore costs the *diagnosis narrative*, not the alert — the
  responder degrades to a pager that still says which condition tripped and when.
  Notification must use a path that does not depend on the model credential at all.
- **State:** local, embedded. Never the production database — that is shared fate.
- **Inputs, all black-box:** the claim endpoint's status code and latency; the
  version endpoint; recent CI runs; the runner's local HTTP port; and `cron_runs`
  as a read-only feed. It asserts outcomes, never internals.
- **Output:** a notification with the evidence, and — for a short list of
  pre-authorized conditions — an action.

### 4. Where the code lives: same repository, independent deployment

**This is the crux.** The design turns on separating *code location* from *runtime
fate*.

A separate project would duplicate the operational knowledge this repo already
carries — which log holds runner stdout, that one CI log command returns empty and
must be replaced by the jobs API, which database columns are unpopulated and cannot
carry a metric. Duplicated, that knowledge rots independently and the copy is wrong
first.

So: the responder's code lives here, beside the knowledge and the shared types, and
is **deployed out-of-band** with an independent trigger.

If this is wrong — if "independent" turns out to be partial, and the responder ends
up needing the claim route, the production database, or the platform's notification
path for its own operation — then it fails in precisely the situation it exists for,
and its presence is worse than its absence because it will be trusted. Every input
above is therefore chosen to be assertable from outside.

## Safety properties

Anything automatic states its bound.

- **Action budget:** at most one remediation per condition per hour, and a hard
  ceiling per day across all conditions. Exceeding it pages instead of acting.
- **Give up:** after three ineffective attempts at the same condition, stop acting
  on it and escalate. "Ineffective" is measured — the condition still holds after
  the action — not assumed.
- **No silent action:** every action writes a durable record with the triggering
  evidence, the action, and the observed result. An action with no recorded reason
  is a defect.
- **Rollback preconditions:** a release rollback requires a temporal correlation
  between the failure onset and a release, *and* a prior tag that was observed
  healthy. Absent either, it pages.
- **Write scope:** read-only against production by default. The single exception is
  terminalizing an orphaned worker row (a row holding work with no process attached,
  which otherwise blocks that work indefinitely), behind its own explicit flag.
- **Defaults are no-ops:** ships in observe-only mode. Every action is gated behind
  a flag defaulting to off, so merging changes nothing until someone opts in.

## Open questions

- **Where it runs.** A host-level daemon outside the worker container, a second
  independent deployment, or a separate minimal host. *Leaning:* host-level daemon
  outside the container — it survives container rebuilds, which is the failure mode
  we actually hit, and it can observe the runner locally. It still shares fate with
  the host; a separate host removes that but adds a second thing to maintain, and an
  unmaintained watcher is the worse outcome.
- **May it write to production at all?** *Leaning:* yes, for orphan terminalization
  only. That case is well defined, it blocks work indefinitely when left, and it had
  to be done by hand during this incident — including once as the direct result of an
  operator probe against a live claim endpoint, which is itself an argument for a
  tool that does it correctly and records it.
- **What if the shared OAuth credential is the thing that is down?** This is the
  accepted cost of reusing it, and the mitigation is the credential-free detector
  rule above: the responder still pages, without a narrative. *Open sub-question:*
  whether a dead-credential condition should itself be one of the responder's
  detectors. *Leaning:* yes — it is cheap to check, it has precedent as an outage
  cause here, and a responder that notices its own disarmament is strictly better
  than one that goes quiet.
- **Should it own the existing host healthcheck** (which lives in a separate
  infrastructure repository)? *Leaning:* no — but it should assert that healthcheck
  is *capable of failing*, since a monitor that has never failed is indistinguishable
  from one that cannot.
- **Retrofitting `changed` polarity.** Every existing cron job needs a declaration,
  and a wrong one is worse than none: marking a `work` job as `findings` inverts its
  health check and pages on success. *Leaning:* default to `work` (the current
  behaviour, so merging changes nothing) and declare `findings` explicitly per job,
  starting with the detector jobs this incident implicates.

## Non-goals

- Not a replacement for the in-runner self-heal in `apps/runner/src/doctor.ts`; that
  fixes the runner from inside and cannot act when the runner is gone.
- Not a general on-call or paging product, and not customer-facing alerting.
- Does not gate releases and does not review code.
- Not a second work queue. It must never grow a backlog; if a condition needs
  multi-step work, it files that work through the normal path and stops.
- Does not attempt to diagnose application logic bugs. Its domain is *the platform
  is not doing its job*, which is an outcome assertion, not a code review.

## Implementation sketch

Ordered, load-bearing first.

1. Silent-alarm invariant + its fire test, registered in the signal registry. Cheap,
   general, and independently valuable even if nothing else here ships.
2. Notification on the fleet-idle branch, and the inverted health verdict for
   `findings` jobs.
3. Responder skeleton in observe-only mode: inputs, evidence record, notification.
   No actions.
4. The two detectors this incident justifies: dispatch stall (claims attempted,
   none claimed, queue non-empty, sustained) and claim-endpoint **5xx-and-unreachable**
   rate.

   Not "non-2xx rate", which an earlier draft of this doc specified and which is
   wrong: the health probe must be structurally incapable of claiming work, so it
   sends a request the route is guaranteed to reject and `400` is the *healthy*
   response. A non-2xx rate therefore sits at 100% permanently — a green light
   wired to a signal that cannot change, which is the same defect class this
   document diagnoses. Caught during implementation (#2597); recorded here rather
   than quietly fixed, because the mistake is instructive: a probe's healthy
   response is whatever its own construction forces, not whatever HTTP convention
   suggests.

   A `2xx` from that probe is a **defect**, not a success: it means the guard that
   makes the probe unclaimable is gone, and something may have claimed work on
   behalf of a runner that will never attach.
   A third detector followed from a separate incident: **role regression after a
   change** — one role going from all-succeeding to all-failing on one error
   signature right after a runner release, unpaged for most of a working day
   because every failure landed under the generic exit cause. It reads the
   `role-outcomes` cron feed (per-role counts recorded by the platform into
   `cron_runs`; thresholds and the page stay in the responder), so the
   read-only `cron_runs` grant is still the responder's only production access.
   See `apps/responder/src/detectors/role-regression.ts`.
5. Actions, one at a time, each behind its own flag and its own bound: runner
   restart, then orphan terminalization, then release rollback last — it is the
   most powerful and the easiest to get wrong.
