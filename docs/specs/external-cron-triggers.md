---
title: External Cron Triggers
status: active
owner: max
last_verified: 2026-08-27
supersedes: []
---
# External Cron Triggers

**Capability statement**: Every `/api/cron/*` route MUST have exactly one
trigger whose cadence is declared in version control, so that a route silently
never firing is a reviewable diff rather than an invisible production gap.

Buildd has two trigger mechanisms and they MUST NOT overlap:

| Mechanism | Declared in | Auth accepted |
|---|---|---|
| Vercel-native cron | `vercel.json` → `crons[]` | `Authorization: Bearer $CRON_SECRET`, or `x-vercel-cron: 1` where the route accepts it |
| External scheduler (cron-job.org) | `cron-manifest.json` | `Authorization: Bearer $CRON_SECRET` |

## Invariants

- Every route under `apps/web/src/app/api/cron/` appears in **exactly one** of
  `vercel.json`'s `crons[]` or `cron-manifest.json`'s `jobs[]`. A route in
  neither has no trigger; a route in both fires twice.
- Every `cron-manifest.json` job's `schedule` is a valid 5-field cron
  expression, evaluated in that job's `timezone` (manifest default: `UTC`).
- The schedules tick (`/api/cron/schedules`) carries **no hour restriction**:
  its cron hour field is `*`. An hour range there starves every `task_schedules`
  row for the excluded hours, with no error emitted anywhere.
- The tick interval is at most the shortest cadence any `task_schedules` row
  uses. Rows use `*/30`, so the tick MUST be `*/30` or finer.
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
