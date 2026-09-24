# `@buildd/responder` — autonomous incident responder, observe-only

A small daemon whose defining property is that **it does not depend on the
system it watches.** It detects three conditions, records evidence, and pages.
It takes no action of any kind.

Design: `docs/design/autonomous-incident-responder.md` (items 3 and 4 of the
implementation sketch).

## Why it exists

A dispatch outage ran most of a night. The queue was non-empty, the runner was
heartbeating, and nothing started. **The detector already existed and was right
on every hourly run** — `queue-stall?scope=fleet-idle` — and it had no
notification path: that branch computes its result, passes it to `report(...)`,
and returns JSON. The only `notify(` in the file is in the sibling branch.

Worse, the cron health check in `apps/web/src/lib/cron-run.ts` judges a job
partly on its `changed` counter, and for a *detector* job that counter means
*problems found*. So finding a problem every hour read as maximally healthy
work to the only supervisor watching. The outage was found by a human opening a
terminal.

And nothing would have acted on the page anyway, because buildd's remediation
loop runs on buildd: work lives in the production database and dispatch goes
through `POST /api/workers/claim`. When dispatch is what broke, the platform
cannot dispatch its own repair.

This app is the outside observer that closes the first gap. It is not the
second phase — it does not repair anything.

## What it does, exactly

| Detector | Reads | Fires when |
|---|---|---|
| `dispatch-stall` | `cron_runs` rows for `queue-stall:fleet-idle` (read-only) | 2 consecutive hourly runs each report a non-zero alarm count |
| `claim-error-rate` | Its own non-claiming probe of `POST /api/workers/claim` | 3 or more 5xx/unreachable responses within 60 minutes |
| `role-regression` | `cron_runs` rows for `role-outcomes` (read-only) | One role: >= 4 recent outcomes, <= 20% succeeded in the last hour, one error signature >= 60% of those failures, against >= 70% success over the prior 24h (n >= 10) |

The first two thresholds are derived from observed cadence, not chosen; the
role-regression defaults are argued in its module header and are overridable.
All are asserted by tests.

### Role regression after a change

Built after a runner release took one role from all-succeeding to
all-failing on one identical error, under the generic exit cause, and nobody
was paged for most of a working day. A trickle of one role's failures is
invisible in any fleet-wide failure view; against that role's own yesterday it
is a cliff.

The platform aggregates, the responder judges. `GET /api/cron/role-outcomes`
(hourly, all 24 hours) records per-role counts for the last hour and the prior
24h into `cron_runs`, excluding failures that say nothing about the role's work
(budget/usage, auth, never-started, server refusals, bookkeeping exits), plus
the runner builds on live heartbeats and the web deploy sha. Contract:
`packages/core/role-outcomes-feed.ts`. So the feed role still needs `SELECT`
on `cron_runs` and nothing else.

The page names the role, recent vs baseline success, the dominant signature
(the same normalization `get_failure_analytics` uses, so it can be pasted
straight into `error=`), when it began, and the key line — *"Started 20–80 min
after runner build X (changed from Y between T0 and T1)"*, bracketed by the two
hourly feed rows around the change, because that is the resolution the data
honestly has. A change that postdates the onset is reported as not the cause.

`warming` (silent) when the shape is there but the role has fewer than the
baseline minimum outcomes in the prior day: there is no "before" to regress
from.

Every verdict is one of four states. `clear` and `firing` are the obvious two.
`blind` means *the input this detector needs is missing or stale when it should
be present* — it pages, under its own condition key, because a monitor that
cannot see has to say so. `warming` means *not enough history yet, and not
enough time has passed for that to be surprising* — silent and self-clearing.

## The claim probe cannot claim

This is the part to read before changing anything.

The probe sends an **authenticated request the claim route is required to
refuse**: a body of exactly `{}`. The route destructures `runner` from the
body, and when it is absent returns `400`, *before* any task selection and
before any `claimedBy` assignment. So the request exercises TLS, routing,
`authenticateApiKey` (a real database read) and handler execution — and cannot
claim, because claiming needs a `runner` and there is none to have.

**4xx is the healthy outcome. 5xx is the unhealthy one. A 2xx is a defect** —
it means the route accepted a request it must refuse, so the probe may have
claimed real work; the detector goes `blind` and the page says to look for a
worker row with no start time.

This matters because it already went wrong once. During the triage of the
outage above, an operator POSTed a hand-written body with an invented runner
name to the live endpoint to see whether it was up. It answered 200, claimed a
real task, and left a worker row bound to a runner that would never attach —
blocking that task until someone fixed it by hand.

`src/probes/claim-probe.test.ts` therefore asserts the property against the
route's own source (that the guard still precedes the claim commit), and is
registered in `scripts/always-run-tests.txt` because a diff to the claim route
selects the test *beside that route* and never this one.

## Configuration

No default points at production. Every address is explicit.

| Variable | Required | Meaning |
|---|---|---|
| `BUILDD_RESPONDER_APP_URL` | yes | Base URL of the platform to probe |
| `BUILDD_RESPONDER_API_KEY` | yes | Key for the claim probe. Authenticates; cannot claim |
| `PUSHOVER_USER` + `PUSHOVER_TOKEN` (or `PUSHOVER_TOKEN_ALERT`) | yes | Notification path. Startup fails without it |
| `BUILDD_RESPONDER_CRON_RUNS_URL` | for `dispatch-stall`, `role-regression` | **Read-only** Postgres URL. Without it those detectors report `blind` |
| `BUILDD_RESPONDER_STATE_DIR` | no | Local state. Default `$BUILDD_HOME/responder`, else `~/.buildd/responder` |
| `BUILDD_RESPONDER_RUNNER_URL` | no | Runner's local HTTP base, e.g. `http://127.0.0.1:8766` |
| `BUILDD_RESPONDER_RUNNER_TOKEN` | no | Only if that port is viewer-protected |
| `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | no | Optional narrative. Absence costs prose, never a page |
| `BUILDD_RESPONDER_INTERVAL_SECONDS` | no | Default 60 |
| `BUILDD_RESPONDER_RENOTIFY_HOURS` | no | Default 24, matching `queue-stall`'s `RENOTIFY_HOURS` |
| `BUILDD_RESPONDER_SAMPLE_RETENTION_HOURS` | no | Default 6 |
| `BUILDD_RESPONDER_NARRATIVE_MODEL` | no | Default: the premium tier model (`TIER_DEFAULTS.premium` in `packages/core/model-tier-defaults.ts`) |
| `BUILDD_RESPONDER_NARRATIVE_TIMEOUT_MS` | no | Default 20000 |
| `BUILDD_RESPONDER_ROLE_MIN_RECENT` | no | Default 4 — recent chargeable outcomes before a role is judged |
| `BUILDD_RESPONDER_ROLE_RECENT_FLOOR_PCT` | no | Default 20 — recent success at or below this is failing |
| `BUILDD_RESPONDER_ROLE_BASELINE_BAR_PCT` | no | Default 70 — baseline success must be at least this to call it a regression |
| `BUILDD_RESPONDER_ROLE_BASELINE_MIN` | no | Default 10 — baseline outcomes below this is `warming` |
| `BUILDD_RESPONDER_ROLE_DOMINANT_SHARE_PCT` | no | Default 60 — one signature's share of recent failures |

`DATABASE_URL` is **not** read. The feed has its own variable so the
responder's connection string can be a read-only role, and so inheriting a
shell cannot hand this process write access to production.

Grant the feed role `SELECT` on `cron_runs` and nothing else. The app issues
exactly one statement — a bare `SELECT` — and a test asserts no mutating verb
appears anywhere in it, but a least-privilege role is the enforcement that
does not depend on this codebase staying correct.

The narrative credential is deliberately **whatever the host already has**, not
a responder-specific secret. A separate credential is one more thing to
provision, rotate and forget, and credential rot is a proven outage cause here.
The shared-fate objection is answered by the credential-free detector rule
instead of by a second secret: every detector is evaluable with no model call,
so a dead credential costs the diagnosis paragraph and not the alert.
`src/detectors/index.test.ts` proves that by stripping every credential from
the environment and evaluating every detector.

## Running

```bash
bun install

# one cycle, then exit — for an external scheduler
bun apps/responder/src/index.ts --once

# long-lived, one cycle per interval
bun apps/responder/src/index.ts
```

`--once` is not a debug affordance. It is what lets an external scheduler drive
the responder, which matters because a long-lived process is itself a thing
that can die quietly. Both modes share one cycle, so neither can drift.

Tests: `bun run scripts/run-unit-tests.ts 'apps/responder/src/**'`, or the
whole suite with `bun run test`. Never `bun test`.

## Deployment — guidance, deliberately not wired

**Nothing in this repository deploys the responder.** No workflow, no
Dockerfile, no systemd unit, no cron entry. That is on purpose: a half-wired
deployment is worse than none, because it looks like coverage.

Whoever deploys it has to preserve four properties. Every one of them is the
reason the app exists, so a deployment that breaks one produces a watcher that
fails in precisely the situation it was built for — and gets trusted while
doing so.

1. **Not inside the worker container.** A container rebuild is the failure mode
   actually hit; a watcher that rebuilds with it is not a watcher.
2. **Not on Vercel.** The platform being down must not take the observer with
   it, and a serverless function cannot hold the claim-sample ring that
   `claim-error-rate` needs a denominator from.
3. **Its own lifecycle and its own trigger.** Deploying it must not be
   downstream of the release that might be the thing that broke.
4. **Local, writable state directory that survives restarts.** Losing
   `state.json` loses the renotify windows, so a restart re-pages every live
   condition once. Survivable, but not free.

The design's leaning is a **host-level daemon outside the worker container**: it
survives container rebuilds, and it can observe the runner's local port. It
still shares fate with the host. A separate host removes that and adds a second
thing to maintain — and an unmaintained watcher is the worse outcome.

Whatever runs it, two things are worth doing on day one:

- **Verify it can page.** Run one cycle with no `BUILDD_RESPONDER_CRON_RUNS_URL`
  configured: `dispatch-stall` and `role-regression` report `blind`, which pages. A responder whose
  notification path has never fired is indistinguishable from one that cannot.
- **Verify the feeds exist.** `role-regression` reads a cron job that only
  runs once the external scheduler has it (`bun run cron:sync` after the web
  deploy that adds `/api/cron/role-outcomes`). Until then it reports `blind`
  with reason `no_runs_in_feed` — correct, and a page, not a silence.
- **Verify the evidence log is being written** where you expect, and prune it.
  Files rotate by UTC day (`evidence-YYYY-MM-DD.jsonl`); nothing in this app
  deletes them.

`package.json` carries `version: 0.0.0` and is **not** version-synced by
`scripts/release.sh` (its `PACKAGE_FILES` list does not include this package).
That is deliberate — the responder's releases are not the platform's releases,
which is the same separation property as everything above.

## What is deliberately not here

- **Any action.** No restart, no rollback, no row mutation, and no flag that
  would enable one. Actions are a later phase, each behind its own flag and its
  own bound. Speculative action code is how an observe-only mode becomes an
  acting one by accident.
- **A speculative detector.** Only conditions a real incident justifies. A
  detector with no real failure behind it is a false positive waiting to
  happen, and one false positive is how a whole suite gets muted.
- **Any deployment wiring.** See above.
- **A responder-specific model credential.** See above.
