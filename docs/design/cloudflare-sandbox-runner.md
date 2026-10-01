---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# Components 1-4 have shipped (run-once, the image, apps/cloud-runner, the
# egress handler). The canary (implementation step 6) has not run.
# Phase 2: warm repos are built (behind WARM_REPOS); resumable runs are proposed.
assertions:
  - id: "runner-run-once"
    type: "symbol"
    name: "runOnce"
    path: "apps/runner/src/run-once.ts"
  - id: "cloud-worker-agent"
    type: "symbol"
    name: "WorkerAgent"
    path: "apps/cloud-runner/src/worker-agent.ts"
  - id: "cloud-egress-handler"
    type: "symbol"
    name: "EgressHandler"
    path: "apps/cloud-runner/src/egress.ts"
  - id: "cloud-snapshot-store"
    type: "symbol"
    name: "SnapshotStore"
    path: "apps/cloud-runner/src/snapshots.ts"
  - id: "runner-warm-repo"
    type: "symbol"
    name: "WarmRepoSession"
    path: "apps/runner/src/warm-repo.ts"
  - id: "cloud-canary-script"
    type: "test_file"
    path: "apps/cloud-runner/scripts/canary.sh"
---
# Cloudflare Agents Runner

**Status:** Partially implemented (Components 1-4; canary pending). [Phase 2](#phase-2-resumable-runs-and-warm-repos): warm repos built behind `WARM_REPOS`; resumable runs proposed.
**Related:** `apps/runner/src/workers.ts` (`WorkerManager.claimAndStart`), `apps/runner/src/workspace.ts` (`ensureIsolatedClone`), `apps/runner/src/agent-env.ts`, `apps/runner/src/pusher-manager.ts`, `apps/web/src/lib/task-dispatch.ts` (`dispatchNewTask`), `packages/core/db/schema.ts` (`WorkspaceWebhookConfig`), `docs/credentials-architecture.md`

> Revision note: the first draft of this doc (2026-07-07) proposed a
> `RunnerSubstrate` interface inside `apps/runner` plus a V8-isolate tier that
> ran the Claude Agent SDK without a container. Both are dropped; see
> [Rejected approaches](#rejected-approaches).

---

## Problem

Every buildd task runs on a long-lived Bun runner process on a host someone
provisions and keeps alive (a Coder workspace today). That has three costs for
teams adopting buildd:

1. **Fixed capacity.** The host bills 24/7 whether or not tasks are queued, and
   concurrency is capped by the host's size, not by the queue.
2. **Operator burden.** Someone owns the host: installs, updates, credentials on
   disk, restarts after a crash-loop. Runner deploys only reach hosts that pull
   a release.
3. **Weak isolation.** Concurrent workers share one process and one filesystem;
   isolation is bwrap on a shared host, and credentials live in the host's
   environment and home directory.

An organisation evaluating buildd wants "add a workspace, tasks run" with no
host to own, per-task isolation, and credentials that are never on a disk the
agent can read.

## Current state

- **Claiming is already client-agnostic.** Workers pull: `POST /api/workers/claim`
  (atomic, `NOT EXISTS` guarded), then report via `PATCH /api/workers/[id]`,
  heartbeats, and the MCP endpoint. The server does not care what process is on
  the other end.
- **Single-task claim already exists.** `WorkerManager.claimAndStart(task)`
  claims one explicit task ID (`claimTask(1, workspaceId, …, task.id, …)`); the
  background loop is `claimPendingTasks()`.
- **The runner can clone on demand.** `ensureIsolatedClone()` clones a
  workspace repo into a per-workspace isolation directory when no pre-clone
  exists.
- **Model credentials are server-managed** and delivered inline on the claim
  response. `ANTHROPIC_BASE_URL` is on the agent env allowlist
  (`agent-env.ts`), so the agent's model traffic can be pointed at a gateway
  without code changes.
- **Git push auth is host-provided.** `GITHUB_TOKEN` / `GH_TOKEN` are passed
  through from the runner's environment. There is no per-task GitHub token.
- **Push dispatch already exists.** `dispatchNewTask()` POSTs to a workspace's
  `webhookConfig.url` (bearer token) and, when that succeeds, **skips** the
  Pusher `TASK_ASSIGNED` broadcast. That makes webhook dispatch exclusive.
  The payload is shaped for a chat agent (`message`, `sessionKey`), and the
  task ID appears only inside the message text.
- **Commands mid-run** (`worker:command`: pause, user input, abort) reach the
  runner over its own Pusher subscription (`pusher-manager.ts`), which is an
  outbound WebSocket.
- **The runner is mostly policy** (~33k lines in `apps/runner/src`): prompt
  building, hook factory, PR-mutation and output-requirement enforcement, CBM,
  PR detection, the outbox, recovery, credential refresh. Any client that is
  not the runner has to reimplement or lose this.

## Proposal

Run the **existing runner, one task per container**, on Cloudflare. A
Cloudflare Agents SDK agent is the dispatcher and supervisor. Coder stays the
default. This is an additional executor that a workspace opts into.

```
buildd server ── dispatchNewTask ──webhook──▶ Dispatcher Worker (apps/cloud-runner)
                                                    │  idFromName(taskId)
                                                    ▼
                                          WorkerAgent (Agents SDK, Durable Object)
                                            - state: taskId, attempt, container status
                                            - keepAliveWhile(container running)
                                            - onRequest: status / abort
                                                    │  this.ctx.container
                                                    ▼
                                          Container: runner image
                                            `buildd --once --task <id>`
                                            claim → run Claude Code via Agent SDK
                                            → PATCH progress → push branch → PR → exit
                                                    │
                                   outbound handler (Worker) intercepts egress:
                                     api.anthropic.com → AI Gateway (+ gateway token)
                                     github.com / api.github.com → + installation token
```

### The crux

**The container runs the buildd runner, not a bare `claude --print`.**
Cloudflare's own coding-agent guides run `claude --print --output-format
stream-json` from the Durable Object and read back a diff. That is roughly a
week to demo, but it drops everything the runner enforces: prompt assembly,
hooks, PR and output-requirement gates, `waiting_input` round-trips (`--print`
takes no input mid-run), PR detection and the outbox. Rebuilding those in a
Worker is a second runner with its own drift. Running the runner in the
container keeps one implementation of policy, and the Cloudflare layer stays a
few hundred lines of lifecycle code.

If this is wrong (the runner cannot be made to start, run one task and exit
cleanly in a fresh container), the fallback is the `--print` harness for
artifact-only tasks. It is not a path for PR-producing tasks.

### Components

**1. Runner `--once` mode** (`apps/runner/src/run-once.ts`, `runOnce`).
`buildd --once --task <id>` starts with no local UI, no claim loop, no
self-updater and no terminal-worktree sweep. It calls the existing
single-task claim path, clones with `ensureIsolatedClone`, runs the session to
completion, flushes the outbox, and exits. The exit code maps to the outcome
(0 done, non-zero failed or retryable). A claim that is refused (already taken,
held, not eligible) exits cleanly with a distinct code, so the agent does not
retry it. This mode is useful on any host, not only Cloudflare.

**2. Runner container image.** Built from the same toolchain as the Coder
image: Bun, git, `gh`, ripgrep, and a pinned Claude Code version. The runner
source is baked in at release time and never self-updates in `--once` mode.
The entrypoint is `sleep infinity`, and the agent starts the runner through
the container API, which is the Sandbox SDK pattern.

**3. Dispatcher Worker and `WorkerAgent`** (`apps/cloud-runner`).
- `POST /dispatch` authenticates the buildd bearer token from
  `webhookConfig`, reads `taskId`, and routes to
  `getAgentByName(env.WorkerAgent, taskId)`. The name is the task ID, so a
  duplicate webhook reaches the same agent, and the agent ignores it while a
  run is live.
- `WorkerAgent` mints a per-task token for its task
  (`POST /api/runner/task-token`, with the dispatcher's runner key), starts
  the container, runs `buildd --once --task <id>` with a minimal env (server
  URL, that per-task token, and the gateway base URL), and holds
  `keepAliveWhile` for the life of the process. The runner key stays in the
  Worker and never enters the container.
  It sets the container inactivity timeout above the longest expected silent
  tool call.
- When the process exits, the agent records the outcome in its state and
  stops the container. It does **not** report to buildd itself; the runner
  already did. If the container dies without the runner reporting, the agent
  marks the worker failed via `PATCH /api/workers/[id]` so the task does not
  sit in `running` until stale detection catches it.
- **Safety bound:** the agent never re-dispatches. Retries go through buildd's
  existing retry path, which fires a new webhook. There is one container per
  agent and at most one live run per task ID.

**4. Egress credential injection** (the Worker's outbound handler).
- `api.anthropic.com` → rewritten to AI Gateway. The handler strips the
  placeholder `x-api-key` and sets `cf-aig-authorization`. The Anthropic key
  lives in AI Gateway (BYOK) or Unified Billing, never in the container.
  As built, an Anthropic-compatible proxy (LiteLLM and similar) can take the
  gateway's place: `MODEL_PROXY_URL` + `MODEL_PROXY_KEY` send model traffic
  there with `Authorization: Bearer` or `x-api-key`, and win over the gateway
  when set (README "Model routes").
- `github.com`, `api.github.com` → adds `Authorization` with a short-lived
  GitHub App installation token scoped to the task's repo.
- Everything else passes through (open egress in phase 1). Allowlisting is a
  per-workspace follow-up.
- As built: rules in `apps/cloud-runner/src/outbound.ts`, handler
  `EgressHandler` in `src/egress.ts`. The token comes from
  `POST /api/runner/github-token` (open question 1, server-minted), which
  also requires the workspace's dispatch token so the container cannot fetch
  it with its own API key. Cloud claims (`executor: 'cloud'`) carry no
  credential material at all (`packages/shared/src/executor.ts`).

**5. Server changes (small, additive).**
- The webhook payload gains structured fields (`taskId`, `workspaceId`,
  `backend`, `roleSlug`) alongside the existing `message`, so existing webhook
  consumers are unaffected.
- Retries and unblocked tasks must reach the webhook too. `dispatchUnblockedTask`
  already runs the same chain; the retry and budget-reset paths need an audit.
- As built: `webhookConfig.events` is an explicit opt-in (`task.created`,
  `task.unblocked`, `task.retry`). A webhook without it sees exactly what it
  saw before: new and unblocked tasks. Retries (`dispatchRetriedTask`, also
  used by the deferred-start sweep) need `task.retry`; approved-plan children
  (`dispatchPlanChildTask`) need `task.created` listed explicitly. Otherwise
  those paths send the Pusher `TASK_ASSIGNED` wake. `deploy.ts` lists all
  three. The retry and plan-child webhook legs skip held tasks and held or
  local-executor missions, and every webhook POST times out after 10 s and
  then falls back to Pusher.
- A way to get a per-task GitHub installation token to the dispatcher (see
  Open questions).
- Per-task runner tokens (`POST /api/runner/task-token`, resolved open
  question 3).

### Opt-in and defaults

A workspace opts in by setting `webhookConfig` to the dispatcher URL, with
`events` listing the dispatches it wants. That field and its
exclusive-dispatch behaviour already exist. Only owner/admin (or an admin API
key) can set it, through `PATCH /api/workspaces/[id]`. With no
`webhookConfig`, nothing changes. Coder runners that still list the workspace
can race-claim by polling; the claim is atomic, so this is safe, but a canary
workspace should not be listed on any Coder runner.

No schema change is required for phase 1. A first-class
`missions.executor = 'cloud'` or a per-role executor preference is phase 3,
once the path has proven itself.

### Neon wake windows

The dispatcher **never polls** buildd. It wakes only on webhook dispatch, so
an idle workspace costs no database wake-ups. Missed webhooks (a network
blip) are the accepted gap in phase 1. A low-cadence reconcile alarm is added
only if the canary shows real misses.

## Implementation sketch

Load-bearing piece first:

1. **Runner `--once`** with tests. Verify it on a normal host against a dev
   server before any Cloudflare work.
2. **Container image** that runs `--once` locally under Docker against a dev
   server, with egress to Anthropic and GitHub supplied by env for now.
3. **Structured webhook payload**, plus an audit that retry and budget-reset
   paths reach the webhook.
4. **`apps/cloud-runner`**: dispatcher Worker, `WorkerAgent`, container
   binding, lifecycle and the dead-container failure report.
5. **Outbound handler**: AI Gateway rewrite and GitHub token injection.
6. **Canary**: one opt-in workspace with a mix of artifact and small PR tasks.
   Compare completion rate, time to first progress (cold start plus clone), and
   cost per task against Coder.

Phase 2 is resumable runs and warm repos; see
[Phase 2](#phase-2-resumable-runs-and-warm-repos). Sub-agent or long-task
limits follow if the canary hits them. Phase 3 is a first-class executor
setting in the dashboard.

## Open questions

1. **GitHub token minting: server or Worker?** Either buildd mints a per-task
   installation token and hands it to the dispatcher on dispatch, or the Worker
   holds the GitHub App key and mints tokens itself. *Lean: server-minted.* The
   App key stays in one place, tokens are scoped per repo, and the container
   still never sees them because the outbound handler injects them.
2. **Container limits for long tasks.** Instance size, disk and maximum run
   duration against multi-hour tasks and large monorepo clones. *Lean: route
   only tasks expected to be short in phase 1, and measure before widening.*
3. **Runner API key for the container.** *Resolved: a per-task token, required
   before the canary.* The dispatcher Worker holds the runner key and, at
   dispatch, mints a short-lived token bound to its account and the one task
   (`POST /api/runner/task-token`, `apps/web/src/lib/task-token.ts`). The
   container gets only that token. It is accepted for the task's own claim, a
   read of that task, and its own worker's read, PATCH, heartbeat, MCP,
   artifact and PR calls; every other route refuses it, including the credential lease /
   refresh routes and the secrets list, which accept only keys a team
   owner/admin has flagged as long-lived host runners. The dispatcher's key
   does not need that flag.
4. **Clone cost.** A fresh clone per task may dominate short tasks. *Lean:
   measure in the canary before building a snapshot cache* (Phase 2, warm
   repos).
5. **Pusher from inside the container.** `pusher-js` in Node over outbound
   WebSocket should work unchanged. Confirm that commands mid-run arrive within
   the canary.

## Non-goals

- Migrating off Coder or changing Coder runner behaviour.
- A native agent loop inside a Durable Object (Agents SDK `Think`, codemode,
  V8 isolates) for any task type.
- Using the Durable Object for orchestration invariants (branch serialisation,
  dedup). Claim SQL stays authoritative.
- Codex in the container. The same image pattern should work, but it is out of
  phase 1.
- Egress allowlisting beyond credential injection.

## Rejected approaches

- **`RunnerSubstrate` interface inside `apps/runner`** (first draft). If an
  always-on runner provisions remote sandboxes, the always-on host remains; if
  a Cloudflare Worker claims instead, an interface inside the runner is never
  used. `--once` gets the same swappability without the abstraction.
- **V8-isolate tier running the Claude Agent SDK.** The Agent SDK spawns the
  Claude Code CLI as a subprocess, and isolates cannot spawn subprocesses. An
  isolate tier means a new agent engine, which is out of scope.
- **Driving `claude --print` from the Durable Object.** See [The crux](#the-crux).
- **Alarm-based claim polling from the Durable Object.** Keeps the database
  awake. Push dispatch already exists.
- **Adopting `claude-managed-agents` wholesale.** Its lifecycle is driven by
  Claude Platform sessions, not buildd's claim → run → PR → complete lifecycle.

---

## Phase 2: resumable runs and warm repos

**Status:** Warm repos are built (`apps/runner/src/warm-repo.ts`,
`apps/cloud-runner/src/snapshots.ts`) behind the Worker var `WARM_REPOS`,
default off. Resumable runs are built (`apps/runner/src/park.ts`,
`apps/web/src/lib/worker-park.ts`) behind the Worker var `RESUMABLE_RUNS`,
default off. Every new behaviour ships behind
a Worker var that defaults off, so merging any slice changes nothing until a
workspace opts in.

> **As built (warm repos), where it differs from the text below.**
> - Keys put the kind first: `warm/<workspaceId>/<generation>/…` (and
>   `park/<workspaceId>/<workerId>` for resume), not `ws/<workspaceId>/warm/…`.
>   R2 lifecycle rules match a literal prefix, so `ws/*/warm/` cannot be
>   expressed; `warm/` can.
> - A generation is `repo.bundle` + optional `bun-cache.tar` + a
>   `manifest.json` written last (the commit). The in-flight guard is a lock
>   object taken with a conditional put (create-only, or replace one older
>   than 30 minutes), not a conditional put on the generation key.
> - The bundle is `git bundle create --remotes` (origin's refs only), not
>   `--all`: local branches in the base clone can hold a task's unpushed work.
> - The restore runs `git fetch origin` itself (timed as `fetch`), rather than
>   leaving it to `setupWorktree`, so the report can show the fetch delta.
> - A workspace with no usable snapshot (none, or a corrupt one) is seeded
>   after any run, not only a successful one: the bundle holds origin's refs
>   only, so it does not depend on the outcome. Refreshing an existing
>   generation (age over 24 h or fetch over 64 MiB) still needs success.
> - With warm repos on, `--once` tries the isolated clone before any other
>   checkout (`createOnceResolver`'s `preferIsolated`); otherwise the base
>   resolver's auto-clone would bypass the restore.

> **As built (resumable runs), where it differs from the text below.**
> - The park marker is its own route, `POST /api/workers/[id]/park` (the
>   server picks `parkedUntil`), with `DELETE` for the restore-failure path,
>   rather than a field on the worker PATCH.
> - `parkedUntil` is park time + 24 h, or 4 h for a mission task. A park also
>   bumps `updatedAt`, so the `waiting_input` sweep's clock restarts with it;
>   3 parks bound the total.
> - Park and re-attach accept `running` as well as `waiting_input`: an orphan
>   park (below) leaves the worker `running`.
> - Orphan recovery execs `buildd-once --park-orphan <worker>` into the
>   container that outlived its agent. That stops every other process of the
>   image user except init's first child (the image's `sleep infinity`), and
>   parks from disk. The agent then resumes the worker at once, with no answer
>   to wait for, and the resumed session gets a short "the platform restarted"
>   prompt. Three details the local smoke forced:
>   - The park runs after `onStart` returns, not inside it. `onStart` holds the
>     object's input gate, and the upload calls back into the agent for its
>     snapshot scope, so awaiting the park there deadlocks.
>   - The agent re-installs egress before the exec, because the interception
>     belonged to the agent that was restarted.
>   - The agent marks the park (`POST /park`), not the container. Under
>     `wrangler dev` a container that survives a reload keeps its intercepted
>     hosts but loses plain egress. Whether production behaves the same is
>     unverified.
> - Uncommitted work is captured as a commit built from a temporary index
>   (untracked files included), not `git stash create`, which skips
>   untracked files.
> - The park count lives in `<BUILDD_HOME>/parks/<id>.json` and travels in
>   the bundle, so every later container sees the same bound.
> - The running-staleness and silent-start arms of `staleWorkerScope` skip a
>   live park too, not only `heartbeatOrphanScope`.

### Problem

Two costs that phase 1 accepts, and that an evaluation has to price:

1. **Every task pays a full clone and a cold install.** `ensureIsolatedClone`
   (`apps/runner/src/workspace.ts`) runs a plain `git clone <url>`, with no
   depth limit, into an empty container. `setupWorktree`
   (`apps/runner/src/git-operations.ts`) then runs `git fetch origin`,
   `git worktree add` and a per-worktree `bun install`. The image deletes the
   bun cache at build time (`apps/runner/Dockerfile.once`), so every install
   downloads everything.
2. **A parked question holds a container, or loses the session.** In `--once`,
   `waitForOutcome` (`apps/runner/src/run-once.ts`) keeps the process, and so
   the container, alive for up to `BUILDD_ONCE_MAX_WAIT_MS` (default 6 h) while
   the worker sits in `waiting`, then aborts it and exits `EXIT_FAILED`. Any
   crash, eviction or redeploy in that window loses the transcript and any
   uncommitted work, because the container disk is gone: "When an instance
   stops, all disk contents are lost unless explicitly saved" ([Lifetime]).

### Current state

**What the cloud runner does today.**
- `WorkerAgent` (`apps/cloud-runner/src/worker-agent.ts`) uses the raw
  `this.ctx.container` API. `TaskSupervisor.run` (`src/supervisor.ts`)
  destroys any leftover container, installs egress interception, `start()`s a
  fresh one, `exec`s `buildd-once --task <id>` (`runnerCommand` in
  `src/lifecycle.ts`), and holds `keepAliveWhile` until the process exits.
  The main process is `sleep infinity` under `tini`.
- Outcomes come from exit codes (`outcomeForExitCode`): 0 done, 1 failed,
  3 refused, 64 usage, anything else crashed. The worker ID comes from the
  runner's `BUILDD_WORKER_ID=` line (`parseWorkerIdLine`).
- `finish` always destroys the container. After a crash with a known worker
  ID, `reportCrashIfNeeded` PATCHes the worker `failed`. `recoverOrphan` treats
  a run that was live when the Durable Object restarted as crashed.
- The agent is named by task ID, and `decideDispatch` ignores a dispatch
  while a run is `starting` or `running`.
- Egress (`src/outbound.ts`, `src/egress.ts`) intercepts named hosts only. The
  container holds `BUILDD_API_KEY` and a placeholder model key, and nothing
  else (`buildContainerEnv`). The clone URL carries no token, because the
  token is added at egress.

**How the runner resumes a session.**
- The Claude session ID is captured from the SDK `init` message into
  `worker.sessionId` and saved at once (`storeSaveWorker`, `workers.ts`).
  `worker-store.ts` persists the worker record (`PERSISTED_FIELDS`: `sessionId`,
  `codexThreadId`, `waitingFor`, `worktreePath`, `branch`, messages and so on)
  to `<BUILDD_HOME>/workers/<id>.json`, with a 24 h activity TTL.
  `history-store.ts` is an archive of *finished* sessions (SQLite plus gzip)
  and plays no part in resume.
- The transcript itself belongs to Claude Code, under its config directory
  (`~/.claude` unless `CLAUDE_CONFIG_DIR` is set), keyed by the session's cwd.
  A cloud claim carries no Claude credential, so no per-worker
  `CLAUDE_CONFIG_DIR` is materialised (`claude-auth.ts`), and the transcript
  lands under `HOME=/home/bun`.
- Resume is `RecoveryManager.resumeSession` (`recovery.ts`): layer 1 passes
  `resume: sessionId` (Claude) or `resumeThreadId` (Codex) to a new session in
  the preserved worktree; layer 2 restarts with a text reconstruction.
  `sendMessage` (`workers.ts`) takes this path for a `waiting` worker with no
  live session. `startSession`'s `finally` keeps the worktree for a `waiting`
  worker.
- **A different process can resume, but only on the same disk and not in
  `--once`.** A restarted host runner calls `restoreWorkersFromDisk`
  (`worker-sync.ts`), which keeps `waiting` workers answerable. The
  `WorkerManager` constructor skips that restore when `config.singleTask` is
  set, so `buildd --once` cannot pick up a parked worker today, even from a
  restored disk.

**What the server does with retries and answers.**
- The claim route (`apps/web/src/app/api/workers/claim/route.ts`) always
  inserts a new worker row, and only when no worker of the task is in
  `idle`, `running`, `starting` or `waiting_input`. A claim never attaches to
  an existing worker.
- Auto-retry (`PATCH /api/workers/[id]`, `shouldAutoRetry`) resets the same
  task to pending and calls `dispatchRetriedTask`, which fires `task.retry` to
  the webhook. The dispatcher routes it to the same agent (same task ID) as
  attempt + 1, and a new claim creates a new worker.
- "Retries continue on the same branch" means `tasks.context.resumeBranch`.
  `setupWorktree` reuses that branch only if it exists on `origin`, and falls
  back to a fresh cut otherwise (`describeWorktreeFallback`). Committed and
  pushed work carries over. Uncommitted work and the transcript do not.
- An answer to a parked question goes through `evaluateAnswerPath`
  (`apps/web/src/lib/answer-resume.ts`). `resume` queues the answer on the
  same worker's `pendingInstructions` for the runner to drain. Otherwise a
  `cold_continuation` supersedes the worker and inserts a **new task**
  (`buildContinuationTaskValues`, title `Continue: …`) with `resumeBranch`. G2
  requires the worker's `updatedAt` within `RESUME_RUNNER_FRESH_MS` (90 s),
  which a sleeping container can never meet.
- **Gap found while writing this:** neither cold-continuation insert
  (`app/api/workers/[id]/respond/route.ts`, `cleanupUnresumedAnswers` in
  `lib/stale-workers.ts`) calls any dispatch function. Polling runners find
  the new task. A webhook-only workspace never receives it, so on the cloud
  runner an answer that goes cold currently strands the work. This needs
  fixing whatever Phase 2 decides.
- A parked worker whose container is gone is not safe for long either:
  `failWorkersOfOfflineRunner` fails every live-status worker of an account
  (including `waiting_input`) once the account has no fresh runner heartbeat
  for `RUNNER_STALE_CUTOFF_MS`, and `cleanupStuckWaitingInput` retires
  `waiting_input` after 24 h (4 h for mission tasks).

**What Cloudflare offers.**
- Container disk is ephemeral. The next instance starts from its image
  ([Lifetime]). `setInactivityTimeout` is capped at 6 h ([Container API]).
- **Sandbox SDK directory backups** (`createBackup` / `restoreBackup`)
  squashfs a directory into R2 and, in production, mount it as a
  copy-on-write overlay (FUSE overlayfs). The mount is gone when the
  container stops. `ttl` defaults to 3 days and is "enforced at restore time
  only"; expired objects stay in R2 until a lifecycle rule removes them. The
  production path needs R2 S3 credentials on the Worker (presigned URLs). Under
  `wrangler dev` with `localBucket: true` the archive is extracted with
  `unsquashfs`, with no overlay. Renames across overlay layers can fail with
  `EXDEV` (their example is a `node_modules` cache directory)
  ([Backups], [Backups API]). The SDK needs its `/sandbox` control server as
  the image entrypoint, version-matched to the npm package ([Sandbox image]).
- **Native container snapshots, on the raw API we already use.**
  `ctx.container.snapshotContainer()` captures "the writable root filesystem
  of a running container" (no memory or processes), and
  `start({ containerSnapshot })` restores it in place of `image`. Handles live
  30 days, refreshed on restore, with a 20 GB maximum. This is "only supported"
  under `scheduling_policy: "durable_object"` (beta), which drops
  `max_instances` and image rollouts ([Container API], [Scheduling],
  [Limits]). workers-types 5.20260930 also declares an experimental
  `snapshotDirectory` plus `directorySnapshots` start option. It is not in the
  public docs yet.
- Disk per instance tops out at 20 GB (`standard-4`); we run `standard-1`
  (8 GB) ([Limits]). R2 lifecycle rules expire objects by prefix and age,
  typically within 24 h of expiry ([R2 lifecycle]). A single-part R2 upload
  is capped at about 5 GiB ([R2 limits]).

### The crux

**Adopt the Sandbox SDK for backups, or build snapshots against R2
ourselves?** *Decision: do not adopt the SDK. Build a Worker-mediated R2
snapshot store on the raw container API, and keep native
`snapshotContainer` as the measured alternative for resume.*

Reasons:
- **The SDK is a runtime swap, not a feature.** Its entrypoint replaces
  `tini` + `sleep infinity`. Its control server becomes a second exec
  transport beside `ctx.container.exec`. Its Durable Object class would
  displace or wrap `WorkerAgent`, which today is `Agent` plus the tested
  `ContainerPort` seam in `supervisor.ts`. Egress interception, orphan
  recovery and crash reporting would all need re-proving against it.
- **Credentials.** Production backups need R2 S3 keys on the Worker and hand
  the container presigned URLs. A Worker-mediated store needs only an R2
  binding. The Worker, not the container, chooses every object key, so a
  compromised container can neither name another workspace's snapshot nor
  hold a URL to one.
- **The part we would lose is measurable.** The SDK's advantage is lazy
  copy-on-write restore. If the evaluation shows restore time dominating, the
  store sits behind one interface (below) and the SDK or native directory
  snapshots can replace it without touching the runner.
- **One mechanism for both capabilities, runnable in `wrangler dev`.** R2
  bindings and egress interception both work locally today
  (`scripts/local-smoke.sh` exercises the interception).

What breaks if this is wrong: restore is a download plus extract rather than a
mount. For a very large repo that could cost more than a clone. The test plan
measures exactly this before anything is widened.

**Mechanism.** A reserved pseudo-host (for example `buildd-snapshots.invalid`)
is added to `INTERCEPTED_HOSTS`. `EgressHandler` serves `PUT` / `GET` on it and
streams bodies to and from an R2 binding. The key is built from the agent's own
identity, never from the request path: `ws/<workspaceId>/warm/<generation>` and
`ws/<workspaceId>/park/<workerId>`. `workspaceId` comes from buildd (added to the
`/api/runner/github-token` grant, which is already authenticated with the
dispatch token), not from the container or the webhook body. The runner uses
plain `curl`. In code this is a `SnapshotStore` port beside `ContainerPort`, so
a Sandbox-backup or native-snapshot implementation can replace it.

### Warm repos

| Option | Freshness | Restore cost | Security / tenancy | Verdict |
|---|---|---|---|---|
| (a) Sandbox `createBackup` of clone + bun cache | Refresh job re-snapshots | Lazy CoW mount (prod), extract (local) | R2 S3 keys on the Worker; presigned URL in the container | Only if (b) restore dominates; needs the SDK (crux) |
| (b) `git bundle` + bun-cache tarball in R2, via the Worker | `git fetch` after restore; refresh on age or fetch delta | Download + extract | Binding only; Worker-chosen keys | **Recommended** |
| (c) Warm per-workspace container, a worktree per task | Always warm | None | Tasks share a disk and a process tree, the phase 1 weakness this design exists to remove; one container's egress token would span tasks | Rejected |
| (d) Baked into the image | Stale per release | None | Repo contents in an image registry; one image per workspace against a 50 GB account image cap ([Limits]) | Rejected |

**Recommendation: (b).**
- **Contents.** `git bundle create --all` of the clone, plus a tar of
  `~/.bun/install/cache`. A bundle rather than a tar of `.git` on purpose: it
  carries objects and refs but no `config`, hooks or credential helpers, so a
  restored snapshot cannot run code at checkout or redirect a remote. No
  `node_modules`: worktree installs link from the warm cache, which also
  avoids the overlay `EXDEV` problem entirely.
- **Restore.** `ensureIsolatedClone` gains one branch before `git clone`: if
  the store has a warm snapshot, `git clone <bundle>`, set `origin` to the real
  URL, and extract the cache. `setupWorktree`'s existing `git fetch origin`
  closes the gap. A missing or unreadable snapshot falls back to today's clone.
  The snapshot is a cache and is never required.
- **Refresh.** After a task succeeds, the runner uploads a new generation if
  the current one is older than a set age (lean: 24 h) or its post-restore
  fetch exceeded a byte threshold. Only one refresh per workspace is in flight
  (a conditional R2 put on the generation key). No cron and no alarm, so an idle
  workspace costs nothing (see [Neon wake windows](#neon-wake-windows)).
- **Disk.** The snapshot plus extracted clone must fit the instance disk
  alongside the worktree: 8 GB on `standard-1`, 20 GB at most. The runner
  skips the warm path and logs why when the bundle size recorded in object
  metadata exceeds a fraction of free disk.
- **Retention.** Keep the latest two generations per workspace, deleted by the
  refresher, plus an R2 lifecycle rule on `ws/*/warm/` at 14 days as a
  backstop. Cost is R2 storage for one or two archives per active workspace.
  Egress from R2 is free.
- **Security.** The container holds no credential by design (Components 4),
  so a snapshot of its repo and package cache has none to capture. Keep it
  that way: the uploader refuses a bundle whose clone has `credential.*`
  config or an `https://…@` remote. Private-registry tokens mapped on a role
  reach `bun install` as env (`resolveWorkerRoleEnv`) and are never written
  to the cache. A test asserts that.
- **Tenancy.** Keys are per workspace under a prefix only the Worker writes.
  They are never shared across workspaces or teams, even for the same repo:
  two teams' clones of one repo may differ in private refs.

### Resumable runs

**When to snapshot ("park").**
- **Entering `waiting_input` with no live session** (an `AskUserQuestion`
  ending the SDK loop). This is the main case. A permission prompt keeps a
  live session blocked in a hook, so it is not parked and keeps today's
  behaviour.
- **Orphan recovery.** `recoverOrphan` currently destroys a container that is
  still running after a Durable Object restart (deploy, eviction). If
  `container.running`, it parks first, then destroys. That covers planned
  redeploys without a separate drain step.
- Not on inactivity: the raw API gives the agent no callback before the
  platform stops an idle container (`onActivityExpired` belongs to the
  `@cloudflare/containers` class, which we do not use). The agent holds
  `keepAliveWhile` for the whole run anyway.
- Not periodically in phase 2. Checkpoint cadence is an open question.

**What a park bundle holds** (small by design; the warm snapshot supplies the
rest):
- the task branch as a `git bundle`, plus uncommitted changes as a commit
  from `git stash create` under a private ref, so the working tree is not
  touched;
- the Claude Code transcript for `worker.sessionId` (or the Codex home for
  `codexThreadId`);
- the worker record `<BUILDD_HOME>/workers/<id>.json` and the task's outbox
  file.

It excludes `node_modules`, the rest of `BUILDD_HOME`, and anything under
`CLAUDE_CONFIG_DIR` other than the transcript. Paths are restored to the same
absolute locations, because the transcript is keyed by cwd and the record
stores `worktreePath`.

**Park flow.**
1. The runner, started with `BUILDD_ONCE_PARK=1`, sees its worker `waiting`
   with `!hasLiveSession`. It flushes (`flushToServer`, outbox), uploads the
   park bundle, and PATCHes the worker with a park marker (server change
   below).
2. It prints `BUILDD_PARKED=<workerId>` and exits with a new code
   `EXIT_PARKED` (4, mirrored in `lifecycle.ts` and pinned by
   `lifecycle.test.ts` as the others are).
3. The supervisor records `outcome: 'parked'` and destroys the container. A
   parked outcome is not a crash, so no failure report is sent.

**Resume flow (the `waiting_input` round trip).**
1. The user answers. `evaluateAnswerPath` sees the park marker, treats it as a
   holder of the transcript in place of G2's 90 s freshness, and takes the
   existing `resume` path: the answer queues on the **same worker's**
   `pendingInstructions`.
2. The server fires a new webhook event `task.resume` (opt-in through
   `webhookConfig.events`, like `task.retry`) carrying `taskId` and `workerId`.
3. `decideDispatch` gains a resume branch: same agent (task ID), and only when
   the run is `exited` with `outcome: 'parked'` for that worker. It starts a
   container, restores warm then park, and execs
   `buildd-once --resume-worker <workerId>`.
4. `--resume-worker` loads that one record (the single-worker form of
   `restoreWorkersFromDisk`), calls a new re-attach endpoint, and lets the
   normal 10 s sync drain `pendingInstructions` into `sendMessage` →
   `resumeSession`. Layer 1 resumes the transcript. Layer 2 still covers a
   corrupt one.
5. On success the runner clears the park marker and deletes the bundle, and
   the run continues as a normal `--once` run.

**Minimal server change** (one nullable column; generated migration):
- `workers.parkedUntil` (timestamp). It is set by the runner's park PATCH and
  cleared by re-attach or expiry.
- `evaluateAnswerPath`: `parkedUntil > now` satisfies G2. G3 still requires
  `supportsInstructionAck`.
- `POST /api/workers/[id]/reattach`: an atomic `UPDATE … SET parkedUntil =
  NULL, updatedAt = now() WHERE id = $1 AND status = 'waiting_input' AND
  parkedUntil > now() AND account_id = <caller> RETURNING *`. Zero rows means
  refused (exit 3). This is the only way a second process takes over a worker,
  and it never creates a row, so the claim route's live-worker guard keeps
  meaning "one live run per task".
- `failWorkersOfOfflineRunner` and the heartbeat-orphan scope skip rows with
  `parkedUntil > now`. Without that, a cloud-only account with no live
  container fails every parked worker once its heartbeat goes stale.
- `dispatchResumedTask` in `task-dispatch.ts`, beside `dispatchRetriedTask`.
- Separately, and needed with or without Phase 2: dispatch the cold
  continuation task (`dispatchRetriedTask` or `dispatchNewTask` after both
  inserts noted in Current state).

A new worker carrying `resumeFrom` was the alternative. It was rejected
because it splits turns, cost and the feed across two rows, which is exactly
what `answer-resume.ts` exists to avoid, and because it needs the claim guard
to exempt the prior worker.

**Safety bounds.**
- **Never two live runs per task.** The parked worker stays `waiting_input`,
  so the claim route refuses any fresh claim. Re-attach is a single
  conditional UPDATE. The agent's check-and-set in `decideDispatch` covers
  duplicate `task.resume` webhooks.
- **Snapshot TTL.** `parkedUntil` = park time + min(24 h, the task's
  `waiting_input` timeout: 24 h standalone, 4 h mission). A lifecycle rule on
  `ws/*/park/` at 2 days is the storage backstop. Once it expires, the
  existing `cleanupStuckWaitingInput` path takes over unchanged.
- **Max resume attempts.** At most 3 parks per worker, counted in the worker
  record. The 4th `waiting` holds the container as today
  (`BUILDD_ONCE_MAX_WAIT_MS`).
- **Restore failure.** If the park bundle is missing, corrupt or fails to
  apply, the runner does not re-attach. It clears `parkedUntil`, exits, and
  leaves the queued answer unacknowledged. The existing
  `cleanupUnresumedAnswers` sweep then degrades it after
  `RESUME_ACK_DEADLINE_MS` (10 min) into the cold continuation it would have
  been: a fresh run on `resumeBranch` from the last pushed commit, with the
  answer text carried forward. Only an unpushed WIP commit is lost. The same
  10-minute deadline bounds a slow cold start, so the resume must acknowledge
  within it.

### Test plan

Local, under `wrangler dev` with task containers on Docker (`scripts/local-e2e.sh`):
- **Store.** A miniflare R2 binding backs `SnapshotStore`. Unit tests (Bun,
  runtime-free like `outbound.test.ts`) cover key derivation (the container
  cannot choose a key), refusal of `credential.*` config, and the size guard.
- **Warm.** Run the same task twice. The second run must log a warm restore,
  do no full `git clone`, and add no bytes to the bun cache download.
- **Park/resume.** Seed a task that asks one question (as
  `seed:waiting-input` does). Assert exit 4 and a destroyed container, then
  answer through `/respond` and assert `task.resume` arrives, the same worker
  ID resumes, and layer 1 (not layer 2) appears in the session log.
- **Failure paths.** Delete the park object before answering: the worker goes
  `failed`, and a retry runs on `resumeBranch`. Send duplicate `task.resume`:
  one run. Make the heartbeat stale: the parked worker survives.
- **What local cannot prove.** Sandbox backups restore by extraction locally,
  not overlay. Native `snapshotContainer` support in `wrangler dev` is not
  documented, so treat it as unavailable locally until tried. Timings on
  local Docker say nothing about production. Every timing number comes from a
  real account.

On a real account (the canary workspace):
- warm restore against cold clone: wall time and bytes for clone, fetch and
  install, per repo size;
- resume success rate: parked resumes that reach layer 1, layer 2, or the
  fresh-run fallback;
- gap time: answer to first resumed progress event, against today's
  cold-continuation start;
- snapshot sizes and R2 storage per workspace.

These become phase timings (`restore_warm`, `fetch`, `install`, `park`,
`restore_park`) and counters (`warm_hit`, `resume_layer`) in the per-run
report artifact that the cloud runner is gaining in parallel, so the
comparison is read from reports, not logs.

### Open questions

1. **Native `snapshotContainer` for park instead of a bundle?** It captures
   everything with no file selection, and restores without an image. But it
   needs the beta `durable_object` scheduling policy, which drops
   `max_instances` (our only container cap; buildd's `maxConcurrentWorkers`
   bounds only claimed runs). It pins the runner version inside the
   snapshot. It captures the whole disk, so any file the agent wrote is in
   it. Retention is Cloudflare-managed. *Lean: no for phase 2. Revisit if
   park-bundle resume rates fall short.*
2. **Periodic checkpoints for long tasks.** They would bound crash loss, but
   each one costs an upload and a flush. *Lean: none until the canary shows
   crash loss mid-task.*
3. **Refresh trigger for warm snapshots.** Age, fetch delta, or every N
   tasks. *Lean: age or fetch delta, whichever comes first; N tasks is a
   proxy for both.*
4. **Is `snapshotDirectory` the better warm-repo primitive once
   documented?** A mounted per-workspace directory snapshot would make
   restore free. *Lean: track it; the `SnapshotStore` seam is where it would
   go.*
5. **Can the egress handler stream multi-GB bodies to R2?** Outbound
   interception is not an inbound Worker request, but that is unverified.
   *Lean: measure with the largest canary repo; fall back to R2 multipart
   from the Worker if single-part limits bite.*
6. **Retention for a workspace that leaves the cloud executor.** *Lean:
   `deploy.ts --remove` deletes `ws/<id>/`; lifecycle rules catch the rest.*

### Non-goals

- Resuming a live process or memory. Only disk state is restored, and a
  resumed session is a new Claude Code process on the old transcript.
- Parking permission prompts or a worker with a live session.
- Sharing warm snapshots across workspaces or teams, or any cross-tenant
  deduplication.
- Changing Coder or host runner behaviour. `--resume-worker` and the warm
  path are inert without the new env and store.
- Adopting the Sandbox SDK runtime, the `durable_object` scheduling policy,
  or native container snapshots in phase 2.
- Putting any credential in a snapshot. There is none in the container to
  capture.

### Sources

[Backups]: https://developers.cloudflare.com/sandbox/concepts/backup-restore/
[Backups API]: https://developers.cloudflare.com/sandbox/api/backups/
[Lifetime]: https://developers.cloudflare.com/sandbox/concepts/lifetime/
[Sandbox image]: https://developers.cloudflare.com/sandbox/configuration/dockerfile/
[Container API]: https://developers.cloudflare.com/containers/api/durable-object-container/
[Scheduling]: https://developers.cloudflare.com/containers/configuration/scheduling-policy/
[Limits]: https://developers.cloudflare.com/containers/platform/limits/
[R2 lifecycle]: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
[R2 limits]: https://developers.cloudflare.com/r2/platform/limits/

- Sandbox SDK directory backups: [Backups], [Backups API]
- Sandbox lifetime and disk: [Lifetime]
- Sandbox image requirements: [Sandbox image]
- Durable Object container API (`snapshotContainer`, `setInactivityTimeout`): [Container API]
- Scheduling policies: [Scheduling]
- Instance disk and snapshot limits: [Limits]
- R2: [R2 lifecycle], [R2 limits]
