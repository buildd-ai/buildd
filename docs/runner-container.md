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
(`apps/cloud-runner` does this, with `crashReconciled: true` so buildd retries
it on the infra-retry budget instead of failing the task). No line means no
worker was created.

With `BUILDD_EXECUTOR=cloud` the runner also prints
`BUILDD_PHASE=<phase> <epoch ms>` lines, `<phase>` one of `clone_start`,
`clone_end`, `install_start`, `install_end`, `restore_warm_start`,
`restore_warm_end`, `fetch_start`, `fetch_end`, `warm_upload_start`,
`warm_upload_end` (`apps/runner/src/phase-lines.ts`).
The clone pair brackets the runner's own `git clone`; the install pair
brackets its own `bun install` in the worktree (not an install a repo declares
in `.buildd/env.yaml`, which runs in the provision gate). The warm pairs
bracket the warm-repo restore, the `git fetch` after it, and the upload of a
new snapshot generation (see Warm repos below). Alongside them:
`BUILDD_METRIC=<name> <integer>` (`clone_bytes`, `restore_bytes`,
`fetch_bytes`, `cache_bytes`, `snapshot_age_ms`, `warm_upload_bytes`,
`warm_repo_bytes`), one `BUILDD_REPO_SOURCE=warm` or
`BUILDD_REPO_SOURCE=clone <reason>` line (`disabled`, `no_snapshot`,
`unavailable`, `disk`, `restore_failed`), and `BUILDD_WARM_UPLOAD=skipped
too_large` when a warm upload was due but the repo was over the cap (below).
No path or URL is printed. `apps/cloud-runner` reads them into its run report.

### Warm repos

With `BUILDD_WARM_REPO=1` and `BUILDD_SNAPSHOT_URL` (both set by the
`WorkerAgent` when its `WARM_REPOS` var is on), `apps/runner/src/warm-repo.ts`
restores the workspace's snapshot into the isolated clone path before any
`git clone`: a `git bundle` of origin's refs, then `origin` set to the real
URL with a fetch refspec for the default branch only (as narrow as the clone,
below), the default branch checked out, and a `git fetch origin` to close the
gap; plus the bun install cache (which also carries pnpm's content-addressable
store — `corepack enable` in the Dockerfile makes `pnpm` honour a task repo's
`packageManager` pin, and the runner points `npm_config_store_dir` at a
`pnpm-store` directory nested inside the bun cache dir, so it rides along in
the same cache tarball with no separate upload or metric). A pnpm store big
enough alone to push the cache tarball over the warm snapshot cap (below) is
left out of that run's upload — logged, never a crash — while the rest of the
cache still uploads. Any failure (no snapshot, store unreachable,
snapshot larger than a quarter of free disk, corrupt bundle) falls back to the
normal clone. After the run it uploads a new generation when the workspace had
none (whatever the outcome), or, after a task that completed, when the one it
restored was over 24 h old or its fetch brought in over 64 MiB. The bundle
carries remote refs only (no config, hooks, local branches or working tree),
the cache tarball leaves out `.npmrc`, `.netrc`, `.yarnrc*`, `bunfig.toml`
and `.env*` files, and the upload is refused when the clone has any
`credential.*` or `http.*.extraheader` config or a remote URL with userinfo.

Big repos. Before bundling, the runner measures the clone's object store
(`BUILDD_METRIC=warm_repo_bytes`) and skips the upload when it is over the cap,
`BUILDD_WARM_MAX_BUNDLE_BYTES` (set by the `WorkerAgent` from its
`WARM_MAX_BUNDLE_BYTES` var; default 1 GiB): it prints
`BUILDD_WARM_UPLOAD=skipped too_large`, takes no lock, and the workspace
clones every time. Under the cap, nothing is staged on disk or held whole in
memory: `git bundle create -` (one pack thread, bounded window memory) and
`tar -cf -` stream straight into an R2 multipart upload through the snapshot
route, 32 MiB per part, and a stream that outgrows the cap is cut off and the
upload aborted (also `too_large`).

### Clone shape and GitHub throttling

In a cloud container (`BUILDD_EXECUTOR=cloud`) the clone is as small as git
allows: `git clone --depth 1 --single-branch --branch <default branch>`
(`apps/runner/src/git-clone.ts`; the workspace's `gitConfig.defaultBranch`,
or the remote HEAD with plain `--single-branch` when it is not known or the
remote has no such branch). On a repo with thousands of branches and tags,
every branch at depth 50 is gigabytes and minutes; one branch at depth 1 is
seconds. The fetch refspec is narrowed to that branch, so a later
`git fetch origin` brings only it.

Every other `origin/<branch>` the runner needs is fetched on demand, by name,
at depth 50 (`ensureRemoteBranch`): `git fetch --depth 50 origin
+refs/heads/<branch>:refs/remotes/origin/<branch>`, retried on the clone's
policy, `missing` at once when the remote has no such branch. The sites:
`setupWorktree`'s base and resume candidates (a mission integration branch as
the declared base, a resume branch, the cascade from a missing resume branch
to the declared base), its stale-local-branch check (`origin/<task branch>`),
the PR base after setup when it is neither the base nor the default branch,
the path-claim base refresh (a depth only for a branch not yet there), PR
stats (`collectGitStats`, the ref the worktree was cut from), and a resumed
park, which fetches the worker's base refs recorded in the park manifest.
On a full (host) clone every one of these is a no-op: its `git fetch origin`
already brought every branch, so a host runner behaves as before.

In a shallow clone, the 50-commit divergence veto on a resume branch only
applies when the merge base with the default branch is in the clone; without
it the count runs to the shallow boundary and means nothing, so the branch is
resumed rather than silently replaced with a fresh one.

A warm snapshot of a shallow clone carries its boundary (the default branch
at depth 1 and every branch fetched on demand) as `refs/buildd/shallow/<commit>`
refs in the bundle, written back to `.git/shallow` on restore. A park bundle
excludes the clone's boundary commits as well as its base, so a boundary it
reaches becomes a prerequisite rather than a commit without parents; the
resuming clone fetches any prerequisite it lacks by id (`--depth=1`). Host
runners clone in full, as before.

A clone that GitHub throttles (HTTP 429, or a 403 that says "rate limit") is
retried after `Retry-After` (probed through the egress), with exponential
backoff when there is none, for at most 60 s of waiting; a `Retry-After`
longer than that stops at once. 401, a plain 403 and 404 are not retried. The
post-restore and resume fetches use the same policy with a 30 s budget. A
clone still throttled at the end is remembered for a minute (or the
`Retry-After`), so the resolver's fallback does not send the same request
again, and the worker is reported `failed` with `githubThrottled: true`:
buildd books it `infra_failure` and requeues it on the infra-retry budget
(5 / 15 / 30 min backoff, `infra_stalled` at the cap).

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
| `BUILDD_RUNNER_GROUP` | no | no | no | With `BUILDD_EXECUTOR=cloud`: the dispatcher deployment this run belongs to (the `WorkerAgent` sets it to the Worker name). Reported on the heartbeat (`environment.fleet`, `packages/shared/src/runner-fleet.ts`) so the dashboard fleet shows the deployment as one elastic group. Ignored off cloud. |
| `GH_TOKEN` | **yes** | local only | yes | Used by `gh` and, through `gh auth setup-git` in `buildd-once`, by `git` for https clones and pushes. **Do not set it on Cloudflare**: the egress handler adds a short-lived installation token to `github.com` / `api.github.com` requests. |
| `BUILDD_ONCE_MAX_WAIT_MS` | no | no | no | Maximum continuous wait for user input before the worker is aborted (exit 1). Default 6h. |
| `BUILDD_WORKSPACE_ISOLATION_ROOT` | no | no | no | Where the task repo is cloned. Default `<BUILDD_HOME>/once-workspaces`. |
| `BUILDD_WARM_REPO`, `BUILDD_SNAPSHOT_URL` | no | no | no | Warm repos (above). Set together by the `WorkerAgent` only when its `WARM_REPOS` var is `1`; the URL is the egress-intercepted pseudo-host `https://buildd-snapshots.invalid`. With them the isolated clone is tried before any local checkout. Unset: the runner clones as before. |
| `BUILDD_WARM_MAX_BUNDLE_BYTES` | no | no | no | Largest warm bundle or cache tarball uploaded (default 1 GiB); over it the upload is skipped (`BUILDD_WARM_UPLOAD=skipped too_large`). Set by the `WorkerAgent` from its `WARM_MAX_BUNDLE_BYTES` var. |
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
