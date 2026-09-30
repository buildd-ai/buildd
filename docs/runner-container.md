# Runner container (`--once` image)

`apps/runner/Dockerfile.once` builds a linux/amd64 image that runs one buildd
task per container through `buildd --once --task <id>`. It is the container
half of [the Cloudflare sandbox runner design](design/cloudflare-sandbox-runner.md)
(Components 2), and it also works on any Docker host.

## Build and run

```bash
# From the repo root
docker buildx build --platform linux/amd64 -f apps/runner/Dockerfile.once -t buildd-runner-once --load .

docker run -d --name once --platform linux/amd64 \
  -e BUILDD_API_KEY -e BUILDD_SERVER -e ANTHROPIC_API_KEY -e GH_TOKEN \
  buildd-runner-once                      # idles on `sleep infinity`
docker exec once buildd-once --task <task-id>
echo $?                                   # 0 / 1 / 3 / 64, see below
docker rm -f once
```

The container's main process is `sleep infinity` (under `tini`). The caller
starts the run with `exec`, which is the Sandbox SDK pattern. On Cloudflare,
`apps/cloud-runner`'s `WorkerAgent` does the same through
`ctx.container.exec(['buildd-once', '--task', id])`, which returns the exit
code directly. `buildd-once`
changes to the repo root (`/opt/buildd`) and runs
`bun run apps/runner/src/index.ts --once "$@"`.

Smoke test: `bash apps/runner/scripts/once-smoke.sh` builds the image and
checks the exit codes with `--network none`.

## What is in the image

| Component | Version source |
|---|---|
| Bun | base image `oven/bun:1.4.2-slim` (Debian, glibc) |
| git, ripgrep, ca-certificates, curl, tini | Debian packages |
| `gh` | `GH_VERSION` build arg, release tarball checked against a pinned SHA-256 |
| Claude Code | the native binary inside `@anthropic-ai/claude-agent-sdk-linux-x64`, pinned by `bun.lock` through the SDK version. This is the binary the runner spawns (`sdk-binary-path.ts`). No separate `@anthropic-ai/claude-code` install: a second copy would not be the one that runs. It is also linked as `/usr/local/bin/claude`. |
| Runner + `@buildd/core`, `@buildd/shared`, `@builddai/ai-kit` | baked in at build time, `bun install --frozen-lockfile --production --filter @buildd/runner` |

The image leaves out tests, migrations, the web app, Playwright browsers and
the codebase-memory binary. Tasks that need `browser` or CBM will not find them.

**User.** The image runs as the base image's `bun` user (uid 1000), not root.
Claude Code refuses bypass-permissions mode as root unless `IS_SANDBOX=1` is
set, and `IS_SANDBOX` is not on the runner's agent env allowlist
(`apps/runner/src/agent-env.ts`), so a root container would lose bypass mode
without saying so. As a non-root user the question does not come up.
`/opt/buildd` is root-owned and read-only to the agent.

**No self-update.** `--once` returns before the self-updater, update canary
and drain are built (`index.ts`), and the image sets
`BUILDD_DISABLE_AUTO_UPDATE=1` too. The runner code in the image is exactly
the code it was built from.

## Exit codes

From `apps/runner/src/run-once.ts`:

| Code | Meaning | Supervisor action |
|---|---|---|
| 0 | Task ran, worker finished `done` | none |
| 1 | Failed: session error, input wait timed out, task fetch failed (server unreachable or key rejected), transient server error | none. buildd's retry path decides |
| 3 | Claim refused: already taken, held, not eligible | do not retry |
| 64 | Usage: no `--task`, or no API key | fix the invocation |

Once the claim succeeds, the runner prints `BUILDD_WORKER_ID=<worker-id>` on
its own stdout line. A supervisor that only knows the task ID reads it so it
can mark the worker failed if the container dies before the runner reports
(`apps/cloud-runner` does this). No line means no worker was created.

With `BUILDD_EXECUTOR=cloud` the runner also prints
`BUILDD_PHASE=<phase> <epoch ms>` lines, `<phase>` one of `clone_start`,
`clone_end`, `install_start`, `install_end` (`apps/runner/src/phase-lines.ts`).
The clone pair brackets the runner's own `git clone`; the install pair
brackets its own `bun install` in the worktree (not an install a repo declares
in `.buildd/env.yaml`, which runs in the provision gate). No path or URL is
printed. `apps/cloud-runner` reads them into its run report.

A bad API key or an unreachable server exits **1**, not 64 or 3. The key is
present, so it is not a usage error. The task fetch fails before any claim is
made, so nothing was refused.

## Env contract

"Reaches agent" means the variable is on `RUNNER_ENV_PASSTHROUGH` in
`apps/runner/src/agent-env.ts` and gets through to the Claude Code subprocess.
Everything else stays in the runner process.

### Set by the caller

| Variable | Secret | Required | Reaches agent | Notes |
|---|---|---|---|---|
| `BUILDD_API_KEY` | **yes** | yes | no | On Cloudflare: a per-task token (`bldt_…`) the `WorkerAgent` mints for this one task at dispatch (`POST /api/runner/task-token`). It works only for this task's claim and its own worker's calls, expires within hours, and cannot read team credentials. The Worker's runner key never enters the container. Elsewhere: a runner API key, ideally scoped to one workspace. Missing: exit 64. |
| `BUILDD_SERVER` | no | yes | no | buildd base URL. Defaults to `https://buildd.dev` if unset, so always set it outside production. |
| `ANTHROPIC_API_KEY` | placeholder on Cloudflare; **yes** locally | yes | yes | On Cloudflare this is a dummy value. Claude Code needs *some* key to start, and the egress handler strips it and adds the real gateway credential. Setting it also stops the runner from injecting the server-managed API key (it only fills an unset variable). Locally, a real key works. |
| `ANTHROPIC_BASE_URL` | no | no | yes | Gateway endpoint. The `WorkerAgent` never passes it: on Cloudflare model traffic must go to `api.anthropic.com`, where the egress handler rewrites it to AI Gateway. Elsewhere, set it to talk to a gateway directly. |
| `BUILDD_EXECUTOR` | no | no (on Cloudflare) | no | `cloud` on Cloudflare, set by the `WorkerAgent`. The claim then sends `executor: 'cloud'` and the server omits every credential from the response (`CLAIM_CREDENTIAL_FIELDS` in `packages/shared/src/executor.ts`); the runner drops any that arrive anyway and does not start the credential broker. Unset (or `host`) on any other host. Any other value makes the claim fail with 400. Not baked into the image, so the image stays usable elsewhere. |
| `GH_TOKEN` | **yes** | local only | yes | Used by `gh` and, through `gh auth setup-git` in `buildd-once`, by `git` for https clones and pushes. **Do not set it on Cloudflare**: the egress handler adds a short-lived installation token to `github.com` / `api.github.com` requests. |
| `BUILDD_ONCE_MAX_WAIT_MS` | no | no | no | Maximum continuous wait for user input before the worker is aborted (exit 1). Default 6h. |
| `BUILDD_WORKSPACE_ISOLATION_ROOT` | no | no | no | Where the task repo is cloned. Default `<BUILDD_HOME>/once-workspaces`. |
| `MODEL`, `PUSHER_KEY`, `PUSHER_CLUSTER` | no | no | no | Same meaning as on a long-lived runner. Pusher only carries mid-run instructions and answers. The 10s sync covers them without it. |

On Cloudflare the model and GitHub credentials are **added at egress**, never
put in the container env. The only real secret in the env is
`BUILDD_API_KEY`, and on Cloudflare that is a per-task token scoped to the
container's own task and worker, not the runner key.
Model traffic can go to AI Gateway or to an
Anthropic-compatible proxy such as LiteLLM (`MODEL_PROXY_URL`, Worker-side
only; see `apps/cloud-runner/README.md`, "Model routes"); either way the
container sees only `api.anthropic.com` and the placeholder key.

### Baked into the image

| Variable | Value | Reaches agent | Why |
|---|---|---|---|
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | yes (added to the allowlist in this change) | No telemetry, error reporting or auto-update calls from Claude Code through the egress proxy. |
| `BUILDD_DISABLE_AUTO_UPDATE` | `1` | no | Belt and braces. `--once` never starts the updater anyway. |
| `BUILDD_DISABLE_SANDBOX` | `1` | no | No bubblewrap in the image. The container is the isolation boundary. It also skips the bwrap probe and turns off Claude Code's bwrap env scrub, which would fail every Bash call without namespaces. |
| `BUILDD_HOME` | `/home/bun/.buildd` | no (the agent gets its own throwaway home) | Runner state, outbox, clones. |
| `BUILDD_REPO_ROOT` | `/opt/buildd` | no | Where `buildd-once` runs from. |
| `HOME` | `/home/bun` | yes | |

### Deliberately not set

- **`IS_SANDBOX`**: not needed, because the image is non-root. It is also not
  on the agent allowlist, so setting it on the runner would do nothing.
- **`CLAUDE_CODE_OAUTH_TOKEN`**: not set in env, and with `BUILDD_EXECUTOR=cloud`
  not delivered any other way either. A host claim can carry the team's
  server-managed model credential, which the runner writes into the session's
  Claude config dir (`materializeClaudeConfigDir` in `workers.ts`). A cloud
  claim carries none (see `BUILDD_EXECUTOR` above), so the only model
  credential the container's traffic ever uses is the one the egress handler
  adds.

## Egress and TLS trust (Cloudflare)

The `WorkerAgent` routes the container's traffic for `api.anthropic.com`,
`github.com`, `api.github.com`, `uploads.github.com` and `codeload.github.com`
through its egress handler (`apps/cloud-runner/src/outbound.ts`). Every other
host has open egress. For HTTPS the platform re-signs the connection with a
per-container CA written to `/etc/cloudflare/certs/cloudflare-containers-ca.crt`
after start. `buildd-once` waits for it (when `BUILDD_EXECUTOR=cloud`) and sets:

| Variable | Value | For |
|---|---|---|
| `NODE_EXTRA_CA_CERTS` | the Cloudflare CA | Bun (the runner) and Claude Code |
| `SSL_CERT_FILE`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE` | `$TMPDIR/buildd-ca-bundle.pem` (system roots + the Cloudflare CA) | git, curl, gh, Python |

All are on the agent env allowlist, so the agent's own tools trust the CA too.
The combined bundle keeps non-intercepted hosts verifying against the normal
roots. Outside Cloudflare the CA file does not exist and nothing is set.
