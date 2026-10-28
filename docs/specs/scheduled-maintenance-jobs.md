---
title: Scheduled maintenance jobs
status: draft
owner: max
last_verified: 2026-10-28
summary: The thirteen background cron routes that keep derived state, alerts and hygiene current MUST each declare what they do, their cadence and what degrades when they stop, so a silently dead job is recognisable.
domain: integrations
surfaces: [cron-manifest.json, apps/web/src/app/api/cron/orchestration-readout/route.ts, apps/web/src/app/api/cron/role-outcomes/route.ts, apps/web/src/app/api/cron/mission-summaries/route.ts, apps/web/src/app/api/cron/feedback-digest/route.ts, apps/web/src/app/api/cron/chat-retro/route.ts, apps/web/src/app/api/cron/page-budget-health/route.ts, apps/web/src/app/api/cron/experiment-health/route.ts, apps/web/src/app/api/cron/memory-digest-guardrail/route.ts, apps/web/src/app/api/cron/runner-update-notify/route.ts, apps/web/src/app/api/cron/visual-review-schedule/route.ts, apps/web/src/app/api/cron/post-session-quality/route.ts, apps/web/src/app/api/cron/stall-notify/route.ts, apps/web/src/app/api/cron/task-archive/route.ts]
related: [external-cron-triggers, runner-liveness]
keywords: [cron, maintenance, cron_runs, lease expiry, task archive, stall notify, role outcomes]
supersedes: []
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "task-archive-route"
    type: "route"
    method: "GET"
    path: "/api/cron/task-archive"
  - id: "post-session-quality-route"
    type: "route"
    method: "GET"
    path: "/api/cron/post-session-quality"
---
# Scheduled maintenance jobs

**Capability statement**: Each background cron route listed here MUST do one
bounded, idempotent pass per trigger, and this spec records what each one is for
and what degrades without it. How a route is triggered is
[external-cron-triggers](external-cron-triggers.md); this spec is the
per-route purpose and failure-cost register for the routes that had no spec.

Schedules below are read from `cron-manifest.json` (timezone
`America/New_York`) and that file stays the authority; if they disagree, the
manifest wins and this table is stale. Every route authenticates with
`Authorization: Bearer $CRON_SECRET` and records a `cron_runs` row through
`withCronRun`.

## Jobs

| Route | Schedule | What it does | What breaks without it |
|---|---|---|---|
| `task-archive` | weekly, Monday 10:00 | Cancels (the de-facto archive) `failed` tasks untouched for 30 days that no live task depends on. Idempotent. | Failed task rows accumulate forever and clutter lists. |
| `stall-notify` | every 5 minutes (manifest note: staged dark, no trigger has ever existed) | Sends one Pushover reminder per stall window for escalation-inbox PRs waiting past `stallNotifyMinutes`. | Stalled PRs wait silently for a human; no reminders. |
| `runner-update-notify` | every 5 minutes, gated (`?gate=due`) | Tells a team once that a runner update is stuck and releases that runner's paused tasks after an hour of silence. Returns without touching Postgres when nothing is due. | A stuck runner update goes unreported and its paused tasks stay paused. |
| `mission-summaries` | hourly | Recomputes a bounded sample (default 50, max 200 via `?limit`) of stored mission summaries, missing and oldest first, writing what differs. | Summaries drift from the missions they describe and never-summarised missions stay blank. |
| `visual-review-schedule` | every 30 minutes | Files a mission's visual review when its integration head owes one, re-files on a new UI-impacting head, retries system failures with backoff, and names the next actor on a blocked mission. Bounded, rotating batch. | UI-impacting missions are never reviewed automatically. |
| `post-session-quality` | hourly | One bounded pass of the post-session quality loop: triage recently terminal workers, record findings, apply each workspace's mode (off / shadow / propose). Out of band: completion, review and merge never wait on it. | No post-session findings or proposals; delivery itself is unaffected. |
| `feedback-digest` | every 4 hours | Distils feedback down-votes and dismissals into memories, re-mirrors memory rows missing from the recall index, and runs the memory lifecycle pass. | Agents stop learning from feedback; unmirrored memories drop out of recall. |
| `chat-retro` | daily 10:00 | Experiment. For opted-in teams, turns quiet chat windows into content-free lesson rows and, with proposals on, files capped, deduped tasks. Off by default; `CHAT_RETRO_ENABLED=0` disables everywhere. | Nothing for non-opted teams; opted-in teams get no retro lessons. |
| `experiment-health` | daily 09:00 | Checks every running experiment's enrolment (nothing enrolled, undrawn arm, skewed split, over-concentrated unit, past duration cap). Pauses an experiment past its cap and sends one alert. | Starved or overrunning experiments fail silently again. |
| `memory-digest-guardrail` | daily 09:05 | Standing post-ship failure-rate guardrail for the shipped `task_scoped` memory digest arm; arithmetic in `@buildd/core/memory-digest-guardrail-monitor`. | A failure-rate regression from the accepted arm goes unwatched. |
| `orchestration-readout` | daily 11:00 | For teams opted in to orchestration manifest or claim, grades a trailing 30-day window, upserts a private aggregate and posts a deduped eligibility advisory. Promotion stays a reviewed policy entry. | No evidence to promote orchestration policy; no harm to running work. |
| `role-outcomes` | hourly | Records each role's terminal outcomes for the last hour against the prior day, plus live runner builds and the deploy, into `cron_runs`. Read-only; judges and notifies nothing. | The out-of-band responder's `role-regression` detector loses its only feed and cannot page. |
| `page-budget-health` | hourly | Reads the trailing hour of over-budget page loads and alerts the operator about a page over its speed budget, at most once a day per page. | Slow pages go unnoticed until users complain. |

## Invariants

1. Every job MUST be idempotent: an overlapping or repeated trigger does no
   double work or double alert.
2. Every job MUST be bounded (batch size, time budget or `?limit`); remaining
   work is deferred to the next run, never run unbounded.
3. A job MUST NOT be on the critical path of task completion, review, merge or
   release; its failure degrades the feature in the table and nothing else.
4. A job that needs an opt-in (`chat-retro`, `orchestration-readout`) MUST be a
   cheap no-op when no team opted in.

## Acceptance criteria

- AC-2: GIVEN a `failed` task older than 30 days that a pending task depends on
  WHEN `task-archive` runs THEN it is left as it is; one with no live dependent
  becomes `cancelled`.
- AC-3: GIVEN a PR in the escalation inbox past `stallNotifyMinutes` WHEN
  `stall-notify` runs twice in one stall window THEN one reminder is sent.
- AC-4: GIVEN no team opted in WHEN `chat-retro` or `orchestration-readout`
  runs THEN it makes one cheap query and changes nothing.
- AC-5: GIVEN a running experiment past its duration cap WHEN `experiment-health`
  runs THEN it is paused, not concluded.

## Code surface

- `cron-manifest.json`: the schedule of each job.
- `apps/web/src/app/api/cron/orchestration-readout/route.ts`
- `apps/web/src/app/api/cron/role-outcomes/route.ts`
- `apps/web/src/app/api/cron/mission-summaries/route.ts`
- `apps/web/src/app/api/cron/feedback-digest/route.ts`
- `apps/web/src/app/api/cron/chat-retro/route.ts`
- `apps/web/src/app/api/cron/page-budget-health/route.ts`
- `apps/web/src/app/api/cron/experiment-health/route.ts`
- `apps/web/src/app/api/cron/memory-digest-guardrail/route.ts`
- `apps/web/src/app/api/cron/runner-update-notify/route.ts`
- `apps/web/src/app/api/cron/visual-review-schedule/route.ts`
- `apps/web/src/app/api/cron/post-session-quality/route.ts`
- `apps/web/src/app/api/cron/stall-notify/route.ts`
- `apps/web/src/app/api/cron/task-archive/route.ts`
- `apps/web/src/lib/post-session-loop.ts`, `apps/web/src/lib/task-archive.ts`,
  `apps/web/src/lib/workflow/visual-review-schedule.ts`: the logic behind three
  of them.

## Out of scope

- How routes are triggered and the cron-job.org sync: see external-cron-triggers.
- The schedules tick, core maintenance and other already-specced cron routes.

## Known gaps

- `lease-expiry-guard` is gone: it watched server-held subscription-login
  leases, and that custody path was removed. Its old AC-1 is retired rather
  than renumbered.

- `stall-notify` is declared in the manifest but its note says no trigger has
  ever existed; confirm before relying on it.
- The `task-archive` manifest comment says "completed tasks" while the route
  archives `failed` ones; the route is the behaviour recorded here.
