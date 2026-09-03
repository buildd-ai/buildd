# Cron Wake Windows and Redis-Gated Ticks

**Status:** Accepted
**Related:** `cron-manifest.json`, `apps/web/src/lib/cron-due-queue.ts`, `apps/web/src/lib/redis.ts`, `apps/web/src/lib/cron-cadence.ts`, `docs/specs/external-cron-triggers.md`

## Problem

`/api/cron/release-health-check` ran `*/2 * * * *` and issued two unconditional
`SELECT`s per tick. Neon's compute autosuspends after a few idle minutes, so
that one job kept the database awake around the clock to ask a question whose
answer is almost always "nothing to do" — while every other job in the manifest
carries a comment explaining that sub-hourly DB work is exactly what not to do.

Fixing it by lowering the cadence is not free. `WATCH_WINDOW_MINUTES = 30` was
hand-typed in the route: at hourly it becomes narrower than the poll interval,
so a release turning `healthy` at :10 would be outside the window by the next
:05 tick and never probed at all. Same shape as the credential sweep's
10-minute lookahead on a 4-hourly cron that `lib/cron-cadence.ts` exists to
prevent.

Two costs were also being conflated. A live runner already heartbeats hourly
(`RUNNER_POLL_MIN`, default 60), and nine jobs fire at `:00`, so the database is
woken ~24-48x/day regardless. The marginal cost of an hourly job is near zero;
the cost is in ticks that land *between* wake windows and in anything sub-hourly.

## Proposal

Separate the two levers, because they pay for different things.

**Lever 1 — cluster the offsets (config only).** Ticks a few minutes apart ride
one wake window; ticks 20 minutes apart open their own. Offsets chosen purely
to avoid collision (`:20`, `:40`) were paying for that spacing in idle compute,
and every route caps at 60s, so minutes are enough. Moved to `:10` / `:15`, and
`release-health-check` to `:05` rather than `:50`.

**Lever 2 — gate sub-hourly ticks on Redis.** One sorted set per job,
`buildd:due:<job>`, score = epoch-ms at which a row becomes actionable, written
by whichever path already knows the due time (it is inside a DB write anyway).
The tick reads `ZCOUNT key -inf now`: zero means return without touching
Postgres. This buys *latency*, not savings — it lets a job that should be
checked every few minutes do so without adding wake windows.

**Crux:** the gate must never be the only thing that decides whether work
exists. Every gated job keeps its original unconditional schedule as a floor
tick, and the floor tick re-seeds the set from the table. If that is wrong — if
a floor tick is dropped or the reseed is skipped — a lost `ZADD` silently
retires the job while its logs stay green, which is the failure this repo keeps
paying for (a fire-and-forget verification that no-op'd left releases stuck in
`deploying` for days; a missed `pull_request` webhook starves dependents).
Corollaries: `countDue` returns `null` rather than `0` when Redis cannot answer,
and `null` fails open to the query; and every tick logs one `cron_gate` line so
the fast path is auditable in production.

## Implementation sketch

1. `lib/redis.ts` — `markDue` / `clearDue` / `countDue` / `reseedDue`, plus
   `isRedisConfigured`. `countDue` is the load-bearing one: `null` on
   unavailable, never `0`.
2. `lib/cron-due-queue.ts` — `decideDueGate` (pure), `gateOnDueQueue`,
   `logDueGate`. A tick with no `?gate=due` param is a floor tick, so existing
   manifest entries behave exactly as before.
3. Pilot: `lease-expiry-guard`. The lease TTL is 5 minutes and the broker renews
   every 60s, so hourly detection was 12x coarser than the state it watches.
   `/api/runner/credential-lease` publishes the expiry on acquire/heartbeat and
   clears it on release; a second manifest entry runs `?gate=due` at `*/5`.
4. Then, in payoff order: `pr-reconcile?scope=merge-state` (stale `merged_at`
   starves dependent tasks; publish on PR open, clear when the merge webhook
   lands), `codex-token-refresh` (just-in-time refresh at `tokenExpiresAt` minus
   margin instead of somewhere in a 5-hour window), `stall-notify` (staged dark
   at `*/5`; the gate is what makes that cadence affordable).

## Non-goals

- Minute-granularity production alerting. External uptime monitoring polls from
  outside and never touches the database; `release-health-check` accepts <=~1h
  detection of post-deploy degradation in exchange.
- Gating the `schedules` tick. `MIN(nextRunAt)` looks like the ideal watermark,
  but that route also runs the health watcher, heartbeat prepass, mission
  archive and completion passes, all of which query every tick regardless.
- Weekly/daily/4-hourly housekeeping (`task-archive`, `pr-reconcile` full,
  `jwks-rotation`, `routing-calibration`, `feedback-digest`) — a handful of
  wakes per week each.
- Moving cron state out of Postgres. Redis holds a derived index that any floor
  tick can rebuild; it is never the source of truth.

## Open questions

- **Should the gated tick run overnight?** Leaning yes, and shipped that way:
  `*/5 * * * *` all 24 hours, because a lease expires whenever a runner dies and
  the gated tick costs nothing while idle. The daytime-only convention in this
  manifest exists for jobs that page a human or create work.
- **Per-job floor interval.** Currently each gated job inherits its existing
  schedule as the floor (hourly, daytime for the lease guard). If reseed drift
  turns out to be common, the floor should move to all-hours before the gated
  cadence gets any tighter. Leaning on evidence from the `cron_gate` logs rather
  than guessing now.
