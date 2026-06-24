# Webhook & Realtime Dataflow

**Capability statement**: The buildd coordination layer MUST emit Pusher events
on every significant state change (task/worker/mission lifecycle transitions,
schedule triggers, DAG unblocking) so the dashboard updates in real time, and
MUST dispatch tasks to external runners via workspace webhook configs when
configured.

---

## Pusher Event Contracts

The Pusher client is optional — when `PUSHER_APP_ID`, `PUSHER_KEY`,
`PUSHER_SECRET`, and `PUSHER_CLUSTER` are not all set, all `triggerEvent` calls
are silent no-ops. No route may block on a Pusher failure.

### Channels

| Channel | Pattern | Consumers |
|---------|---------|-----------|
| `workspace-{id}` | Workspace-level events | Dashboard workspace view |
| `task-{id}` | Task-specific events | Task detail page |
| `worker-{id}` | Worker telemetry + commands | Runner, activity timeline |
| `mission-{id}` | Mission-level events | Mission feed |

An optional `PUSHER_CHANNEL_PREFIX` env var isolates events per environment
(e.g. `preview-workspace-123`).

### Event Catalogue

| Event name | Channel | Emitted when |
|------------|---------|-------------|
| `task:created` | `workspace-{id}` | Task row inserted |
| `task:claimed` | `workspace-{id}` | Worker claims a task |
| `task:completed` | `workspace-{id}`, `task-{id}` | Worker status → `completed` |
| `task:failed` | `workspace-{id}`, `task-{id}` | Worker status → `failed` |
| `task:assigned` | `workspace-{id}` | Task assigned to specific runner |
| `worker:started` | `workspace-{id}` | Worker `startedAt` set (first `running`) |
| `worker:progress` | `worker-{id}` | `update_progress` call |
| `worker:completed` | `worker-{id}`, `workspace-{id}` | Worker completes |
| `worker:failed` | `worker-{id}`, `workspace-{id}` | Worker fails |
| `worker:command` | `worker-{id}` | Admin sends instruct/recover/abort command |
| `schedule:triggered` | `workspace-{id}` | Cron fires and creates a task |
| `schedule:deferred` | `workspace-{id}` | Cron fires but defers (concurrent cap, active hours, unchanged trigger) |
| `task:children_completed` | `task-{id}` | All child/sub-tasks complete |
| `task:unblocked` | `task-{id}` | `dependsOn` dependency resolved |
| `task:dependency_failed` | `task-{id}` | An upstream dependency failed |
| `mission:cycle_started` | `mission-{id}` | Mission evaluation cycle begins |
| `mission:loop_completed` | `mission-{id}` | Mission loop finishes successfully |
| `mission:loop_stalled` | `mission-{id}` | Mission loop detects no progress |
| `task:retry_cap` | `workspace-{id}` | Task reaches retry cap (failure loop prevention) |
| `mission:note_posted` | `mission-{id}` | Agent posts a note to the mission feed |

**Invariants**:
- `triggerEvent` MUST be called as a fire-and-forget side effect — it MUST NOT
  be awaited in a way that allows its failure to abort the primary DB write.
- All channel names are prefixed with `PUSHER_CHANNEL_PREFIX` (default: `""`).
- `worker:command` is the mechanism for admin→runner steering: the runner
  subscribes to `worker-{id}` and acts on commands (instruct, recover, abort).

**Acceptance criteria**:
- AC-1: GIVEN Pusher env vars are not set WHEN a worker completes THEN the
  completion DB write succeeds and no error is thrown (silent no-op).
- AC-2: WHEN a task's `dependsOn` dependency transitions to `completed` THEN a
  `task:unblocked` event is emitted on the `task-{taskId}` channel.
- AC-3: WHEN an admin sends an `instruct` command via `POST /api/workers/[id]/instruct`
  THEN a `worker:command` event is emitted on `worker-{workerId}` with the
  instruction payload.
- AC-4: WHEN a cron schedule fires but is deferred due to `maxConcurrentFromSchedule`
  being reached THEN a `schedule:deferred` event is emitted (not `schedule:triggered`).

**Code surface**:
- Pusher client + channel/event constants: `apps/web/src/lib/pusher.ts`
- Worker PATCH (emits `worker:progress`, `worker:completed`, `worker:failed`):
  `apps/web/src/app/api/workers/[id]/route.ts`
- Dependency resolution (emits `task:unblocked`):
  `apps/web/src/lib/task-dependencies.ts`
- Instruct route (emits `worker:command`):
  `apps/web/src/app/api/workers/[id]/instruct/route.ts`
- Cron schedule route (emits `schedule:triggered`, `schedule:deferred`):
  `apps/web/src/app/api/cron/schedules/route.ts`

---

## Webhook Dispatch (External Runners)

**Capability statement**: When a workspace has `webhookConfig.enabled = true`,
the buildd server MUST POST new task data to the configured `webhookConfig.url`
immediately after task creation so external runners (e.g. OpenClaw) can claim
without polling.

**Invariants**:
- Webhook dispatch is best-effort — a failed HTTP POST MUST NOT prevent the
  task from being created.
- The webhook endpoint receives the task payload with `Authorization: Bearer
  {webhookConfig.token}`.
- `webhookConfig.runnerPreference` optionally filters: only tasks whose
  `runnerPreference` matches are dispatched.
- `webhookConfig` is stored as JSONB on `workspaces.webhookConfig`.

**Acceptance criteria**:
- AC-5: GIVEN a workspace with `webhookConfig.enabled = true` WHEN a task is
  created THEN an HTTP POST is sent to `webhookConfig.url` with the task data
  and `Authorization: Bearer {token}` header.
- AC-6: GIVEN the webhook endpoint returns a non-2xx status WHEN a task is
  created THEN the task creation still succeeds (best-effort).
- AC-7: GIVEN `webhookConfig.runnerPreference = 'service'` and a task with
  `runnerPreference = 'user'` WHEN the task is created THEN NO webhook dispatch
  occurs for that task.

**Code surface**:
- Webhook dispatch: `apps/web/src/app/api/tasks/route.ts` (POST handler)
- Schema: `packages/core/db/schema.ts` — `WorkspaceWebhookConfig`,
  `workspaces.webhookConfig`

---

## GitHub Webhook Ingest

**Capability statement**: The `POST /api/github/webhook` endpoint MUST process
GitHub App event payloads (installation, push, pull_request, check_suite) to
keep workspace and repo data in sync and optionally auto-create tasks.

**Invariants**:
- Every incoming payload MUST be verified against the GitHub webhook secret
  before processing.
- Unrecognized event types MUST be accepted with HTTP 200 (no error) — GitHub
  retries on non-2xx.
- Installation events update `github_installations` rows.

**Acceptance criteria**:
- AC-8: WHEN a GitHub webhook payload is received with an invalid signature
  THEN the endpoint returns HTTP 401 and no processing occurs.
- AC-9: WHEN a `push` event is received for a repo linked to a workspace THEN
  the `github_repos` row is updated (at minimum `updatedAt`).

**Code surface**:
- Route: `apps/web/src/app/api/github/webhook/route.ts`
- Schema: `packages/core/db/schema.ts` — `githubInstallations`, `githubRepos`

---

## External Notification (Pushover / Slack / Discord)

**Capability statement**: The buildd notification system MUST send Pushover
and/or webhook notifications for task lifecycle events
(`task_claimed`, `task_completed`, `task_failed`, `credential_expired`) subject
to per-team `notificationPreferences`.

**Invariants**:
- `notificationPreferences` defaults to `true` for all event types — existing
  teams receive all notifications unless explicitly disabled.
- Pushover and notify-webhook credentials are stored in `secrets`
  (`purpose = 'pushover'` and `purpose = 'notify_webhook'`).
- Notification sends MUST be fire-and-forget — failures MUST NOT block the
  event that triggered them.

**Acceptance criteria**:
- AC-10: GIVEN `notificationPreferences.taskCompleted = false` for a team WHEN
  a task completes THEN no Pushover notification is sent for that event type.
- AC-11: GIVEN no `pushover` secret configured WHEN a task completes THEN no
  Pushover notification is attempted (not an error).

**Code surface**:
- Notify helper: `apps/web/src/lib/notify.ts` — `notifyTeam()`
- Schema: `packages/core/db/schema.ts` — `notificationPreferences`,
  `secrets.purpose`
- Observability doc: `docs/observability-and-notifications.md`

**Out of scope**: Slack and Discord slash command handling
(`/api/integrations/slack`, `/api/integrations/discord`) — these are
inbound, not outbound. The `report-ops` critical-alert path (covered in
`runner-liveness.md`). MCP Resources (read-only, no Pusher involvement).
