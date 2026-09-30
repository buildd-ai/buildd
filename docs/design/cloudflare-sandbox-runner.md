---
status: proposed
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "runner-run-once"
    type: "symbol"
    name: "runOnce"
    path: "apps/runner/src/run-once.ts"
  - id: "cloud-worker-agent"
    type: "symbol"
    name: "WorkerAgent"
    path: "apps/cloud-runner/src/worker-agent.ts"
---
# Cloudflare Agents Runner

**Status:** Proposed
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
- `WorkerAgent` starts the container, runs `buildd --once --task <id>` with a
  minimal env (server URL, a runner API key scoped to the workspace, and the
  gateway base URL), and holds `keepAliveWhile` for the life of the process.
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
- `github.com`, `api.github.com` → adds `Authorization` with a short-lived
  GitHub App installation token scoped to the task's repo.
- Everything else passes through (open egress in phase 1). Allowlisting is a
  per-workspace follow-up.

**5. Server changes (small, additive).**
- The webhook payload gains structured fields (`taskId`, `workspaceId`,
  `backend`, `roleSlug`) alongside the existing `message`, so existing webhook
  consumers are unaffected.
- Retries and unblocked tasks must reach the webhook too. `dispatchUnblockedTask`
  already runs the same chain; the retry and budget-reset paths need an audit.
- A way to get a per-task GitHub installation token to the dispatcher (see
  Open questions).

### Opt-in and defaults

A workspace opts in by setting `webhookConfig` to the dispatcher URL. That
field and its exclusive-dispatch behaviour already exist. With no
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

Phase 2 is an R2 snapshot or warm clone cache if clone time dominates, and
sub-agent or long-task limits if the canary hits them. Phase 3 is a first-class
executor setting in the dashboard.

## Open questions

1. **GitHub token minting: server or Worker?** Either buildd mints a per-task
   installation token and hands it to the dispatcher on dispatch, or the Worker
   holds the GitHub App key and mints tokens itself. *Lean: server-minted.* The
   App key stays in one place, tokens are scoped per repo, and the container
   still never sees them because the outbound handler injects them.
2. **Container limits for long tasks.** Instance size, disk and maximum run
   duration against multi-hour tasks and large monorepo clones. *Lean: route
   only tasks expected to be short in phase 1, and measure before widening.*
3. **Runner API key for the container.** A workspace-scoped key per dispatcher
   is simplest. A per-task short-lived token is better. *Lean: workspace-scoped
   for the canary, and track per-task tokens as a follow-up.*
4. **Clone cost.** A fresh depth-limited clone per task may dominate short
   tasks. *Lean: measure in the canary before building a snapshot cache.*
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
