---
title: External Cron Triggers
status: active
owner: max
last_verified: 2026-08-28
summary: Every /api/cron/* route MUST have exactly one trigger whose cadence is declared in version control, so a route that never fires is a reviewable diff rather than a silent production gap.
domain: integrations
surfaces: [cron-manifest.json, scripts/sync-crons.ts, apps/web/src/app/api/cron/schedules/route.ts, apps/web/src/lib/cron-cadence.ts]
related: [mission-task-lifecycle, scheduled-task-merge-policy, runner-liveness]
keywords: [cron-job.org, cron_secret, cronjob_api_key, vercel crons, nextrunat, cron:sync]
supersedes: []
---
# External Cron Triggers

**Capability statement**: Every `/api/cron/*` route MUST have exactly one
trigger whose cadence is declared in version control, so that a route silently
never firing is a reviewable diff rather than an invisible production gap.

Buildd has two trigger mechanisms and they MUST NOT overlap. **Only the
external scheduler is in use**: Vercel-native crons do not fire in this project,
and the five routes parked there (`codex-token-refresh`, `connector-block-notify`,
`lease-expiry-guard`, `pr-reconcile`, `task-archive`) silently never ran — which
is how an MCP connector credential holding a valid refresh token stayed dead for
15 days. `vercel.json` now declares no `crons`.

| Mechanism | Declared in | Auth accepted | Status |
|---|---|---|---|
| External scheduler (cron-job.org) | `cron-manifest.json` | `Authorization: Bearer $CRON_SECRET` | **in use** |
| Vercel-native cron | `vercel.json` → `crons[]` | `Authorization: Bearer $CRON_SECRET`, or `x-vercel-cron: 1` where the route accepts it | not used — does not fire here |

## Invariants

- Every route under `apps/web/src/app/api/cron/` appears in **exactly one** of
  `vercel.json`'s `crons[]` or `cron-manifest.json`'s `jobs[]`. A route in
  neither has no trigger; a route in both fires twice. Enforced by
  `scripts/cron-coverage.test.ts` — the capability statement above was previously
  unchecked, which is exactly how five routes sat on a dead mechanism.
- `vercel.json` declares **no** crons. Adding one there is a silent no-op.
- Manifest default timezone is **America/New_York**: schedules are read in the
  hours the product is actually used.
- A job that touches the database runs **at most hourly**, and **daytime only
  (`7-23`)**, unless its correctness requires otherwise. Neon autosuspends idle
  compute; a sub-hourly round-the-clock tick keeps it awake and bills idle time.
  Two sanctioned exceptions, both load-bearing:
  - `/api/cron/schedules` — hourly, hour field `*`. `isOverdue()` allows only
    `interval*2`. An hour range here is precisely what starved every schedule for
    12h a night, and an enabled schedule fires at 06:00.
  - `/api/cron/codex-token-refresh` — `0 */4 * * *`, unrestricted. Tokens expire
    overnight, and its cadence sizes the credential sweep window (below), which
    must be an **even** interval.
- A job whose cadence sizes a derived window MUST run on an even interval. An
  hour-restricted schedule's true worst case is the overnight gap (8h for
  `7-23`), not the nominal interval, so `cronIntervalMinutes` throws on those
  forms rather than returning a number that would under-size the window.
- Every externally-triggered route MUST authenticate via `Authorization: Bearer
  $CRON_SECRET`; the scheduler cannot send `x-vercel-cron`. Enforced by the same test.
- A job whose cadence another module reasons about (currently
  `codex-token-refresh`, whose cadence sizes the credential sweep window) is
  mirrored in `apps/web/src/lib/cron-cadence.ts` and pinned by
  `cron-cadence.test.ts`, so a schedule change cannot silently mis-size a window.
- A route that has effectively never run is staged `enabled: false` when moved,
  so its first run against a full backlog is a deliberate decision.
- Every `cron-manifest.json` job's `schedule` is a valid 5-field cron
  expression, evaluated in that job's `timezone` (manifest default: `UTC`).
- The schedules tick (`/api/cron/schedules`) carries **no hour restriction**:
  its cron hour field is `*`. An hour range there starves every `task_schedules`
  row for the excluded hours, with no error emitted anywhere.
- The tick interval is at most the shortest cadence any **enabled**
  `task_schedules` row uses. Every enabled row is hourly-or-coarser, so the tick
  is `0 * * * *`. Adding an enabled sub-hourly row requires making the tick at
  least that fine, or it fires late.
- Schedules fire **exactly on the hour**. No jitter may be added to `nextRunAt`:
  the tick runs at `:00`, so an offset past that instant does not spread load, it
  delays the schedule to the next tick a full hour later. (`computeStaggerOffset`
  added 0–299s to every top-of-hour schedule and was removed for this reason.)
- Reconciliation is origin-scoped: `sync-crons.ts` only reads, updates, or
  deletes provider jobs whose URL starts with
  `CRON_TARGET_BASE_URL + "/api/cron/"`. Jobs on any other origin MUST be left
  untouched, including under `--prune`.
- Deleting a managed job absent from the manifest requires an explicit
  `--prune`; the deploy workflow MUST NOT pass it.

## Acceptance criteria

- AC-1: GIVEN `cron-manifest.json` declares `/api/cron/schedules` at
  `*/30 * * * *` WHEN `bun run cron:check` runs against a provider whose live
  job is `0 7-19 * * *` THEN it reports drift and exits non-zero.
- AC-2: GIVEN the provider already matches the manifest WHEN `bun run cron:sync`
  runs THEN it performs zero writes and reports `in sync`.
- AC-3: GIVEN a manifest job with `"method": "POST"` WHEN the job is built THEN
  its `requestMethod` is `1`, so POST-only routes are not called with GET.
- AC-4: GIVEN a manifest job with `"enabled": false` WHEN sync applies THEN the
  provider job exists but does not fire.
- AC-5 (failure path): GIVEN `CRONJOB_API_KEY` is unset WHEN any mode runs THEN
  the script exits non-zero with `CRONJOB_API_KEY is not set` and performs no
  API calls.
- AC-8: GIVEN a live job whose auth header differs from the caller's
  `CRON_SECRET` WHEN `cron:check` runs THEN it reports no drift on that basis,
  and WHEN `cron:sync` updates the job's schedule THEN the live auth header is
  left unchanged.
- AC-9 (failure path): GIVEN `--rotate-secret` is passed and `CRON_SECRET` is
  unset WHEN sync runs THEN it exits non-zero rather than writing an empty
  header.
- AC-10 (failure path): GIVEN CI's `CRON_SECRET` differs from Vercel
  production's WHEN the deploy workflow runs THEN the pre-sync probe of
  `GET /api/cron/routing-calibration` returns 401 and the workflow fails
  without performing any provider writes.
- AC-6 (failure path): GIVEN the provider account also holds jobs on an
  unrelated origin WHEN `bun run cron:sync --prune` runs THEN those jobs are
  neither updated nor deleted.
- AC-7: GIVEN a cron expression that is not 5 fields WHEN the manifest is
  parsed THEN sync rejects it with an error naming the expression, rather than
  silently coercing it.

## Code surface

- `cron-manifest.json` — the declared job set (single source of truth).
- `scripts/sync-crons.ts` — `cronToSchedule`, `buildJob`, `signature`,
  `updateBody`, origin-scoped reconcile; modes `--dry-run` / `--check` /
  `--prune` / `--rotate-secret`.
- `scripts/sync-crons.test.ts` — cron-field expansion and drift-detection tests.
- `.github/workflows/cron-sync.yml` — probes the secret against production,
  then runs `cron:sync`, on successful Production deploys only. Reads from the
  default branch (`dev`).
- `apps/web/src/app/api/cron/routing-calibration/route.ts` — the probe target.
  Chosen because it is read-only, so a liveness check has no side effects.
- `vercel.json` — the disjoint Vercel-native cron set.
- `apps/web/src/app/api/cron/schedules/route.ts` — the tick; `GET`, rejects a
  mismatched bearer with HTTP 401.
- `apps/web/src/lib/schedule-helpers.ts` — `computeNextRunAt` advances from
  *now*, so a missed window causes one catch-up per schedule, not a backfill.
- `apps/web/src/lib/heartbeat-helpers.ts` — `isOverdue`,
  `estimateCronIntervalMs`; overdue threshold is `interval * 2`.
- `packages/core/db/schema.ts` — `taskSchedules.nextRunAt`, `enabled`.

## Out of scope

- The provider's own retry/timeout settings, which are not modelled in the
  manifest signature (only URL, title, enabled, method, schedule, auth header).
- `CRON_SECRET` *value* management. Sync compares only whether an auth header
  is present, and updates omit `extendedData` so the live header survives. The
  value is written only when creating a job, or under an explicit
  `--rotate-secret`. Keeping the two copies of the secret in step (provider
  header vs. Vercel env) is out of scope for this spec.
- Per-schedule fan-out behaviour inside the tick (`MAX_SCHEDULES_PER_RUN`,
  stagger offsets) — see the scheduled-task specs.
