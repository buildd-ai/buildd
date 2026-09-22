# Platform detectors: file a task from an aggregate, never from a log line

**Status:** Proposed
**Related:**
`apps/web/src/app/api/cron/mission-invariants/route.ts`,
`apps/web/src/lib/mission-invariants.ts`,
`apps/web/src/lib/mission-invariant-scan.ts`,
`apps/web/src/app/api/cron/queue-stall/route.ts`,
`packages/core/signal-registry.ts`,
`scripts/signal-fire-coverage.test.ts`,
`packages/core/error-signature.ts`,
`packages/core/terminal-records.ts`,
`packages/core/gate-events.ts`,
`packages/core/gate-analytics.ts`,
`apps/web/src/app/api/workers/heartbeat/route.ts`,
`apps/web/src/app/api/runner/credential-refresh/route.ts`,
`apps/runner/src/buildd.ts`,
`apps/runner/src/doctor.ts`,
`apps/web/src/lib/stale-workers.ts`,
`cron-manifest.json`,
`docs/design/DESIGN-FORMAT.md`

---

## Problem

Platform defects are found today by a human reading runner stdout. A recent
multi-week audit of one fleet found a set of real, shipped defects that way —
and the way they were found is the problem, because none of them were reachable
from a line-matching rule:

- **Volume makes line-triggered filing impossible.** A single `console.error`
  accounted for a large share of all error events in the window; one
  provisioning bug emitted several error lines per occurrence; a self-heal
  no-op emitted the same pair of lines dozens of times a day; a benign stderr
  leak was, by itself, one of the largest line sources in the log. Filing one
  task per matching line would have produced thousands of tasks for a handful
  of distinct bugs.
- **The real findings were relations, not lines.** Credential refresh locks
  being taken continuously against *zero* successful commits. An observed
  maximum heartbeat gap more than an order of magnitude below the threshold
  that was supposed to alert on it. One rejection counter sitting at a fixed
  multiple of another, every single day. A capability lookup with a **0% hit
  rate** across every lookup in the window. No grep can express any of these:
  each one is a comparison between two quantities over a window, and three of
  the four are about something that *did not happen*.
- **A watcher inside the runner dies with the thing it watches.** The audit's
  most expensive findings were on hosts whose own logging had already degraded.

The pattern that solves this already exists and is proven in this repo.
`POST /api/cron/mission-invariants` evaluates named invariants on a schedule,
computes a stable signature, dedupes against open tasks on
`context->>'frictionSignature'`, and inserts a `[friction] …` task;
`POST /api/cron/queue-stall` is the notify-only variant with a 24h renotify
window (`RENOTIFY_HOURS`). There are over a dozen routes in this family. What is
missing is not a mechanism. It is a **detector family for platform and runner
health**, and one input the mechanism cannot currently see.

## Current state

**What already works.** `evaluateInvariants` in
`apps/web/src/lib/mission-invariants.ts` is pure — a snapshot in, violations
out — so every predicate is unit-testable against both a violating state and
the adjacent healthy one. The route is trigger, transport and dedupe only, wrapped
in `withCronRun`. `packages/core/signal-registry.ts` already establishes the
convention this design has to inherit: *a signal without a test proving it can
FIRE is not a signal*, enforced bidirectionally by
`scripts/signal-fire-coverage.test.ts` against `git ls-files`.

**What is already data, contrary to the framing this design started from.**

- Per-session terminal records already exist and are already written on all
  four session shapes — `workerTerminalRecords` in `packages/core/db/schema.ts`,
  written via `fireTerminalRecord` from `POST /api/workers/[id]` for
  `completed`, `failed`, `refused` (output-requirement gate) and `crashed`
  (runner-side reconciliation). The orphan detector below needs no shim; it can
  read this table today.
- Credential refresh already records both halves of the relation in Postgres.
  `POST /api/runner/credential-refresh` action `lock` stamps
  `secrets.refreshLockedAt` and never touches `lastRefreshedAt`; action `commit`
  is the **only** writer of `lastRefreshedAt`. Lock-without-commit is therefore
  a plain SQL question, not a log question.

**The genuine gap: runner-process counters.** Two conditions in the audit
belong to the runner *process*, not to any worker session — the rate of claim
requests it issues, and how many times its self-heal loop applies the same fix
for a check that keeps failing. Neither has a row anywhere. The transport for
fixing that is half-built: `apps/runner/src/buildd.ts` already POSTs
`redactionCounts` — an aggregate count map, not lines — in the 30s heartbeat
body, and `apps/web/src/app/api/workers/heartbeat/route.ts` does not destructure
it, does not persist it, and drops it on the floor.

**Two defects this design surfaced and depends on.**

1. `apps/web/src/lib/stale-workers.ts` reaps stale workers by writing a terminal
   status directly, bypassing `fireTerminalRecord`. Every reaped session is
   therefore indistinguishable from a genuinely invisible one. Detector 2 below
   measures "the reaper ran" instead of "sessions went dark" until this is
   closed.
2. The test suite writes into the production worker store, so a meaningful
   share of `error`-status worker records are fixtures rather than real
   failures. Any detector reading worker state files tickets about test data
   until the in-flight runner-state-hygiene fix lands.

Both are named as hard prerequisites, in code, below — not as comments.

## Proposal

### The unit of detection

A finding is a **(detector, subject, window)** triple, never a line. The subject
is the row or entity a reader opens — a credential, a workspace, a runner, a
registry slug. The window is declared on the detector. This is the same unit
`InvariantViolation` already uses (`entityId` + `entityKind` + `detail` +
`ageMs`), extended with the evidence a corroboration rule needs.

### The crux

**A detector reads a bounded time series of named counters, not only current
state.** Three of the five starter detectors are pure current-state Postgres
queries and need nothing new. Two are not: a claim burst and a repeated
ineffective self-heal exist only as *rates on a host whose own state resets*,
and Postgres has never seen either. So the design turns on introducing a small,
durable, closed-vocabulary counter series.

If that is wrong — if the series is too expensive, too coarse, or its retention
too short to compute a rate — then the burst and repetition kinds are
unimplementable and this ships as three current-state detectors. That is still
useful and still strictly better than a tailer, but it is a materially smaller
win than the audit says is available, and it would mean every future
runner-process condition stays invisible for the same reason this one is.

### Two input families, one evaluator

| Family | Source | Used by |
|---|---|---|
| **Relational** | Postgres rows read at evaluation time | refresh starvation, orphaned sessions, unreachable threshold |
| **Counter** | `runner_counters` rows shipped by the on-box reporter | claim burst, ineffective self-heal |

Both arrive as one `DetectorSnapshot`. Predicates never issue queries — same
split as `mission-invariants.ts` (pure) / `mission-invariant-scan.ts` (reads),
so every predicate is testable against a constructed snapshot.

### The counter reporter

On-box, emit-only. It never reads, never decides, never alerts, and never
blocks the thing it measures.

```ts
// packages/core/platform-counters.ts — shared vocabulary, both sides import it
export const PLATFORM_COUNTERS = [
  'claim.request',
  'doctor.check.error',
  'doctor.autofix.applied',
  'credential.refresh.lock',
  'credential.refresh.commit',
] as const;
export type PlatformCounter = (typeof PLATFORM_COUNTERS)[number];

export interface CounterBucket {
  metric: PlatformCounter;
  /** Optional second dimension. When present, MUST be normalizeErrorSignature() output. */
  signature: string | null;
  count: number;
  windowStartAt: string; // runner clock
  windowEndAt: string;
}
```

Rules, each load-bearing:

- **Closed metric vocabulary.** The server rejects an unknown metric (recording
  a `gate_event`, never 400-ing the heartbeat — a counter must not be able to
  break liveness). An open namespace is how a counter table becomes a log.
- **The signature dimension uses `normalizeErrorSignature` from
  `packages/core/error-signature.ts`** — the same normalizer `gate_events.reason`
  and `get_failure_analytics` use. One failure family is one signature
  everywhere. But most counters are not errors (`claim.request` has no message),
  so `signature` is optional and the *metric* carries the meaning. This is the
  honest version of "don't fork the taxonomy": share the vocabulary where the
  vocabulary applies, and use a closed enum where it does not.
- **Cardinality bound.** At most `MAX_SIGNATURES_PER_METRIC` (20) distinct
  signatures per metric per flush; the rest fold into a single `(other)` bucket
  with its own count. Nothing an agent or a provider can emit may grow this
  table without bound.
- **Transport: the existing 30s heartbeat.** Generalise the `redactionCounts`
  field the runner already sends into `counters: CounterBucket[]`, and make the
  route persist it. No second endpoint, no second auth path, no second retry
  policy.
- **Buffer, drain, never lose silently.** `bump(metric, n, signature?)` is a
  synchronous in-memory `Map` increment that cannot throw. Buckets drain on a
  successful heartbeat POST and reset; a failed POST keeps accumulating. Each
  bucket carries its own `windowStartAt`/`windowEndAt` from the runner clock, so
  a delayed flush widens one bucket rather than corrupting a rate. The server
  also stores `receivedAt`, so clock skew is visible instead of assumed. Past
  `MAX_BUFFERED_BUCKETS` the buffer collapses to one bucket flagged `lossy`,
  which is itself reportable.
- **A dead reporter is detectable.** A runner heartbeating with zero counter
  rows over a window is a finding, not silence — the reporter's own absence
  detector. A runner not heartbeating at all is an existing signal.

Storage is one new table, `runner_counters`
(`accountId`, `runnerKey`, `metric`, `signature`, `count`, `windowStartAt`,
`windowEndAt`, `receivedAt`), indexed on `(metric, windowStartAt)` and
`(accountId, windowStartAt)`. **Retention is what keeps this from being a log:**
30 days raw, swept by the detector cron itself.

### The detector record

Deliberately shaped like `Invariant`, with the differences that matter:

```ts
export interface Detector {
  /** Stable — it is half the dedupe signature. Never rename one. */
  slug: string;
  title: string;
  kind: DetectorKind;              // 'absence' | 'ratio' | 'burst' | 'repetition' | 'meta'
  windowMs: number;
  /** What must be true before a finding may FILE rather than merely report. */
  corroboration: Corroboration;
  /** One line, written for whoever opens the task. */
  remedy: string;
  /** Ships false for every detector. Promotion is a later diff, one at a time. */
  files: boolean;
  /**
   * A precondition in the codebase that must be fixed before this may be
   * promoted. Checked by the registry test, not by a comment.
   */
  blockedBy?: { reason: string; trackedBy: string };
  /** Pure: snapshot in, findings out. Never queries, never calls a model. */
  evaluate: (snapshot: DetectorSnapshot, now: Date) => DetectorFinding[];
  /** MANDATORY. There is no `noLocalFireTest` escape here — see below. */
  fireTest: SignalFireTest;
}

export interface DetectorFinding {
  subjectKind: 'credential' | 'workspace' | 'runner' | 'signal';
  subjectId: string;
  workspaceId: string | null;
  /** One line of evidence about THIS subject — never prose about the detector. */
  detail: string;
  /** Distinct witnesses backing the finding. The corroboration check is data, not a promise. */
  witnesses: string[];
  firstObservedAt: Date;
  /** The numbers that tripped it, stamped onto the filed task for the precision audit. */
  observed: Record<string, number>;
}
```

`fireTest` reuses `SignalFireTest` from `packages/core/signal-registry.ts`
verbatim, and fire-tests carry the existing `@signal-fire: <slug>` marker built
by `formatSignalFireMarker`. The registry entry there allows `noLocalFireTest`
because a signal can live in another repo. **A detector cannot**: it is defined
here, evaluated here, and takes a constructed snapshot, so "untestable from this
repo" is not a reachable state. `fireTest` is required, unconditionally.

`scripts/signal-fire-coverage.test.ts` extends to the **union** of
`SIGNAL_REGISTRY` and `DETECTOR_REGISTRY`, and additionally asserts slug
uniqueness across both. One marker namespace with two registries and no
uniqueness check is how a marker silently satisfies the wrong entry.

### Absence is a first-class kind

`kind: 'absence'` exists because the highest-value findings in the audit were
all *absences* — a counter that should have been non-zero and was zero — and an
absence is precisely what a line matcher can never see. The framework gives the
kind real behaviour rather than treating it as documentation:

- An absence detector declares **both** sides: the observable that must be
  non-zero (the *trigger*) and the observable that is zero (the *expectation*).
  Firing requires trigger > 0 — "nothing happened because nothing was asked"
  is healthy, and is the exact shape of a green-over-empty-set signal.
- Every run, the report names **every** detector and prints `EMPTY INPUT` when
  its snapshot slice had no rows at all, borrowing `formatInvariantReport`'s
  discipline. A detector silent because its query matched nothing must not look
  like a detector silent because the fleet is healthy.

### Corroboration before filing

```ts
export interface Corroboration {
  kind: 'distinct-workers' | 'distinct-runners' | 'distinct-days' | 'distinct-buckets';
  min: number;
  /** Optional floor on the span between first and last witness. */
  minSpanMs?: number;
}
```

Enforced centrally: a finding whose `witnesses.length < min` (or whose witness
span is under `minSpanMs`) is **reported and never filed**. This is the
one-off-burst suppressor. Witnesses are derived from the same rows the predicate
read — the counter table *is* the series, and the relational detectors derive
age from their own columns — so no first-seen side-store is needed and there is
no stale key that can keep a resolved finding filing forever.

`distinct-buckets` is an extension of the "two distinct workers or days" rule.
For a burst on a single host, two distinct workers is not a meaningful
requirement and two distinct days is far too slow for a loop burning requests
right now. Two independent time buckets is the same idea — two separate
observations, not one blip — at the granularity the condition actually has. This
is the only place the rule was widened; it is flagged in Open questions.

### Dedupe

Identical to the proven path, and for the same reason:

```
context.frictionSignature = `detector:${slug}:${subjectId}`
```

mirroring `invariantFrictionSignature`'s `mission-invariant:${key}:${entityId}`.
The cron inserts directly against `tasks` with the same predicate the invariant
route uses (`title LIKE '[friction] %'`, `status NOT IN` the closed set,
`context->>'frictionSignature' = $sig`) — appending to the open task on a hit,
inserting on a miss — rather than calling back into `POST /api/tasks`. Two
reasons: a cron function must not self-request, and the task route's friction
path normalises free-form signatures through its own extractor, which would
rewrite a key that is already stable by construction.

**Bounds on filing:** `MAX_FILINGS_PER_RUN` (5) per run, as in the invariant
route — a detector that suddenly matches a hundred subjects is a bug in the
detector, not a hundred incidents. Pushover fires only on a *newly created*
task, never on an append.

### Precision tracking, and auto-disable

Every filed task carries, alongside the signature:

```
context.detectorSlug, context.detectorWindowMs,
context.detectorObserved,  // the numbers that tripped it
context.detectorFiledAt
```

The verdict is **derived from existing terminal state**, with no new label for
anyone to forget to set:

| Verdict | Derivation |
|---|---|
| `confirmed` | task reached `completed` **and** a worker on it has non-null `workers.mergedAt` — a fix merged |
| `noise` | task reached `cancelled`, or `completed` with `discardEdits` recorded on its result |
| `unresolved` | anything else — excluded from the ratio entirely |

`precision = confirmed / (confirmed + noise)`, over resolved filings in the
trailing 30 days. This mirrors `bypassRatePct` in
`packages/core/gate-analytics.ts`: bypass rate over a lint *is* its
false-positive rate, and the same trick works here.

**Auto-disable, with its bound stated.** A detector with at least
`MIN_RESOLVED_FOR_VERDICT` (5) resolved filings and precision below
`AUTO_DISABLE_PRECISION` (0.25) has filing switched off — a `system_cache` row
keyed `detector:disabled:<slug>` — and files exactly one meta friction task
naming itself, deduped on its own signature. The safety properties:

- The override can only ever turn filing **off**. Filing requires `files: true`
  in code **and** no disable row. Nothing in this system can switch a detector
  on.
- At most one meta task per detector, ever, until it is resolved.
- There is **no timeout that re-enables**. Re-enabling is a human diff that has
  to change the predicate or the threshold, because "it got quiet on its own"
  was never evidence that it got correct.

### Defaults are no-ops

Every detector ships `files: false`. Merging the whole framework changes nothing
a user sees: one more hourly cron that writes a report, one new table, and a
counter map that was already being sent and thrown away. Promotion to
`files: true` is a later diff, one detector at a time, and the bar is the one
the invariant sweep already set: **observed to fire on a real breach AND to stay
quiet on a healthy fleet.**

---

## The five starter detectors

### 1. `refresh-starvation` — kind `absence`

- **Window** 24h. **Source** relational (`secrets`).
- **Trigger (must be non-zero)** `refreshLockedAt > now - 24h` — locks are being
  taken. **Expectation (is zero)** no commit: `lastRefreshedAt IS NULL OR
  lastRefreshedAt < refreshLockedAt`.
- **Excluded** `healthStatus = 'revoked'`. That state is terminal and the lock
  path already notifies the team once on transition; re-reporting is duplicate
  paging, not a second finding.
- **Note on the walk-back**: action `release` rewinds `refreshLockedAt` to
  `NOW() - 45 minutes`, which keeps a network-blipped runner inside the window.
  That is correct — a runner that can never reach the provider *is* starving.
- **Subject** the credential row. **Corroboration** `distinct-days`, min 2,
  derived from the gap between `lastRefreshedAt` and `refreshLockedAt`.
- **Would have caught** continuous locking against zero commits, silent for the
  whole audit window.
- **Remedy** "Refresh locks are being taken and never committed. `lock` stamps
  `refreshLockedAt`; only `commit` stamps `lastRefreshedAt`. Find where the
  rotation dies between the two."

### 2. `orphaned-sessions` — kind `ratio`

- **Window** 24h. **Source** relational (`workers` × `workerTerminalRecords`).
- **Predicate** per workspace: `started` = workers with `startedAt` in the
  window that have since reached a terminal status; `recorded` = distinct
  `workerTerminalRecords.workerId` among them. Fire when
  `started >= MIN_SESSIONS` (20) and `(started - recorded) / started > 0.10`.
- **The floor is load-bearing in the opposite direction from usual.** A ratio
  over three sessions is not a rate; without `MIN_SESSIONS` this detector is
  *red* over a near-empty set, which is the same defect as green over an empty
  set wearing the other colour.
- **Subject** the workspace. **Witnesses** the orphaned worker ids.
  **Corroboration** `distinct-workers`, min 2 (implied by the floor, enforced
  uniformly anyway).
- **`blockedBy`** — two entries, both mandatory before promotion:
  the stale-worker reaper must route through `fireTerminalRecord` (otherwise
  this measures reaper activity), and the test-suite-writes-to-prod-worker-store
  fix must land (otherwise this files tickets about fixtures).
- **Would have caught** the invisible cohort of sessions that ended without any
  terminal signal — a significant minority of all sessions in the window.

### 3. `claim-burst` — kind `burst`

- **Window** 60m, evaluated over 5-minute buckets. **Source** counter
  (`claim.request`, bumped at the single `/api/workers/claim` call site in
  `apps/runner/src/buildd.ts`).
- **Predicate** any 5-minute bucket for one runner with `count > 100`.
- **Why 100.** The runner's claim cadence is a poll plus Pusher wakes, and the
  measured p50 claim interval across the fleet is minutes, so a healthy
  5-minute bucket is single digits. 100 is an order of magnitude above healthy —
  derived from the measured cadence, not picked. The wake loop in the audit was
  well past it.
- **Subject** the runner. **Corroboration** `distinct-buckets`, min 2, within
  the hour.
- **Would have caught** a wake loop that issued more claim requests in five
  minutes than a healthy runner issues in a day.

### 4. `ineffective-self-heal` — kind `repetition`

- **Window** 24h. **Source** counter (`doctor.autofix.applied` and
  `doctor.check.error`, both dimensioned by check name — a closed set, the keys
  of the `fixMap` that `autoFix` in `apps/runner/src/doctor.ts` dispatches
  through).
- **Predicate** for one runner and one check name:
  `doctor.autofix.applied >= 20` over the window **and** the check was still
  `error`/`warn` on the most recent cycle. Fix reported successful; condition
  still there.
- **Why 20.** A handful of legitimate re-fixes a day is normal maintenance — a
  worktree genuinely re-accumulates. Twenty applications of the same fix for the
  same still-failing check in one day is a loop.
- **Subject** runner + check name. **Corroboration** `distinct-buckets`, min 2,
  `minSpanMs` 6h — so one bad hour cannot file.
- **Would have caught** hundreds of identical no-op detect-fix cycles.

### 5. `unreachable-threshold` — kind `meta`

- **Window** 30d. **Source** `SIGNAL_REGISTRY` × observed series.
- **Requires a machine-readable threshold.** `SignalRegistryEntry.threshold` is
  prose today, which is right for a human and useless to a comparison. Add an
  optional field:

  ```ts
  measured?: { value: number; unit: 'ms' | 'count' | 'ratio'; series: SeriesRef };
  ```

  where `SeriesRef` names either a counter metric or one of a small closed set
  of DB-derived series accessors.
- **Predicate** for each entry declaring `measured`: fire when
  `value > 5 * p99(series, 30d)` — the threshold cannot plausibly be reached —
  or when the series is **empty over the entire window**, which is the
  green-over-empty-set case and is reported as `no-observations`.
- **Entries with no `measured` are listed as `unverifiable` in every report,
  never skipped.** That list is itself the finding: a threshold nobody can
  check is a threshold nobody should trust. It is the honest successor to the
  prose field, not a replacement for it.
- **Excluded** entries carrying `noLocalFireTest` — those are already tracked
  elsewhere and would double-report.
- **Subject** the registry slug. **Corroboration** `distinct-days`, min 2.
- **Would have caught** the heartbeat alert threshold sitting more than an order
  of magnitude above the largest gap ever observed.

---

## Implementation sketch

Ordered; the load-bearing piece first.

1. **`packages/core/platform-counters.ts`** — the closed vocabulary, the bucket
   type, the cardinality cap. Add `"./platform-counters"` to the `exports` map
   in `packages/core/package.json`: a new top-level core module without an
   explicit entry fails to resolve for every importer even though the file
   exists.
2. **Migration for `runner_counters`.** `cd packages/core && bun db:generate`,
   commit the generated SQL. Read `.claude/skills/schema-change/` first —
   migration index collisions between concurrent sessions are routine and git
   does not conflict on the `.sql` files.
3. **Server: accept and persist `counters[]`** on
   `POST /api/workers/heartbeat`, generalising the `redactionCounts` field the
   runner already sends and the route currently discards. Unknown metric →
   `gate_event`, not a 400.
4. **Runner: `bump()` call sites.** The claim POST in `buildd.ts`; `autoFix` and
   the check statuses in `doctor.ts`. Synchronous, non-throwing, emit-only.
5. **`apps/web/src/lib/platform-detectors.ts`** — `DETECTOR_REGISTRY` and
   `evaluateDetectors`, pure, mirroring `mission-invariants.ts`. No DB, no
   network, no model call on this path, ever.
6. **`apps/web/src/lib/platform-detector-scan.ts`** — the snapshot loader,
   mirroring `mission-invariant-scan.ts`.
7. **`apps/web/src/app/api/cron/platform-detectors/route.ts`** — trigger,
   transport, dedupe, wrapped in `withCronRun`. Register it **exactly once** in
   `cron-manifest.json`; `scripts/cron-coverage.test.ts` fails on a route with
   no trigger or a doubled one, and `scripts/cron-instrumentation.test.ts` fails
   on an uninstrumented route. Check whether
   `docs/specs/external-cron-triggers.md` needs a line too.
8. **Fire tests**, one per detector, marked `@signal-fire: <slug>`, plus the
   adjacent-healthy case; extend `scripts/signal-fire-coverage.test.ts` to the
   union of both registries with a cross-registry slug-uniqueness assertion.
   TDD: the fire test is written before the predicate, and must be observed to
   fail when the predicate is stubbed out.
9. **Precision rollup and auto-disable**, last — it is meaningless until filings
   exist, and shipping it early risks disabling a detector on an empty sample.

Prerequisites that are not part of this diff but gate promotion:
route `stale-workers.ts` through `fireTerminalRecord`, and land the runner
test-isolation fix. Both are expressed as `blockedBy` on detector 2, so the
registry test enforces them rather than a comment asking nicely.

## Open questions

1. **Where does a finding with no workspace file?** A team-wide credential
   (`secrets.workspaceId IS NULL`) has no workspace, and the invariant route
   simply skips such violations. *Lean:* route to the team's oldest active
   workspace and record `routedVia` on the finding so the choice is auditable.
   Report-only until decided — which costs nothing, since detector 1 ships
   `files: false` regardless.
2. **Burst corroboration.** I extended "two distinct workers or days" to
   `distinct-buckets` for detector 3, on the reasoning above. *Lean:* keep it —
   the alternative makes the detector either meaningless (one host) or a day
   late. Say so if you would rather it waited for a second runner.
3. **Counter retention.** 30 days raw serves every starter detector, but the
   meta detector's p99 would be sturdier with more history and the table is
   healthier with less. *Lean:* 30 days raw plus a nightly daily-rollup row kept
   a year, as its own follow-up diff rather than day one.
4. **Cadence.** Hourly, matching the invariant sweep, means a claim burst is
   filed up to an hour after it ends. *Lean:* hourly anyway. The value of the
   burst detector is the ticket with the evidence attached, not a page — and a
   second cron cadence for one detector buys minutes at the cost of a second
   thing to keep registered and instrumented.

## Non-goals

- **No log tailing, line shipping, or stdout ingestion**, now or later. The
  on-box side emits counters and nothing else. This is the point of the design,
  not an omission from it.
- **Not a replacement for `mission-invariants`.** Different subject — platform
  and runner health versus mission state — same primitive, same dedupe
  convention, deliberately the same shapes so a reader of one can read the
  other.
- **Not the per-session terminal record.** That already exists and is already
  written on all four session shapes; the counter reporter must not duplicate
  it, and detector 2 reads it directly.
- **Not alerting or paging policy.** The output is a filed task. Pushover fires
  only on a newly created one, exactly as the invariant route already does.
- **No dashboard and no new UI surface.** The consumer is a task-filing agent
  and the cron response body.
- **Not the implementation.** This doc ends at an agreed design.
