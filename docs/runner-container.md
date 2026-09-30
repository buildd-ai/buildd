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
starts the run with `exec`, which is the Sandbox SDK pattern. `buildd-once`
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
| `BUILDD_API_KEY` | **yes** | yes | no | Runner API key, ideally scoped to one workspace. Missing: exit 64. |
| `BUILDD_SERVER` | no | yes | no | buildd base URL. Defaults to `https://buildd.dev` if unset, so always set it outside production. |
| `ANTHROPIC_API_KEY` | placeholder on Cloudflare; **yes** locally | yes | yes | On Cloudflare this is a dummy value. Claude Code needs *some* key to start, and the egress handler strips it and adds the real gateway credential. Setting it also stops the runner from injecting the server-managed API key (it only fills an unset variable). Locally, a real key works. |
| `ANTHROPIC_BASE_URL` | no | no | yes | Gateway endpoint. Leave it unset on Cloudflare if the egress handler rewrites `api.anthropic.com`. Set it to talk to a gateway directly. |
| `GH_TOKEN` | **yes** | local only | yes | Used by `gh` and, through `gh auth setup-git` in `buildd-once`, by `git` for https clones and pushes. **Do not set it on Cloudflare**: the egress handler adds a short-lived installation token to `github.com` / `api.github.com` requests. |
| `BUILDD_ONCE_MAX_WAIT_MS` | no | no | no | Maximum continuous wait for user input before the worker is aborted (exit 1). Default 6h. |
| `BUILDD_WORKSPACE_ISOLATION_ROOT` | no | no | no | Where the task repo is cloned. Default `<BUILDD_HOME>/once-workspaces`. |
| `MODEL`, `PUSHER_KEY`, `PUSHER_CLUSTER` | no | no | no | Same meaning as on a long-lived runner. Pusher only carries mid-run instructions and answers. The 10s sync covers them without it. |

On Cloudflare the model and GitHub credentials are **added at egress**, never
put in the container env. The only real secret in the env is
`BUILDD_API_KEY`.

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
- **`CLAUDE_CODE_OAUTH_TOKEN`**: not set in env. But if the team has a
  server-managed OAuth credential, the claim response still delivers it, and
  the runner writes it into the session's Claude config dir
  (`materializeClaudeConfigDir` in `workers.ts`). So a real credential can end
  up inside the container even though the env holds only a placeholder key.
  Which credential Claude Code then sends when a placeholder
  `ANTHROPIC_API_KEY` and a stored OAuth credential are both present has not
  been checked here. Before the canary, either stop delivering credentials to
  cloud-dispatched claims (a server change) or confirm that egress replaces
  whichever one is sent.
