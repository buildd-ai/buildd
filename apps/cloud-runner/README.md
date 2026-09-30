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

The runtime-free files are what the Bun tests cover (`bun run test`); they
never import `agents` or `cloudflare:workers`.

## Endpoints

Both need `Authorization: Bearer <DISPATCH_TOKEN>`.

- `POST /dispatch`: the body is buildd's webhook payload (`task-dispatch.ts`);
  only `taskId` is read. Returns `202` with `{ taskId, accepted, attempt }`
  as soon as the run is starting. A duplicate while a run is live returns
  `202` with `accepted: false` (a non-2xx would make buildd fall back to
  Pusher).
- `GET /tasks/:taskId`: the agent's state, for debugging.

## Lifecycle

`idle → starting → running → exited`. A dispatch while `starting` or
`running` is ignored. A dispatch after `exited` starts the next attempt in a
fresh container. The agent never starts a run by itself: retries are buildd
firing a new webhook, and there are no alarms or timers that poll buildd.

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

**Restarts.** If the Durable Object is evicted mid-run (deploy, limits), the
exec'd process cannot be re-attached. On the next start the agent finds the
run marked live, destroys the container, and records `crashed` (and reports
it as above).

## Configuration

| Name | Kind | Required | Notes |
|---|---|---|---|
| `DISPATCH_TOKEN` | secret | yes | Must equal the workspace's `webhookConfig.token` |
| `BUILDD_API_KEY` | secret | yes | Runner API key. Stays in the Worker: it mints each container's per-task token (`POST /api/runner/task-token`), fetches GitHub tokens and sends the crash report. The container only ever gets the per-task token |
| `BUILDD_SERVER` | var | yes | No default: the Worker refuses to dispatch without it, because the runner would fall back to production |
| `MODEL`, `PUSHER_KEY`, `PUSHER_CLUSTER`, `BUILDD_ONCE_MAX_WAIT_MS` | var | no | Passed through, same meaning as on a long-lived runner |
| `CONTAINER_INACTIVITY_TIMEOUT_MS` | var | no | Default 30 min. A backstop: the agent holds keepAlive for the whole run |
| `CONTAINER_START_TIMEOUT_MS` | var | no | Default 5 min, for `ctx.container.running` after `start()` |

The container gets a per-task buildd token, a placeholder `ANTHROPIC_API_KEY`
and no GitHub token; the real credentials are added to its outbound requests
(see Egress credentials).

## Local development

Needs Docker. From this directory:

```bash
bunx wrangler dev --var DISPATCH_TOKEN:dev --var BUILDD_API_KEY:<key> --var BUILDD_SERVER:<dev server>
bash scripts/local-smoke.sh     # end-to-end check against an unreachable server
```

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
  keeps the runner key and uses it to mint each container's per-task token. It
  does not need the host-runner flag.

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
export BUILDD_RUNNER_API_KEY=bld_…     # worker key for the containers
bun apps/cloud-runner/scripts/deploy.ts --workspace my-workspace --dry-run   # print the plan
bun apps/cloud-runner/scripts/deploy.ts --workspace my-workspace
```

`deploy.ts` fetches the saved token with the admin key
(`POST /api/cloudflare/credential/reveal`: `bld_` admin keys only, own team
only, `no-store`). To keep the token out of buildd entirely, set
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead; the script then
never calls that route. It then:

1. `wrangler deploy`
2. `wrangler secret put` `BUILDD_SERVER` (`--worker-server`, default the
   buildd URL), `BUILDD_API_KEY` (the runner key) and a freshly generated
   `DISPATCH_TOKEN`
3. `PATCH /api/workspaces/:id` with `webhookConfig = { url: <worker>/dispatch, token, enabled: true }`

| Flag | Effect |
|---|---|
| `--dry-run` | Print the plan (secrets redacted); change nothing |
| (re-run) | Redeploys code; rotates nothing. An existing `DISPATCH_TOKEN` and runner key stay |
| `--rotate` | New `DISPATCH_TOKEN` on the Worker and the workspace. Other workspaces on the same Worker stop dispatching until re-pointed |
| `--remove` | `webhookConfig = null`: the workspace goes back to Pusher-notified runners (Coder, local). The Worker stays deployed |
| `--print-token` | Print the `DISPATCH_TOKEN` it set |
| `--url` | Worker base URL, for a custom domain |

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
| `api.anthropic.com` | Rewrites to `https://gateway.ai.cloudflare.com/v1/<AI_GATEWAY_ACCOUNT_ID>/<AI_GATEWAY_ID>/anthropic/...` and sets `cf-aig-authorization: Bearer <AI_GATEWAY_TOKEN>`. The Anthropic key lives in AI Gateway (BYOK) or Unified Billing. Unconfigured: `503`, never forwarded with the placeholder |
| `github.com` | `/<owner>/<repo>[.git]/...` of the task's repo: `Authorization: Basic base64(x-access-token:<token>)` (git over HTTPS) |
| `api.github.com`, `uploads.github.com` | `/repos/<owner>/<repo>/...` of the task's repo, and `api.github.com/graphql`: `Authorization: Bearer <token>` |
| `codeload.github.com`, and any other path on the hosts above | Nothing added |
| anything else | Not intercepted (open egress in phase 1) |

For every intercepted host the handler **first deletes** whatever the
container sent in `authorization`, `proxy-authorization`, `x-api-key`,
`anthropic-api-key`, `cf-aig-authorization`, `cookie` and URL userinfo, and
only then adds the Worker's credential. Plain HTTP and non-443 ports to these
hosts are refused (`403`). Upstream redirects are returned to the container
(`redirect: 'manual'`), so an injected credential never follows a redirect.

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
permissions a run needs. The agent keeps it in memory (never in storage, never
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
| `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID` | var | yes, for model calls | Cloudflare account and gateway ids |
| `AI_GATEWAY_TOKEN` | secret | yes, for model calls | AI Gateway authentication token |
| `ALLOW_DIRECT_ANTHROPIC` | var | no | **Local development only.** `1` together with `ANTHROPIC_DIRECT_API_KEY` sends model traffic straight to Anthropic with that key instead of the gateway. Default off. Never set it on a deployed Worker |
| `ANTHROPIC_DIRECT_API_KEY` | secret | no | **Local development only**, see above. Ignored unless `ALLOW_DIRECT_ANTHROPIC=1` |
| `DISPATCH_TOKEN` | secret | yes | Also authenticates the GitHub token request |

The container is started with `BUILDD_EXECUTOR=cloud`, so the claim response
carries no credential material (`CLAIM_CREDENTIAL_FIELDS` in
`packages/shared/src/executor.ts`: model credentials, Codex credentials, MCP
secrets and connectors, role env secrets, credential-refresh ids). Consequence
for phase 1: roles that need MCP connectors or role env secrets run without
them on the cloud runner.

`scripts/local-smoke.sh` checks the rewrite end to end: see its
"egress rewrite" step.
