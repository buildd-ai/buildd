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
| `BUILDD_API_KEY` | secret | yes | Runner API key passed to the container; also used for the crash report |
| `BUILDD_SERVER` | var | yes | No default: the Worker refuses to dispatch without it, because the runner would fall back to production |
| `ANTHROPIC_BASE_URL` | var | no | Passed through to the container |
| `MODEL`, `PUSHER_KEY`, `PUSHER_CLUSTER`, `BUILDD_ONCE_MAX_WAIT_MS` | var | no | Passed through, same meaning as on a long-lived runner |
| `CONTAINER_INACTIVITY_TIMEOUT_MS` | var | no | Default 30 min. A backstop: the agent holds keepAlive for the whole run |
| `CONTAINER_START_TIMEOUT_MS` | var | no | Default 5 min, for `ctx.container.running` after `start()` |

The container gets a placeholder `ANTHROPIC_API_KEY` and no GitHub token.
Egress credential injection (AI Gateway rewrite, GitHub installation token) is
the next step and hooks in at `WorkerAgent.installEgressHandlers`. Until then
a real task can claim and clone public repos but cannot call the model.

## Local development

Needs Docker. From this directory:

```bash
bunx wrangler dev --var DISPATCH_TOKEN:dev --var BUILDD_API_KEY:<key> --var BUILDD_SERVER:<dev server>
bash scripts/local-smoke.sh     # end-to-end check against an unreachable server
```

The first run builds the image for linux/amd64, which is slow on an arm64 host
(emulation).

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
