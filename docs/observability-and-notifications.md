# Observability & Notifications

How buildd surfaces what's happening — to **us** (platform operators) and to **each customer team**. The two-plane model below is the long-term shape; the **immediate focus is the ops-alerting foundation** — getting errors and warnings to reliably reach the phone (see [Ops alerting design](#ops-alerting-design-the-foundation)).

> buildd currently has **one user**, so "tenant plane" and "ops plane" are the same person today. The split is built now so it's correct when there's a second customer — but the per-client *log streaming* product is explicitly deferred (see Future).

Status: **in transition.** The per-team channel (`notifyTeam`) and the ops channel (`reportOps`) both landed recently but are not yet merged to `dev`:
- PR #911 — per-team Pushover/webhook routing (`notify.ts`, `notification_preferences`)
- PR #910 — `reportOps()` ops alerting + the RQB FROM-clause fix

Until those merge and the legacy lifecycle `notify()` calls are removed (see Migration), some events fire on **both** the global and the per-team channel.

---

## The two planes

Everything below is one of two kinds of signal. Keep them separate — they have different recipients, different credentials, and different failure modes.

| | **Ops plane** (server) | **Tenant plane** (client) |
|---|---|---|
| Question it answers | "Are *our* systems healthy?" | "What's happening with *my* tasks?" |
| Recipient | buildd team (one inbox) | the customer team that owns the task |
| Credentials | env `PUSHOVER_*` (buildd's own app) | per-team, encrypted in `secrets` |
| Code | `notify()` (`pushover.ts`), `reportOps()` (`report-ops.ts`) | `notifyTeam()` (`notify.ts`) |
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

### 1. `notify()` — `apps/web/src/lib/pushover.ts`
Fire-and-forget env-based send. Genuinely platform-level call sites that **stay** here:

| Source | Event |
|---|---|
| `lib/health-watcher.ts:274,468` | CI red on a release PR / Vercel prod unhealthy |
| `lib/api-response.ts:25` | response payload > 100KB |
| `lib/mission-notifications.ts:41` | mission PR needs review / auto-merge blocked |
| `api/workers/[id]/route.ts:408` | budget/rate-limit pause (operator-facing) |

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
| CI red on release PR / Vercel prod down | critical | deploy pipeline broken · `[health-watcher]` |
| **★ consecutive runner failures** | **critical** | **"all tasks failing" detector — NEW** |

### Systemic-failure detector (★ new)

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

## Diagnostic plane (dashboard, not phone)

- **Error traces** — `apps/runner/src/error-trace-scanner.ts` pattern-matches agent tool output (`cd: No such file`, `ENOENT`, `Permission denied`, …), buffers on the worker, flushes to `worker_error_traces` (schema:631). Surfaced via `/api/tasks/[id]/error-traces` and `/api/workers/[id]/error-traces`, and the `get_error_traces` MCP action. Throttled per `(workerId, pattern)`. Born from the 2026-05-25 incident where a flailing agent's real error never surfaced past the heartbeat timeout.
- **Runner logs** — the standalone Bun runner logs to **stdout** (`console.log`), captured by whatever process manager runs it. There is no structured per-client log file today — this is the main gap (see below).
- **Pusher** — `apps/web/src/lib/pusher.ts` pushes realtime worker/task events to the dashboard. Transport for live UI, *not* a notification channel. (Don't confuse Push**er** the realtime bus with Push**over** the phone alert.)

---

## Migration plan

1. **Land #910 + #911** onto `dev`.
2. **Remove the legacy tenant events from the global channel.** Task lifecycle currently double-fires:
   - `workers/[id]/route.ts:190` "Agent needs your input" → add a `taskNeedsInput` event to `notifyTeam` and drop the env `notify()`.
   - `workers/[id]/route.ts:494` task done/failed → already covered by `notifyTeam`; remove the env `notify()`.
   After this, the global `PUSHOVER_*` app carries **only** ops-plane events.
3. **Build the ops-alerting foundation** — see [Ops alerting design](#ops-alerting-design-the-foundation): add the `critical` tier, wire the 4 swallowed catches, add the consecutive-failure detector, flip `OPS_ALERTS_ENABLED`.

### Decision rule for new alerts
> Is this about a **specific customer's task**? → `notifyTeam` (tenant plane).
> Is this about **buildd's own health/internals**? → `notify()` or `reportOps` (ops plane).
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
