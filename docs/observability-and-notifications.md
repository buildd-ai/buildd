# Observability & Notifications

How buildd surfaces what's happening — to **us** (platform operators) and to **each customer team**. The two-plane model below is the long-term shape; the **immediate focus is the ops-alerting foundation** — getting errors and warnings to reliably reach the phone (see [Ops alerting design](#ops-alerting-design-the-foundation)).

> buildd currently has **one user**, so "tenant plane" and "ops plane" are the same person today. The split is built now so it's correct when there's a second customer — but the per-client *log streaming* product is explicitly deferred (see Future).

Status: **in transition.** The per-team channel (`notifyTeam`) and the ops channel (`reportOps`) both landed recently but are not yet merged to `dev`:
- PR #911 — per-team Pushover/webhook routing (`notify.ts`, `notification_preferences`)
- PR #910 — `reportOps()` ops alerting + the RQB FROM-clause fix

The legacy lifecycle calls on the global channel have been removed (see Migration); tenant events fire on the per-team channel only.

---

## The two planes

Everything below is one of two kinds of signal. Keep them separate — they have different recipients, different credentials, and different failure modes.

| | **Ops plane** (server) | **Tenant plane** (client) |
|---|---|---|
| Question it answers | "Are *our* systems healthy?" | "What's happening with *my* tasks?" |
| Recipient | buildd team (one inbox) | the customer team that owns the task |
| Credentials | env `PUSHOVER_*` (buildd's own app) | per-team, encrypted in `secrets` |
| Code | `notifyOperator()` (`pushover.ts`), `reportOps()` (`report-ops.ts`) | `notifyTeam()` / `notifyTeamOf()` (`notify.ts`) |
| Toggle | `OPS_ALERTS_ENABLED` (for `reportOps`) | per-team `notification_preferences` |
| Rule | **never** carries tenant-specific task content to a shared inbox once migration completes | **never** sends through buildd's app — each team brings its own token |

Plus an orthogonal **diagnostic plane** (error traces + runner logs + realtime Pusher) that feeds the dashboard, not a phone.

---

## Ops plane (server → buildd team)

buildd's own Pushover account. Two apps via env:

```
PUSHOVER_USER         — buildd owner user key
PUSHOVER_TOKEN_TASK   — "tasks" app  (operational events)
PUSHOVER_TOKEN_ALERT  — "alerts" app (failures/warnings)
PUSHOVER_TOKEN        — fallback if a per-app token is unset
```

### 1. `notifyOperator()` — `apps/web/src/lib/pushover.ts`
Fire-and-forget env-based send, for platform-health alerts only. Every call
site is pinned, with its reason, in `lib/notify-routing-invariant.test.ts`; a
new one fails that test until it is classified. Today: cron health
(`lib/cron-run.ts`), the cross-tenant watchdogs (`cron/mission-invariants`,
`cron/queue-stall`, overdue check-in crons), and GitHub installation sync.
The queue-stall and overdue check-in pages name ids and the gate only, never a
tenant's titles, workspace names or gate detail.

Anything about one team's tasks, PRs, missions, budget or credentials is a
tenant alert and goes through the tenant plane below. That includes the project
health watcher and release pipeline failures: watched projects and
`releaseConfig` are team-admin settings, so those alerts go to the owning
workspace's team (`notifyTeamOf`, event `needsAttention`), not the operator.

### 2. `reportOps()` — `packages/core/report-ops.ts` (PR #910)
Drop-in for **swallowed catch blocks** so internal errors don't die silently in Vercel logs. Lives in `@buildd/core` so the runner can call it too. This is **the foundation** — see [Ops alerting design](#ops-alerting-design-the-foundation) for the full spec.

- Gated by `OPS_ALERTS_ENABLED` (dark until set).
- Dedup via the `system_cache` table (atomic claim, default 1h window, `OPS_THROTTLE_MS`) — survives stateless serverless invocations, no migration.
- Never throws. Current call site: `routing-analytics.ts:80`.

Why it exists: `recordTaskOutcome` corrupted routing telemetry for ~a day behind a `console.warn`. `reportOps` makes the next swallowed failure page us instead.

### 3. Vercel function logs
`console.warn`/`console.error` baseline. Not alerting — only seen if someone opens the dashboard. `reportOps` is the bridge from "logged" to "noticed."

---

## Tenant plane (client → their own channel) — PR #911

Each team configures **its own** channel; alerts route to the team that owns the task, never to a shared account.

### Storage
- **Credentials**: `secrets` table, team-scoped (`accountId`/`workspaceId` NULL), same model as agent-backend creds (see [credentials-architecture.md](./credentials-architecture.md)).
  - `purpose: 'pushover'` → encrypted JSON blob `{ appToken, userKey }` (**both** required — the team's own app token, never buildd's).
  - `purpose: 'notify_webhook'` → encrypted URL buildd POSTs alert JSON to.
- **Preferences**: `notification_preferences` table (one row per team), per-event booleans.

### Code
- `apps/web/src/lib/notify.ts` — `notifyTeam(teamId, event, payload)`. Loads channel + prefs, `resolveNotifyPlan` decides, sends. No-op when no channel or event disabled. Fire-and-forget.
- `notifyTeamOf({ teamId | workspaceId | missionId | taskId }, event, payload)` resolves the owning team first; an unresolvable owner sends nothing (no fallback to the ops plane).
- Event `needsAttention` covers "a person has to act" alerts (agent question, PR waiting on a human, reviewer/conflict escalation, mission or budget paused). It has no preference column, so it is sent whenever the team has a channel.
- `apps/web/src/lib/notify-rules.ts` — pure decision logic (no IO, unit-tested), plus `isCredentialExpiredError()`.
- API: `apps/web/src/app/api/teams/[id]/notifications/route.ts`
- UI: `apps/web/src/app/app/(protected)/settings/NotificationsSection.tsx` → **Settings → Notifications**

### Events (`NotifyEvent`)
`taskClaimed` · `taskCompleted` · `taskFailed` · `credentialExpired` — all default-on, all muteable per team.

Call sites: `workers/claim/route.ts:1007` (claimed); `workers/[id]/route.ts:736,744,758` (failed/completed/credentialExpired).

---

## Ops alerting design (the foundation)

> **Scope (2026-06-21):** buildd has one user. The job here is *not* a multi-tenant log product — it's making sure **every silent failure reaches the phone**. `reportOps()` is the spine; per-client log streaming is deferred (see Future).

### Severity ladder → Pushover priority

`reportOps({ severity })` maps to exactly one Pushover priority. Pick by **what the recipient should do**, not how bad it feels:

```
 ─2  ▁ badge only, no sound      warning    "noticed / self-healed — FYI"
  0  ▃ normal ping               error      "something failed — look when free"
  1  ▇ high, bypasses quiet hrs  critical   "platform broken — act now"
```

`critical` (priority 1) is the new tier added on top of the shipped warning/error. Reserve it for **systemic** breakage — never per-task noise.

### Coverage map

Every swallowed failure gets a severity. `[notifyTeam]` / `[health-watcher]` rows already alert via their own path and are listed for completeness.

| Source | Severity | Why it matters |
|---|---|---|
| `routing-analytics.ts:80` recordTaskOutcome | error | telemetry silently corrupted (the #910 bug) |
| cron dedup check fails | error | → duplicate scheduled tasks |
| `workers/[id]/route.ts:646` (after split) | error | one catch masks telemetry + notifications + dependency resolution |
| triage / artifact lookups | warning | degraded, not broken |
| credential expired (per task) | error | task blocked until re-auth · `[notifyTeam]` |
| CI red on release PR / Vercel prod down | critical | deploy pipeline broken · `[health-watcher]` (team channel of the project's workspace) |
| **★ consecutive runner failures** | **critical** | **"all tasks failing" detector — NEW** |

### Systemic-failure detector (★ new) — superseded by the Failure Pattern Sentinel

This sketch (a single consecutive-failure counter) was the first cut at "everything
is failing and nothing said so." It has since been generalized and shipped as the
**Failure Pattern Sentinel** — see [below](#failure-pattern-sentinel-incident-ledger--readout) —
which covers this case (`repeated_failure`) plus seven others (retry forks, multi-PR
retry lineages, stranded gates, path-overlap stalls, provider-attribution mismatch,
failure-rate spikes, repeated output-unmet boundaries) through one durable incident
ledger instead of one ad hoc counter per pattern. The sketch below is kept for
history; new systemic-pattern work belongs in `failure-pattern-sentinel.ts`'s rule
set, not a new counter.

The class of bug that hides longest is "everything is failing and nothing said so" (cf. the open *all-tasks-failing-on-runner* diagnostic). Add a counter, not a per-task alert:

```
on task outcome:
  failure → INCR consecutive_failures (in system_cache, atomic)
  success → reset to 0

  if consecutive_failures == THRESHOLD (e.g. 3):
      reportOps({ source: 'runner-health', severity: 'critical',
                  message: 'N consecutive task failures',
                  dedupeKey: 'runner-health' })   // one page per window, not per failure
```

- State lives in `system_cache` (same table/pattern as `reportOps` dedup — no migration).
- Fires **once** per throttle window via a fixed `dedupeKey`, so a sustained outage pages once, not N times.
- Threshold + window are env-tunable; start at 3 failures / 1h.

### Rollout
1. Add the `critical` severity → priority 1 mapping to `report-ops.ts`.
2. Wire `reportOps` into the 4 swallowed catches above (split `route.ts:646` first so one failure can't mask the others).
3. Add the consecutive-failure detector at the task-outcome write path.
4. Set `OPS_ALERTS_ENABLED=1` + `PUSHOVER_USER` / `PUSHOVER_TOKEN_ALERT` in Vercel **and** the runner env. Dark until then.

## Failure Pattern Sentinel — incident ledger & readout

A deterministic detector for *systemic* breakage, sitting between the per-call
`reportOps` catches above and a human noticing a trend by eye. One durable
`failure_incidents` row per stable pattern signature (not per occurrence), so
the 2nd and the 200th duplicate CI retry, stranded gate, or provider mismatch
update one row instead of paging — or filing a bug — once each.

**Pipeline** (`apps/web/src/lib/failure-pattern-sweep.ts`'s `runFailurePatternSweep`,
called by both a deferred post-transition trigger and a 30-minute cron backstop,
so there is exactly one code path to keep idempotent):

```
collect bounded facts (worker failures, gate events, retry lineage, …)
  → detectFailurePatterns()       pure rule engine, 8 rules, deterministic minimum severity
  → recordIncidentCandidates()    idempotent upsert into failure_incidents (CAS, no transactions)
  → actOnIncidentResults()        triage (rule floor, optionally raised by a model) →
                                   alert on transition only (never per occurrence) →
                                   at most one deduped fix task per incident
```

- **Severity → alert channel** reuses the same ladder as `reportOps` above:
  critical → Pushover priority 1, high → one normal Pushover, medium → digest
  (ledger only), low → ledger only. A critical floor is decided by rule and
  can never be downgraded by the model triage step — it is not even consulted.
- **Re-alerting** is transition-based: a severity increase, the affected scope
  crossing an impact tier, or a resolved incident recurring. Anything else —
  including the same pattern simply accumulating more occurrences — updates
  the row's count/evidence without paging or filing again.
- Noisy transient/infra and budget-exhaustion patterns (matched deterministically
  on the failure signature) stay ledger-only: no fix task is auto-filed for them
  unless a confident model answer names an actual platform defect.

### Reading the ledger

The same table is exposed read-only, API-first:

- **`GET /api/health/incidents`** (`apps/web/src/app/api/health/incidents/route.ts`) —
  team/workspace-scoped list with `status`/`severity`/`rule`/`signature` filters.
  Each row carries severity, rule + reasonCode, first/last seen, occurrence and
  recurrence counts, impact, representative task/worker/PR refs, alert state
  (`lastAlertedAt`/`lastAlertSeverity`), any linked fix task, and
  acknowledged/resolved state. `counts.bySeverity` gives the "open incidents by
  severity" overview regardless of the row-level filters.
- **MCP `list_incidents`** (`buildd` tool, analytics group) — same data, formatted
  for an agent loop. Check this before filing a `[friction]` task or a manual bug
  report for something that looks systemic; it may already be tracked, paged and
  linked to a fix task.

There is no second query implementation — both read paths select directly from
`failure_incidents`, the same table `failure-incident-store.ts` writes.

## Diagnostic plane (dashboard, not phone)

- **Error traces** — `apps/runner/src/error-trace-scanner.ts` pattern-matches agent tool output (`cd: No such file`, `ENOENT`, `Permission denied`, …), buffers on the worker, flushes to `worker_error_traces` (schema:631). Surfaced via `/api/tasks/[id]/error-traces` and `/api/workers/[id]/error-traces`, and the `get_error_traces` MCP action. Throttled per `(workerId, pattern)`. Born from the 2026-05-25 incident where a flailing agent's real error never surfaced past the heartbeat timeout.
- **Runner logs** — the standalone Bun runner logs to **stdout** (`console.log`), captured by whatever process manager runs it. There is no structured per-client log file today — this is the main gap (see below).
- **Pusher** — `apps/web/src/lib/pusher.ts` pushes realtime worker/task events to the dashboard. Transport for live UI, *not* a notification channel. (Don't confuse Push**er** the realtime bus with Push**over** the phone alert.)

---

## Migration plan

1. **Land #910 + #911** onto `dev`.
2. **Remove the legacy tenant events from the global channel.** Done: tenant alerts (agent questions, PR and reviewer escalations, mission and budget pauses) go through `notifyTeamOf` with event `needsAttention`, and the env sender was renamed `notifyOperator` with every call site pinned in `lib/notify-routing-invariant.test.ts`.
3. **Build the ops-alerting foundation** — see [Ops alerting design](#ops-alerting-design-the-foundation): add the `critical` tier, wire the 4 swallowed catches, add the consecutive-failure detector, flip `OPS_ALERTS_ENABLED`.

### Decision rule for new alerts
> Is this about a **specific customer's task**? → `notifyTeam` (tenant plane).
> Is this about **buildd's own health/internals**? → `notifyOperator()` or `reportOps` (ops plane).
> Never route tenant task content through the global `PUSHOVER_*` app.

## Future (deferred — multi-tenant)

Not needed while buildd has a single user; revisit when there's a second customer.

- **Per-client log streaming.** The runner logs to stdout only — not attributable per client, and a customer can't read their own task logs. Target: structured, tenant-tagged log lines shipped to a per-client sink, distinct from `worker_error_traces` (point-in-time error rows, not a stream). Leading design when revisited: **R2 stream + thin Postgres chunk index** (raw NDJSON in R2 under `logs/{teamId}/{taskId}/{workerId}/{seq}.ndjson`, a `worker_log_chunks` index row per batch, retention via R2 lifecycle). Reuses the existing presigned-upload + flush patterns. Postgres-only (one row per line, TTL'd) is the lower-effort fallback if query/search matters more than volume.

---

## Env reference

| Var | Plane | Purpose |
|---|---|---|
| `PUSHOVER_USER` | ops | buildd owner user key |
| `PUSHOVER_TOKEN_TASK` | ops | "tasks" app token |
| `PUSHOVER_TOKEN_ALERT` | ops | "alerts" app token |
| `PUSHOVER_TOKEN` | ops | fallback token |
| `OPS_ALERTS_ENABLED` | ops | gate for `reportOps` (unset = dark) |
| `OPS_THROTTLE_MS` | ops | `reportOps` dedup window (default 1h) |
| _(none)_ | tenant | per-team creds live encrypted in `secrets`, not env |
