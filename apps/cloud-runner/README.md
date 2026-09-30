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
