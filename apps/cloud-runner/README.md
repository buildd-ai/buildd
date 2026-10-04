# @buildd/cloud-runner

A Cloudflare Worker that runs buildd tasks one container per task. buildd's
task webhook reaches this Worker, the Worker routes it to a `WorkerAgent`
(an Agents SDK Durable Object named by task ID), and the agent runs
`buildd --once --task <id>` in a container built from
`apps/runner/Dockerfile.once`.

Design: [`docs/design/cloudflare-sandbox-runner.md`](../../docs/design/cloudflare-sandbox-runner.md)
(Components 3). Image and env contract: [`docs/runner-container.md`](../../docs/runner-container.md).

## Layout

| File | What it is |
|---|---|
| `src/index.ts` | Worker entry: `fetch` handler, re-exports `WorkerAgent` |
| `src/http.ts` | Routes, bearer auth, body validation. Runtime-free |
| `src/worker-agent.ts` | `WorkerAgent`: wires the supervisor to `ctx.container`, state and keepAlive |
| `src/supervisor.ts` | One run: start the container, exec, wait, record, stop, crash report. Runtime-free |
| `src/lifecycle.ts` | Pure decisions: exit code to outcome, dispatch dedupe, container env |
| `src/run-report.ts` | The per-run report: phase lines, egress counters, assembly, delivery. Runtime-free |
| `src/snapshots.ts` | The snapshot store behind the egress-intercepted pseudo-host (warm repos). Runtime-free |
| `src/eval-report.ts`, `src/eval-client.ts`, `scripts/eval-report.ts` | The eval report over many runs (see Measuring runs) |

The runtime-free files are what the Bun tests cover (`bun run test`); they
never import `agents` or `cloudflare:workers`.

## Endpoints

Both need `Authorization: Bearer <DISPATCH_TOKEN>`.

- `POST /dispatch`: the body is buildd's webhook payload (`task-dispatch.ts`);
  only `taskId` is read. Returns `202` with `{ taskId, accepted, attempt }`
  as soon as the run is starting. A duplicate while a run is live returns
  `202` with `accepted: false` (a non-2xx would make buildd fall back to
  Pusher).
  - `event: 'task.resume'` with `workerId` continues a parked worker
    (Resumable runs, below).
  - `event: 'task.scheduled'` with `notBefore` (an ISO date-time) starts the
    run at that time instead of now (Scheduled dispatch, below). Returns
    `202` with `{ taskId, scheduled: true, scheduledFor, replaced }`; a
    `notBefore` already past dispatches at once (`scheduled: false` plus the
    dispatch result). `400 invalid_not_before` for a missing or non-ISO value,
    `400 not_before_too_far` for more than 24 h ahead (plus 5 minutes of
    clock slack).
- `GET /tasks/:taskId`: the agent's state, for debugging. A pending scheduled
  wake shows as `scheduledFor` (epoch ms) and `scheduleId`.

## Lifecycle

`idle → starting → running → exited`. A dispatch while `starting` or
`running` is ignored. A dispatch after `exited` starts the next attempt in a
fresh container. The agent never starts a run by itself: retries are buildd
firing a new webhook, and there are no timers that poll buildd. The one alarm
is the one-shot a `task.scheduled` webhook asks for (Scheduled dispatch).

| Exit | Outcome | Agent does |
|---|---|---|
| 0 | `done` | nothing (the runner reported) |
| 1 | `failed` | nothing (the runner reported; buildd's retry path decides) |
| 3 | `refused` | nothing (claim refused, no worker) |
| 64 | `usage` | nothing (bad invocation or missing config) |
| anything else, or no code (killed, OOM, container gone, agent restarted mid-run) | `crashed` | `PATCH /api/workers/<id>` with `status: failed`, if the worker ID is known |

The container's main process is `sleep infinity`; the agent starts the run
with `ctx.container.exec(['buildd-once', '--task', id])` and gets the exit
code from `ExecProcess.exitCode`. It also watches `ctx.container.monitor()`
so a container that dies under the process ends the run. Either way the
container is destroyed afterwards.

**Crash reporting.** The agent only knows the task ID. `buildd --once` prints
`BUILDD_WORKER_ID=<id>` on stdout as soon as the claim succeeds; the agent
reads it from the exec'd process's output and stores it. A crash before that
line has no worker to mark (the claim never finished, or finished just before
the crash); server-side stale detection covers that case.

The report is `PATCH /api/workers/<id>` with `status: failed` and
`crashReconciled: true`, the flag the runner's own boot reconciliation sends
for a session its process lost. buildd treats it as an infrastructure failure:
the task goes back to `pending` on the infra-retry budget (backoff 5, 15, 30
minutes, counted in `context.infraRetryCount`), and after the last attempt the
task fails as `infra_stalled`. The requeue's durable wake is scheduled for the
end of the backoff. With `task.scheduled` in the webhook's events (the deploy
script sets it), buildd also sends an advance notice at once with that time as
`notBefore`, and the agent starts the retry then. Either way the `dispatch-drain`
tick delivers the wake when due, as `task.retry` to a webhook that lists that
event: the backstop. Only a `crashed` outcome is reported;
the runner's own exits (1 failed, 3 refused, 4 parked, 64 usage) are not.

**Restarts.** If the Durable Object is evicted mid-run (deploy, limits), the
exec'd process cannot be re-attached. On the next start the agent finds the
run marked live, destroys the container, and records `crashed` (and reports
it as above).

## Configuration

| Name | Kind | Required | Notes |
|---|---|---|---|
| `DISPATCH_TOKEN` | secret | yes | Must equal the workspace's `webhookConfig.token` |
| `BUILDD_API_KEY` | secret | yes | Runner API key. Stays in the Worker: it mints a per-task token for each run (`POST /api/runner/task-token`), and only that token goes into the container. Also used for the crash report |
| `BUILDD_SERVER` | var | yes | No default: the Worker refuses to dispatch without it, because the runner would fall back to production |
| `MODEL`, `PUSHER_KEY`, `PUSHER_CLUSTER`, `BUILDD_ONCE_MAX_WAIT_MS` | var | no | Passed through, same meaning as on a long-lived runner |
| `CONTAINER_INACTIVITY_TIMEOUT_MS` | var | no | Default 30 min. A backstop: the agent holds keepAlive for the whole run |
| `CONTAINER_START_TIMEOUT_MS` | var | no | Default 5 min, for `ctx.container.running` after `start()` |
| `CONTAINER_INSTANCE_TYPE` | var | no | Copy of `containers[0].instance_type`, for the run report (a test keeps them equal) |
| `RUNNER_GROUP` | var | no | The Worker name (`wrangler.jsonc`; `deploy.ts --name` rewrites it). Every container reports it as `BUILDD_RUNNER_GROUP`, so the dashboard fleet shows this deployment as one elastic group, not one runner per run. Default `buildd-cloud-runner`. Takes effect on redeploy |
| `OTEL_EXPORTER_OTLP_*`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_TRACES_BETA` | var / secret | no | OpenTelemetry export, see Telemetry |
| `WARM_REPOS` | var | no | `1` turns on warm repos (below). Default off. Needs the `SNAPSHOTS` R2 binding |
| `ALLOW_DEBUG_KILL` | var / secret | no | `1` enables `POST /tasks/:taskId/kill` (dispatch token required): destroys that task's container as an OOM kill or platform stop would, for recovery testing. Default off (the route is 404) |
| `RESUMABLE_RUNS` | var | no | `1` turns on resumable runs (below). Default off. Needs the `SNAPSHOTS` R2 binding and a webhook that lists `task.resume` |
| `SNAPSHOTS` | R2 binding | for warm repos / resumable runs | Bucket `buildd-cloud-runner-snapshots` (`wrangler.jsonc`); `deploy.ts` creates it and its lifecycle rule |

The container gets a placeholder `ANTHROPIC_API_KEY` and no GitHub token; the
real credentials are added to its outbound requests (see Egress credentials).

## Measuring runs

Every attempt ends with a **run report**, built in `src/run-report.ts`. It is
stored in the agent's state (`report` in `GET /tasks/:taskId`; earlier
attempts in `reportHistory`, last 10) and, when the run claimed a worker,
posted to buildd as a worker artifact: `POST /api/workers/<workerId>/artifacts`,
`type: data`, key `cloud-run-report:<workerId>`, report in `metadata.report` and
in `content`. The POST uses the Worker's `BUILDD_API_KEY`, the runner key the
container claimed with (the route only accepts the worker's own account), same
as the crash report. It runs after the run is marked `exited`, so it never
holds up the outcome; one retry after a network error or a 5xx, none after
any other status. The result is `report.delivery`: `sent`, `rejected`, `error`,
`no_worker_id` (no claim, nothing to attach it to) or `not_configured`.

| Field | Source |
|---|---|
| `timestamps.dispatchReceivedAt` | The dispatch that started the attempt (agent clock, epoch ms) |
| `timestamps.containerRunningAt` | `ctx.container.running` after `start()` |
| `timestamps.claimedAt` | When the `BUILDD_WORKER_ID=` line was read |
| `timestamps.firstModelRequestAt` | First `api.anthropic.com` request the egress handler saw |
| `timestamps.exitedAt` | The runner process exited or the container died |
| `runnerPhases`, `durationsMs.clone`, `durationsMs.install` | `BUILDD_PHASE=` lines from the runner (container clock); see `docs/runner-container.md`. The install is the runner's own `bun install`; a repo with a declared install (`.buildd/env.yaml`) or a non-bun toolchain has none |
| `durationsMs.*` | Derived; null when either end is missing |
| `containerInstanceId` | The Durable Object ID (`ctx.id`). `ctx.container` exposes no instance ID; Cloudflare documents the Durable Object ID (the container's `CLOUDFLARE_DURABLE_OBJECT_ID`) as what identifies the instance on the dashboard. One agent reuses it across attempts |
| `runLabel` | `<taskId>.<attempt>`, also set as the container label `bd_run`, so analytics can be joined per attempt |
| `instanceType` | `CONTAINER_INSTANCE_TYPE` |
| `egress.{model,github,passthrough}` | Per class: `requests`, `rejected` (refused by the handler), `responseBytes` (decoded body bytes the container read to the end; a lower bound). Only intercepted hosts are seen; other egress is not counted |
| `egressDetail.{model,github,passthrough}` | Why requests failed, as counts only: `rejectReasons` (`path`, `unconfigured`, `plain_http`, `port`, `unparseable`, `other`) for refusals by the handler, `rejectedPaths` (where `path` refusals were going, as fixed labels: `api_hello`, `event_logging`, `oauth`, `claude_code_api`, `other_api`, `files`, `batches`, `other_v1`, `other`), and `errorStatuses` (upstream 4xx/5xx by code, e.g. a proxy's 403 for a model the key may not use). No URL or header is recorded |
| `egressDetail.github.credentialed`, `.unauthenticated` | Forwarded GitHub requests that carried the injected installation token, and those that did not, by fixed reason: `no_grant` (the agent had no live run), `grant_fetch_failed` (buildd's `/api/runner/github-token` refused or failed, or the agent is backing off after that), `grant_expired`, `out_of_scope` (not the task's repo: another repo, `/user`, codeload) |
| `egressDetail.github.unauthenticatedErrorStatuses` | Upstream 4xx/5xx on the unauthenticated forwards only, by code. A 429 here is an anonymous rate limit; a 429 only in `errorStatuses` was sent with the token |
| `egressDetail.github.grantFetchFailures` | The github-token endpoint's refusals by status (`error`: nothing answered). The Worker log has the same line with the task ID |
| `schedule.scheduledFor`, `.startedAt`, `.lateMs` | A run started by a `task.scheduled` wake: the time it was due, when the attempt started (= `dispatchReceivedAt`) and the difference. `scheduledFor` and `lateMs` are null for any other start (report version 4) |
| `exitCode`, `outcome`, `crashReport`, `attempt`, `taskId`, `workerId` | As in the state |

The report is built from an allowlist of typed fields; identifiers that do not
look like IDs are dropped. It never holds header values, tokens, URLs, request
or response bodies, or runner output. Egress counters and timings are lost if
the agent is evicted mid-run (the orphan report has what was persisted).

The `repo` section (report version 2) says how the repo got onto the disk:
`source` `warm` or `clone`, `fallbackReason` for a clone (`disabled`,
`no_snapshot`, `unavailable`, `disk`, `restore_failed`), `snapshotAgeMs`, and
`bytes.{clone,restore,fetch,cache,upload}`. `durationsMs.restoreWarm`,
`durationsMs.fetch` and `durationsMs.warmUpload` time the warm path the way
`durationsMs.clone` times a clone. All come from the runner's `BUILDD_PHASE=`,
`BUILDD_METRIC=` and `BUILDD_REPO_SOURCE=` lines (`docs/runner-container.md`).

### Eval report

`scripts/eval-report.ts` lists the reports for a window and joins them with
Cloudflare's container analytics:

```bash
export BUILDD_SERVER=https://buildd.dev BUILDD_API_KEY=bld_…          # a key with access to the workspace
export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…                   # optional; without them, report columns only
bun apps/cloud-runner/scripts/eval-report.ts --workspace <workspace-id> --since 2026-09-01T00:00:00Z [--until <iso>] [--out <dir>]
```

It writes `cloud-runs.csv` (one row per run) and `cloud-runs.md` (phase p50/p90,
outcomes by cause, active vCPU-seconds, peak and average memory, rx/tx, egress
totals, estimated compute cost per run) and prints the summary.

- Reports: `GET /api/workspaces/<id>/artifacts?keyPrefix=cloud-run-report:&type=data&since=…&before=…`,
  paged newest first by `updatedAt`.
- Metrics: Cloudflare GraphQL `containersMetricsAdaptiveGroups` (the workload
  alone: `cpuTimeSec`, `rxBytes`, `txBytes`, `max.memory` per minute) and
  `containersUsageAdaptiveGroups` (billed: `cpuTimeSec`, `allocatedMemory`,
  `allocatedDisk` in byte-seconds), grouped by `instanceId` and the `bd_run`
  label. If Cloudflare rejects the label dimension the script retries without it
  and matches runs by instance ID and time window; billed usage is per day, so
  two attempts of one agent on the same day cannot be split and get none.
- Memory is reported in whatever unit the dataset uses (not stated in the docs).
  Average memory is the mean of the per-minute peaks.
- Cost: list prices (memory $0.0000025/GiB-s, vCPU $0.000020/vCPU-s, disk
  $0.00000007/GB-s, [Containers pricing](https://developers.cloudflare.com/containers/pricing/))
  applied to billed usage, before the monthly included allowance, without
  Workers or Durable Object charges.

Token permission: **Account Analytics: Read** on the account (the GraphQL
Analytics API). The buildd key needs read access to the workspace.

## Local development

Needs Docker. From this directory:

```bash
bunx wrangler dev --var DISPATCH_TOKEN:dev --var BUILDD_API_KEY:<key> --var BUILDD_SERVER:<dev server>
bash scripts/local-smoke.sh     # end-to-end check against a fake buildd
```

R2 works under `wrangler dev` (local simulation); the smoke keeps it in a
throwaway `--persist-to` directory. The Worker runs on the host and the
containers on Docker, and both use one `BUILDD_SERVER` (the Worker for the
model-endpoint lookup, the GitHub grant and run-report delivery). Docker
Desktop's `host.docker.internal` resolves only inside containers, so the
smokes reach their fake buildd at the host's primary address instead,
detected by `scripts/smoke-host.sh`. Set `SMOKE_HOST_ADDR` to override it;
the smoke stops if this host cannot reach the fake at that address.

The first run builds the image for linux/amd64, which is slow on an arm64 host
(emulation).

## Test locally

No Cloudflare account needed. Needs Docker and Node.js 20+ (the web app is
served with `next start`). From the repo root:

```bash
bun run cloud-runner:local                              # up to "claimed + worker started"
ANTHROPIC_API_KEY=sk-ant-… bun run cloud-runner:local   # also runs the model and expects exit 0
```

`scripts/local-e2e.sh` runs the whole path on this machine and tears it down
on exit:

1. A disposable Postgres, Neon HTTP proxy and soketi (the demo stack's
   `scripts/demo/docker-compose.yml`, under its own compose project and
   ports), migrated from `packages/core/drizzle`.
2. The web app, production build, from an empty environment
   (`scripts/demo/serve.sh`). No `.env` file is read, so a checkout that holds
   real credentials cannot leak them in.
3. A seeded team, open workspace (a small public repo, cloned over https),
   admin key and worker-level runner key (`scripts/local-e2e-seed.ts`).
4. `wrangler dev` for this Worker with task containers on local Docker, and
   `BUILDD_SERVER=http://host.docker.internal:<port>` so the container can reach
   the web app on the host.
5. The workspace is pointed at the Worker with `PATCH /api/workspaces/:id`
   (`webhookConfig`, same call as `deploy.ts`), a task is created with
   `POST /api/tasks`, and buildd's own webhook dispatch reaches `POST /dispatch`.
6. It waits for the run to exit and checks the claim (`BUILDD_WORKER_ID`), the
   worker start, the agent's recorded outcome, and the task status in buildd.

`ANTHROPIC_API_KEY` is only passed through, in a mode-600 temp env file that is
deleted on exit, as the Worker secret `ANTHROPIC_DIRECT_API_KEY` with
`ALLOW_DIRECT_ANTHROPIC=1`. The egress handler then forwards model calls
straight to Anthropic with that key instead of AI Gateway; the container never
holds it. Never set either on a deployed Worker. Without a key the model step is
skipped and the script says so.

Behind a TLS-inspecting proxy the model call fails inside the container with
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`: the image does not trust the proxy's CA.
Everything up to the session start still runs and is checked.

Knobs: `CLOUD_E2E_REUSE_BUILD=1` reuses an existing `next build`;
`CLOUD_E2E_*_PORT` moves the ports; `RUN_TIMEOUT_S`, `READY_TIMEOUT_S`,
`DISPATCH_TIMEOUT_S` bound the waits. The first run builds the runner image for
linux/amd64, which is slow under emulation on arm64.

## Deploy with your Cloudflare token

Prereqs:

- A Cloudflare account on **Workers Paid** with **Containers** enabled.
- Docker running locally (`wrangler deploy` builds and pushes the image).
- An API token (dash.cloudflare.com → My Profile → API Tokens, or an
  account-owned token) with, on the target account:
  - **Workers Scripts: Edit** (deploy the Worker, set its secrets)
  - **Containers: Edit** (the container application and image registry)
  - **Durable Objects** are covered by Workers Scripts: Edit; **Account
    Settings: Read** lets `deploy.ts` read the account's workers.dev subdomain
    (or pass `--url`)
  - **AI Gateway: Edit**, only if you set an AI Gateway ID
- A buildd **admin** API key (`BUILDD_API_KEY`), and a **worker**-level runner
  key for the dispatcher, ideally scoped to the workspace
  (`BUILDD_RUNNER_API_KEY` or `--runner-key`). They must differ: the Worker
  keeps the runner key and uses it to mint each container's per-task token.
  The dispatcher's key does not need the host-runner flag (Settings → Runners →
  Runner tokens); leave it off.

Save the token once in buildd: **Settings → Runners → Cloudflare** (API token,
account ID, optional AI Gateway ID). It is stored encrypted as the team-wide
`cloudflare_token` secret and verified against Cloudflare
(`/accounts/<id>/tokens/verify`, then `/user/tokens/verify`) straight away and
whenever you press Verify. The page only ever shows the account ID's first and
last four characters and the token's last four. Only team owners and admins
can set or delete it.

Then, from the repo root:

```bash
export BUILDD_API_KEY=bld_…            # admin key
export BUILDD_RUNNER_API_KEY=bld_…     # worker key for the containers (see below)
bun apps/cloud-runner/scripts/deploy.ts --workspace my-workspace --dry-run   # print the plan
bun apps/cloud-runner/scripts/deploy.ts --workspace my-workspace
```

The runner key never enters a container: the Worker uses it to mint a per-task
token for each run. A scoped key needs at least the **Task agent** capabilities
(`tasks:read`, `tasks:write`, `workers:write`, `analytics:read`,
`knowledge:write`) and, if limited to workspaces, the dispatching workspace;
narrowing the key later ends the tokens it minted.

`deploy.ts` fetches the saved token with the admin key
(`POST /api/cloudflare/credential/reveal`: `bld_` admin keys only, own team
only, `no-store`). To keep the token out of buildd entirely, set
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead; the script then
never calls that route. It then:

1. `wrangler deploy`
2. `wrangler secret put` `BUILDD_SERVER` (`--worker-server`, default the
   buildd URL), `BUILDD_API_KEY` (the runner key) and a freshly generated
   `DISPATCH_TOKEN`
3. `PATCH /api/workspaces/:id` with `webhookConfig = { url: <worker>/dispatch, token, enabled: true, events: ['task.created', 'task.unblocked', 'task.retry', 'task.resume', 'task.scheduled'] }`

`events` is the opt-in. A webhook without it gets what webhooks always got:
new and unblocked tasks. Retries, approved-plan children and deferred-start
re-dispatches reach a webhook only when it lists the event (`task.retry` for
retries and the deferred sweep, `task.created` for plan children); otherwise
they wake runners over Pusher. `task.scheduled` makes buildd send a deferred
task at once with its start time (Scheduled dispatch, below). A re-run adds any event the workspace's webhook
is missing, without touching the token. PATCH merges `webhookConfig`, so keys
it does not manage (the issue-ingest settings) are kept, and plain `http` is
accepted only for `localhost`, `127.0.0.1` and `host.docker.internal`.

| Flag | Effect |
|---|---|
| `--dry-run` | Print the plan (secrets redacted); change nothing |
| (re-run) | Redeploys code; rotates nothing. An existing `DISPATCH_TOKEN` and runner key stay |
| `--rotate` | New `DISPATCH_TOKEN` on the Worker and the workspace. Other workspaces on the same Worker stop dispatching until re-pointed |
| `--remove` | `webhookConfig = null`: clears the dispatch keys (`url`, `token`, `enabled`, `runnerPreference`, `events`); the workspace goes back to Pusher-notified runners (Coder, local). The Worker stays deployed |
| `--print-token` | Print the `DISPATCH_TOKEN` it set |
| `--url` | Worker base URL, for a custom domain |
| `--name <worker>` | Deploy under another Worker name, with its own bucket `<worker>-snapshots`. The script writes `wrangler.generated.jsonc` (gitignored; only `name` and `bucket_name` differ) and passes it to every wrangler call. Pass the same `--name` on every later run against that deployment |
| `--model-proxy-url <url>` | Route model traffic through your Anthropic-compatible proxy (see Model routes). Also read from `MODEL_PROXY_URL`; the key comes from `MODEL_PROXY_KEY` (required the first time, never printed) and the header from `MODEL_PROXY_AUTH_HEADER`. All three are put as Worker secrets so a later deploy keeps them. A re-run without the flag leaves an existing proxy in place; `bunx wrangler secret delete MODEL_PROXY_URL` goes back to AI Gateway |

A second workspace on an existing Worker needs the current token
(`DISPATCH_TOKEN=… deploy.ts --workspace other`) or `--rotate`: the token
cannot be read back from Cloudflare. The decisions are in `src/deploy-plan.ts`
and covered by `src/deploy-plan.test.ts`.
## Egress credentials

Design Components 4. The container holds no model or GitHub credential; the
Worker adds them to the container's outbound requests. This supersedes the
"placeholder key, egress is the next step" note above, and the container no
longer receives `ANTHROPIC_BASE_URL` (model traffic must reach
`api.anthropic.com` so the handler can rewrite it).

| File | What it is |
|---|---|
| `src/outbound.ts` | Pure rewrite rules, the GitHub token cache, the token request. Runtime-free, Bun-tested |
| `src/egress.ts` | `EgressHandler`, the `WorkerEntrypoint` the container's traffic is routed through |

`WorkerAgent.installEgressHandlers` runs before each container start and
registers `ctx.container.interceptOutboundHttps(host, ctx.exports.EgressHandler({ props: { taskId } }))`
(and `interceptOutboundHttp` for the same hosts) for:

| Host | What the handler does |
|---|---|
| `api.anthropic.com` | Forwarded per the model route below (AI Gateway, your proxy, or local-only direct), with that route's credential. Only `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models` and `GET /v1/models/<id>`, in canonical form; any other path is refused with `403`. Unconfigured: `503`, never forwarded with the placeholder |
| `github.com` | `/<owner>/<repo>[.git]/...` of the task's repo: `Authorization: Basic base64(x-access-token:<token>)` (git over HTTPS) |
| `api.github.com`, `uploads.github.com` | `/repos/<owner>/<repo>/...` of the task's repo, and `api.github.com/graphql`: `Authorization: Bearer <token>` |
| `codeload.github.com`, and any other path on the hosts above | Nothing added |
| The OTLP collector's origin, when `OTEL_EXPORTER_OTLP_ENDPOINT` is set | `<OTEL_EXPORTER_OTLP_AUTH_HEADER>: <OTEL_EXPORTER_OTLP_AUTH_VALUE>` (see Telemetry) |
| anything else | Not intercepted (open egress in phase 1) |

For every intercepted host the handler **first deletes** whatever the
container sent in `authorization`, `proxy-authorization`, `x-api-key`,
`anthropic-api-key`, `cf-aig-authorization`, `cookie` and URL userinfo, and
only then adds the Worker's credential. Plain HTTP and non-443 ports to these
hosts are refused (`403`). Upstream redirects are returned to the container
(`redirect: 'manual'`), so an injected credential never follows a redirect.

### Warm repos

Design Phase 2, "Warm repos". Off unless `WARM_REPOS=1` and the `SNAPSHOTS`
binding exist. Then the container gets `BUILDD_WARM_REPO=1` and
`BUILDD_SNAPSHOT_URL=https://buildd-snapshots.invalid`, and the agent
intercepts that pseudo-host (HTTPS only) with the same `EgressHandler`. The
handler never forwards it: it serves `src/snapshots.ts` against the R2
binding, streaming bodies both ways.

- **Keys are the Worker's.** The workspace comes from buildd: the
  `/api/runner/github-token` grant (authenticated with the dispatch token)
  now carries `workspaceId`, and `WorkerAgent.getSnapshotScope` hands it out
  only while a run is live. The request path names an operation (`GET /warm`,
  `POST /warm/begin`, `PUT /warm/<generation>/repo`, ...), never a key, and
  the query string is ignored. No grant (no GitHub App link, token refused):
  `503`, and the runner clones as usual.
- **Layout.** `warm/<workspaceId>/<generation>/{repo.bundle,bun-cache.tar,manifest.json}`
  plus `warm/<workspaceId>/lock`. The kind comes first so a prefix-only R2
  lifecycle rule can cover it.
- **Refresh.** One in flight per workspace: `POST /warm/begin` takes the lock
  with a conditional put (create-only, or replace a lock older than 30
  minutes), uploads go only to the lock's generation, and `commit` writes the
  manifest last, so a half-uploaded generation is never visible. Commit keeps
  the newest two committed generations and deletes the rest.
- **Retention.** The lifecycle rule `warm/` at 14 days is the backstop
  (`deploy.ts` adds it; by hand: `wrangler r2 bucket lifecycle add
  buildd-cloud-runner-snapshots warm-expiry warm/ --expire-days 14`).
- **Limits.** `content-length` is required on uploads, at most 5 GB (single
  part). The runner skips the warm path when the snapshot is over a quarter of
  free disk.

What goes in a snapshot and what the runner refuses to upload:
`docs/runner-container.md`, "Warm repos".

### Scheduled dispatch

A task buildd defers to a future `startAt` (the crash retry's backoff, a
budget-reset deferral, a deferred-start task) is not claimable until then.
Without help, a push-only runner hears about it only from buildd's hourly
deferred-dispatch sweep. With `task.scheduled` in the webhook's `events`,
buildd sends it at once instead (`notBefore` = `startAt`, at most 24 h ahead;
anything further is left to the sweep), and the agent wakes itself:

- **Schedule.** The agent creates a one-shot with the Agents SDK
  (`this.schedule(new Date(notBefore), 'runScheduledDispatch', …)`, backed by
  the Durable Object alarm) and records `scheduledFor` and `scheduleId` in its
  state. A run that is live does not block this: the crash retry is requeued
  while the crashed run is still finishing.
- **Replace.** A later `task.scheduled` for the same task replaces the pending
  one (last write wins): the old alarm is cancelled, and if it fires anyway
  its id no longer matches and it does nothing.
- **Fire.** When the alarm fires, the wake is cleared and handed to the normal
  dispatch path. A live run makes it a no-op. A dispatch that started a run
  before the alarm (any event) consumes the pending wake.
- **Backstop.** buildd's sweep still sends `task.retry` once `startAt`
  passes. If the scheduled run is live by then, that is a duplicate and is
  ignored; if the alarm was lost, it starts the run.
- **Report.** A run started by a wake carries `schedule.scheduledFor`,
  `schedule.startedAt` and `schedule.lateMs` in its run report.

### Resumable runs

Design Phase 2, "Resumable runs". Off unless `RESUMABLE_RUNS=1` and the
`SNAPSHOTS` binding exist. The container then gets `BUILDD_ONCE_PARK=1`.

- **Park on a question.** When the worker waits for an answer with no live
  session, the runner uploads a park bundle (`PUT /park`, stored at
  `park/<workspaceId>/<workerId>`), calls `POST /api/workers/[id]/park` and
  exits 4. The agent records `outcome: parked`, sends no crash report and
  destroys the container.
- **Resume.** The answer queues on the same worker, and buildd sends
  `task.resume` with `workerId`. The agent accepts it only when its last
  attempt parked that worker. It starts a container and execs
  `buildd-once --resume-worker <id>`, which restores the warm snapshot and then
  the bundle, re-attaches (`POST /api/workers/[id]/reattach`) and drains the
  answer into the old transcript.
- **Orphan park.** A container still running when the agent restarts gets
  `buildd-once --park-orphan <id>`, and the agent marks the park and resumes it
  at once.
- **Bundle base.** The park bundle is built against the warm snapshot's tip
  as restored (`refs/buildd/warm-base`, set before the post-restore fetch),
  not the origin the container fetched since, so a resume onto that snapshot
  needs no fetch. When the bundle still lacks commits and fetching origin
  fails, the resume retries the fetch (a 429 waits for `Retry-After`, other
  transient errors back off; at most 30 s in all) before giving up.
- **Failed restore.** The runner clears the park. A worker waiting on an
  answer is left to the server's ack-deadline sweep (cold continuation); an
  orphan park (still `running`, nothing queued) is reported `failed`.
- **Bounds.** At most 3 parks per worker. `parkedUntil` is 24 h, or 4 h for a
  mission task. The lifecycle rule `park/` at 2 days is the storage backstop.
- **Local smoke.** `bun run smoke:resume` covers both paths: a question and a mid-run agent restart.

### Model routes

`resolveModelRoute` in `src/outbound.ts` picks one, in this order:

| Route | Selected when | Forwarded to | Credential added |
|---|---|---|---|
| `direct` | `ALLOW_DIRECT_ANTHROPIC=1` and `ANTHROPIC_DIRECT_API_KEY` (**local development only**) | `https://api.anthropic.com/...` unchanged | `x-api-key: <ANTHROPIC_DIRECT_API_KEY>` |
| `proxy` | `MODEL_PROXY_URL` is set | `<MODEL_PROXY_URL><original path and query>`, e.g. `https://litellm.example.com/v1/messages` | `Authorization: Bearer <MODEL_PROXY_KEY>` (default), or `x-api-key: <MODEL_PROXY_KEY>` with `MODEL_PROXY_AUTH_HEADER=x-api-key` |
| team endpoint (`proxy` shape) | Neither of the above, and buildd returns the team's agent model endpoint for this task (Settings → Model providers) | `<endpoint baseUrl><original path and query>` | The endpoint's key, as `Authorization: Bearer` or `x-api-key` per its setting |
| `gateway` | `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID` and `AI_GATEWAY_TOKEN` are set | `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic/...` | `cf-aig-authorization: Bearer <AI_GATEWAY_TOKEN>`; the Anthropic key lives in AI Gateway (BYOK) or Unified Billing |

If none applies, model requests get `503`.

**Proxy** is any service that speaks the Anthropic Messages API, such as a
LiteLLM proxy. The handler appends the container's path, so point
`MODEL_PROXY_URL` at the base Claude Code would use as `ANTHROPIC_BASE_URL`:
`https://litellm.example.com` for LiteLLM's unified `/v1/messages`, or
`https://litellm.example.com/anthropic` if you use its Anthropic pass-through
route. LiteLLM accepts its virtual or master key in either header. Rules:

- Setting `MODEL_PROXY_URL` commits to the proxy. It wins over a fully
  configured gateway, and if it is invalid or `MODEL_PROXY_KEY` is missing the
  request is refused with `503`; it never falls back to the gateway.
- `MODEL_PROXY_URL` must be `https:` (plain `http:` only for `localhost`,
  `127.0.0.1` and `host.docker.internal`), with no userinfo, query or
  fragment. A trailing slash is dropped. Any port is allowed.
- The container's `authorization`, `x-api-key` and the other credential
  headers are deleted first, as for every route. The proxy key and URL stay in
  the Worker; the container never receives `MODEL_PROXY_*`.
- `MODEL` (a Worker var passed to the container) picks the model. With a
  proxy, set it to a model name or alias your proxy serves.

**Team endpoint.** The Worker asks buildd (`POST /api/runner/model-endpoint`,
runner API key plus `DISPATCH_TOKEN`, like the GitHub token) on the task's
first model request, only when neither `direct` nor `MODEL_PROXY_URL`
applies. It is held in the `WorkerAgent`'s memory for the run: never in agent
storage and never in the container env. A `404` means the team has none (or
the task's own Anthropic credential outranks it) and egress falls through to
AI Gateway. Any other failure, or a `401`/`403` from the endpoint, refuses
model requests (`503`) for a short backoff and then asks again, so a rotated
key takes effect mid-run and a buildd outage never silently moves spend to the
gateway. `MODEL_PROXY_URL` stays the operator override: it pins the Worker to
one proxy whatever team claims through it. Model aliases are not applied on
this route: the container sends the claim's native model ids (design open
question 2).

**GitHub token.** Minted by buildd, not the Worker: the App key stays in one
place. On the container's first GitHub request (after the claim; the clone
runs inside it) the handler asks the task's `WorkerAgent`, which calls
`POST <BUILDD_SERVER>/api/runner/github-token` with `Authorization: Bearer
<BUILDD_API_KEY>`, `X-Buildd-Dispatch-Token: <DISPATCH_TOKEN>` and
`{ taskId, workerId? }`. The dispatch token is what the container lacks: it has
the API key but could not use it to fetch the token itself. buildd checks that
the account may claim from the task's workspace, that the dispatch token
matches that workspace's enabled webhook, and that the task has a live worker
claimed by the same account, then mints an installation token with
`repository_ids: [<the workspace's github_repos link>]` and only the
permissions a run needs. `workflows` is not among them, so a push that
changes `.github/workflows/` is refused; workflow changes go to a person. The agent keeps it in memory (never in storage, never
in the container), shares one fetch between concurrent requests, refetches 5
minutes before expiry, and backs off 15 s after a failure (requests then go out
unauthenticated). It is only handed out while a run is `starting`/`running`.

Scoping achieved: GitHub rejects the token for any repo but the task's; on top
of that the handler only attaches it to the task repo's paths. GraphQL cannot
be path-scoped and relies on the token's own scope.

**TLS.** HTTPS interception re-signs with a per-container CA;
`buildd-once` trusts it (see `docs/runner-container.md`, "Egress and TLS trust").

| Name | Kind | Required | Notes |
|---|---|---|---|
| `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID` | var | for the gateway route | Cloudflare account and gateway ids |
| `AI_GATEWAY_TOKEN` | secret | for the gateway route | AI Gateway authentication token |
| `MODEL_PROXY_URL` | var (or secret) | no | Anthropic-compatible proxy base URL. Set: the proxy route, over the gateway |
| `MODEL_PROXY_KEY` | secret | with `MODEL_PROXY_URL` | The proxy's key |
| `MODEL_PROXY_AUTH_HEADER` | var (or secret) | no | `authorization` (default, Bearer) or `x-api-key` |
| `ALLOW_DIRECT_ANTHROPIC` | var | no | **Local development only.** `1` together with `ANTHROPIC_DIRECT_API_KEY` sends model traffic straight to Anthropic with that key instead of the gateway. Default off. Never set it on a deployed Worker |
| `ANTHROPIC_DIRECT_API_KEY` | secret | no | **Local development only**, see above. Ignored unless `ALLOW_DIRECT_ANTHROPIC=1` |
| `DISPATCH_TOKEN` | secret | yes | Also authenticates the GitHub token request |

The container is started with `BUILDD_EXECUTOR=cloud`, so the claim response
carries no credential material (`CLAIM_CREDENTIAL_FIELDS` in
`packages/shared/src/executor.ts`: model credentials, Codex credentials, MCP
secrets and connectors, role env secrets, credential-refresh ids). Consequence
for phase 1: roles that need MCP connectors or role env secrets run without
them on the cloud runner.

The smoke also checks the run report: recorded for every run, egress counters
from the egress step, clone phase lines and `claimedAt` from a fake claim, and
the artifact POST: `sent`, and the fake buildd's receipt.

`scripts/local-smoke.sh` checks the rewrite end to end: see its
"egress rewrite" step. `SMOKE_MODEL_ROUTE=proxy` runs it with a dummy proxy
configured alongside the gateway and checks that the proxy wins.

## Telemetry

Claude Code in the container can export its own OpenTelemetry to a collector
you choose. Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set; without it the
container env and the egress rules are exactly what they are otherwise (pinned
in `src/otel.test.ts` and `src/supervisor.test.ts`). Logic: `src/otel.ts`.

**What is emitted** (Claude Code's
[monitoring docs](https://code.claude.com/docs/en/monitoring-usage)):

- **Events, as OTLP logs.** `claude_code.tool_decision` (accept/reject and
  who decided) and `claude_code.tool_result` (`tool_name`, `tool_use_id`,
  `success`, `duration_ms`, `error_type`, input/result sizes) for every tool
  call, `claude_code.api_request` (model, tokens, cost, `duration_ms`) and
  `claude_code.api_error` for every model call, plus `user_prompt`,
  `assistant_response` (text redacted) and others. Each carries `session.id`,
  `prompt.id`, `event.timestamp` and `event.sequence` (a per-process counter),
  so one dispatch's tool calls read in order, with outcomes, by filtering on
  `buildd.task_id` + `buildd.attempt` and sorting by `event.sequence`.
- **Metrics**: cost, tokens, sessions, lines changed, commits, PRs.
- **Traces (beta, opt-in)**: with `OTEL_TRACES_BETA=1`, spans per prompt
  (`claude_code.interaction` → `llm_request`, `tool` → `tool.execution`). The
  container also gets a fresh `TRACEPARENT` per dispatch, which Agent SDK
  sessions adopt as the parent, so all of one dispatch's spans share a trace
  ID. The parent span itself is never exported.

Every signal carries the resource attributes `buildd.task_id`,
`buildd.attempt` and, set by the runner once the claim succeeds,
`buildd.worker_id`.

**Point it at a collector** (Worker vars, then redeploy):

| Name | Kind | Notes |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | var | Base OTLP/HTTP URL, e.g. `https://otel.example.com`; Claude Code appends `/v1/logs`, `/v1/metrics`, `/v1/traces`. `https:` only (plain `http:` only for `localhost`, `127.0.0.1`, `host.docker.internal`), no userinfo, query or fragment, not a model or GitHub host |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | var | `http/protobuf` (default) or `http/json`. `grpc` is refused: the egress handler forwards HTTP requests |
| `OTEL_EXPORTER_OTLP_AUTH_HEADER` | secret | Header for the collector credential; default `authorization` |
| `OTEL_EXPORTER_OTLP_AUTH_VALUE` | secret | The full header value, e.g. `Bearer <token>`. Unset: exports go unauthenticated |
| `OTEL_LOG_TOOL_DETAILS` | var | `1` to include tool arguments (Bash commands, MCP server/tool names, file paths on spans). Default off |
| `OTEL_TRACES_BETA` | var | `1` for beta span tracing, see above. Default off |

The container gets `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`,
`OTEL_METRICS_EXPORTER=otlp`, the endpoint, protocol and
`OTEL_RESOURCE_ATTRIBUTES`, and never the credential or any
`OTEL_EXPORTER_OTLP_*HEADERS`. The egress handler intercepts the collector's
host and, for its exact origin only (scheme, host and port), deletes the
container's credential headers and the configured one, then adds the Worker's.
A look-alike host, a subdomain or another port gets nothing; plain http to an
https collector is refused. An invalid endpoint fails the run before the
container starts (`usage`) rather than exporting nothing without saying so.

**Privacy.** By default no content leaves: prompts and responses are redacted
and tool arguments are omitted, leaving tool names, outcomes, durations and
sizes. `OTEL_LOG_TOOL_DETAILS=1` is the only content opt-in the cloud runner
passes; it adds commands and arguments, which can include file paths, repo
names and anything else an agent types into a shell. Claude Code's
`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_CONTENT` and `OTEL_LOG_RAW_API_BODIES`
are never set and are not on the runner's agent env allowlist
(`apps/runner/src/agent-env.ts`). Claude Code's standard attributes also
carry the signed-in Claude account's ids and email, when there is a sign-in. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (set by the image) blocks
Anthropic-bound telemetry, not export to your collector.

The smoke's egress step checks the container env, a synthetic OTLP POST
(credential added by fingerprint, container auth stripped, plain http refused)
and runs a real `claude -p` in the container, whose exports are logged by the
echoing handler.
