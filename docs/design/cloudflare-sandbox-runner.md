# Cloudflare Sandbox Runner — Design Spec

> **Status:** Proposed — awaiting approval before any implementation begins.
> **Scope:** Spec only. No implementation. Evaluates Cloudflare as a second runner substrate alongside Coder.

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Substrate Interface Definition](#2-substrate-interface-definition)
3. [Lifecycle Architecture](#3-lifecycle-architecture)
4. [Git / Worktree Strategy](#4-git--worktree-strategy)
5. [Credential Strategy](#5-credential-strategy)
6. [Isolate Routing Policy](#6-isolate-routing-policy)
7. [Limits & Risks](#7-limits--risks)
8. [Cost Analysis](#8-cost-analysis)
9. [Phased Rollout](#9-phased-rollout)
10. [Decision Matrix](#10-decision-matrix)
11. [Open Questions](#11-open-questions)
12. [Recommendation](#12-recommendation)

---

## 1. Motivation

Cloudflare has shipped infrastructure that overlaps substantially with what the buildd Coder-based runner layer provides, at potentially lower cost and with faster provisioning for short-lived tasks:

- **Sandbox SDK** (`github.com/cloudflare/sandbox-sdk`, beta): isolated container/microVM execution driven from Workers. Ships a first-party example running Claude Code headlessly against an arbitrary repo. Every Sandbox is lifecycle-managed by a Durable Object (DO).
- **Claude Managed Agents + Cloudflare Environments** (`github.com/cloudflare/claude-managed-agents`): Workers-based control plane that spins up a sandbox per agent session (microVM OR V8 isolate backend), persists state across session sleeps (DO SQLite for isolates, R2 snapshots for microVMs), egress policies with credential injection, session observability, Workers VPC for private service access.

The current runner is a long-lived Bun process on Coder workspaces. It requires persistent disk for pre-cloned repos, git worktrees under `.buildd-worktrees/`, and spawns the Claude Code binary as a subprocess. This works well for complex multi-hour coding tasks but carries fixed infrastructure cost regardless of utilization.

**Hypothesis:** A subset of buildd tasks — triage, KB queries, artifact generation, packer notes, role-based analysis — does not require a POSIX filesystem or git toolchain, and could run cheaper and faster on CF V8 isolates. MicroVM sandboxes may be cost-competitive for short coding tasks at scale.

**Non-goals:** This spec does NOT propose migrating off Coder. Coder remains the default substrate. The objective is a second substrate selectable per-workspace or per-task-category.

**Strategic note:** Claude Managed Agents + CF Environments commoditizes bare "agent runs a coding task." buildd's moat is orchestration doctrine, missions/roles, releaseConfig, KB retrieval, and the PR lifecycle. The runner substrate should be commodity; this spec makes it swappable.

---

## 2. Substrate Interface Definition

### 2.1 What already exists

The `AgentBackend` interface (`apps/runner/src/backends/types.ts`) answers **which agent engine** runs:

```typescript
export interface AgentBackend {
  runStreamed(opts: RunStreamedOpts): AsyncIterable<BackendEvent>
}
```

Two implementations: `ClaudeBackend` (Claude Agent SDK subprocess) and `CodexBackend` (Codex CLI subprocess). This abstraction is healthy and should not change.

### 2.2 What is missing: `RunnerSubstrate`

`AgentBackend` says *what* runs. It does not say *where* execution happens. All current WHERE assumptions are implicit:

| Assumption | Where it lives |
|---|---|
| Pre-cloned repo on disk | `WorkspaceResolver` + `git-operations.ts` |
| Git worktrees under `.buildd-worktrees/` | `setupWorktree()` / `cleanupWorktree()` |
| Claude Code binary on PATH | `resolveClaudeBinaryPath()` |
| `~/.claude/` credentials on host | `credential-cache.ts` |
| Stable `CODEX_HOME` temp dirs | `codex-auth.ts` |
| Long-running process with `setInterval` timers | `worker-sync.ts`, `WorkerManager` |
| No isolation between concurrent workers | `workers.ts` (shared process) |

A `RunnerSubstrate` interface makes these explicit and swappable:

```typescript
// Proposed: apps/runner/src/substrates/types.ts
export interface RunnerSubstrate {
  // Provision an execution environment for one task.
  // Returns a WorktreeContext describing where code lives and what's available.
  provision(opts: ProvisionOpts): Promise<SubstrateContext>

  // Tear down the execution environment. Called in finally block.
  deprovision(ctx: SubstrateContext, outcome: 'done' | 'error' | 'retry'): Promise<void>

  // Whether this substrate can handle the given task category.
  supports(category: SubstrateCapability): boolean
}

export type SubstrateCapability =
  | 'git_worktree'     // POSIX filesystem + git + shell toolchain
  | 'file_read_write'  // Structured file ops without shell
  | 'process_exec'     // Arbitrary subprocess execution
  | 'browser'          // Headless browser (Playwright/Puppeteer)
  | 'long_running'     // Sessions > 15 minutes

export interface ProvisionOpts {
  workerId: string
  taskId: string
  repoUrl?: string
  branch: string
  baseBranch: string
  credential?: ServerCredential
  env?: Record<string, string>
}

export interface SubstrateContext {
  cwd: string               // Working directory for the agent
  backend: AgentBackend     // Which agent backend to use (substrate may constrain this)
  capabilities: SubstrateCapability[]
  cleanup: () => Promise<void>
}
```

**Coder substrate** (`CoderSubstrate`): implements all capabilities. Delegates to existing `setupWorktree()` / `cleanupWorktree()` logic. No behavioral change — it's a thin wrapper.

**Cloudflare sandbox substrate** (`CloudflareSandboxSubstrate`): implements `file_read_write` and optionally `git_worktree` (microVM only), `process_exec` (microVM only), `browser` (via CF browser bindings). Does NOT support `long_running` beyond microVM limits (see §7).

### 2.3 Integration with WorkerManager

`WorkerManager` currently has substrate behavior hard-coded. After refactoring, the substrate is resolved once per task claim and passed to `startSession`:

```typescript
const substrate = resolveSubstrate(worker, workspaceConfig)
const ctx = await substrate.provision(opts)
const backend = createBackend(taskBackend, backendConfig)
await runSession(worker, ctx, backend)
await substrate.deprovision(ctx, outcome)
```

Substrate resolution uses the same precedence model as `AgentBackend` backend selection: task override > role default > workspace default > system default (Coder).

---

## 3. Lifecycle Architecture

### 3.1 The mismatch

buildd workers **pull** work: the runner subscribes to Pusher `task:assigned` events and polls `POST /api/workers/claim`. Cloudflare's control plane is **push-driven**: the Claude Platform posts `session.start` / `session.end` webhooks that drive sandbox spin-up and teardown.

Three architectural options to bridge this:

---

#### Option A — Thin always-on CF Worker polls/claims → fans into sandboxes (CHOSEN)

```
Pusher --[task:assigned]--> CF Worker (persistent DO, polls buildd API)
                                |
                     POST /api/workers/claim
                                |
                   ┌────────────▼────────────┐
                   │  SandboxDispatcher (DO)  │
                   │  - one DO per workspace  │
                   │  - claims task           │
                   │  - starts sandbox        │
                   └─────────┬───────────────┘
                             │
                   ┌─────────▼─────────┐
                   │ Sandbox (microVM  │
                   │  or isolate)      │
                   │ - runs agent      │
                   │ - reports progress│
                   └───────────────────┘
```

A `SandboxDispatcher` Durable Object per workspace subscribes to Pusher and polls the buildd claim API. When a task is available and the workspace is configured for CF substrate, it claims the task (using the same `POST /api/workers/claim` endpoint), then provisions a sandbox for it.

The runner's existing claim dedup guarantees hold: the `NOT EXISTS` SQL subquery prevents two DOs from claiming the same task. The 60-second per-runner cooldown applies to the CF runner's workerId just as it does to Coder runners.

**Why chosen:**
- No server-side changes to the claim route or Pusher infrastructure
- The `SandboxDispatcher` DO is naturally single-threaded per workspace ID — it cannot claim the same task twice from the same workspace simultaneously (DO serialization)
- Composable with existing Coder runners: both can compete for tasks if the claim endpoint is unchanged; workspace `substrateType` config routes which endpoint participates

**Rejected alternatives preserved below for context.**

---

#### Option B — buildd server pushes task-start webhooks to CF Worker control plane (REJECTED)

Server calls a CF Worker webhook with `{ taskId, branch, credential }` when dispatching. CF Worker provisions a sandbox.

Rejected because:
- Requires server-side changes to every task-dispatch path
- Introduces a synchronous dependency on CF availability in the hot task-creation path
- Breaks the server's current stateless dispatch model (server doesn't know which substrate to target at create-time — the runner self-selects based on its config)
- Does not preserve dedup guarantees without significant additional logic

---

#### Option C — Adopt claude-managed-agents control plane wholesale (REJECTED)

Fork the `claude-managed-agents` repo and build buildd's orchestration logic on top of it.

Rejected because:
- The claude-managed-agents control plane is Claude Platform–specific (session webhooks from Claude.ai); buildd tasks come from the buildd dashboard and API
- Would require maintaining a fork of upstream CF code, adding a vendor-coupling dimension beyond the CF platform itself
- The lifecycle (Claude Platform session start/end) does not map cleanly to buildd's task lifecycle (claim → execute → PR merge → complete)
- The session recording / observability features overlap with buildd's own worker lifecycle events

---

### 3.2 DO-as-serializer for orchestrator doctrine

**Current doctrine** (`docs/` and codebase): one work-unit per branch per PR; `dependsOn` serialization on overlapping paths; retries continue on the same branch; done = merged and branch deleted.

This doctrine is currently enforced at the application layer (claim route SQL, `dependsOn` checks, `NOT EXISTS` active-worker guard). With `SandboxDispatcher` keyed by `workspaceId:branch`, the Durable Object's single-threaded guarantee provides an infra-level enforcement layer:

```
DO key: idFromName(`${workspaceId}:${branch}`)
→ Only one DO instance exists per branch per workspace
→ DO cannot launch two sandboxes for the same branch simultaneously
→ Retry logic (claim the same branch after failure) naturally serializes through the same DO
```

This **complements** rather than replaces the existing SQL dedup. The SQL guard remains authoritative because it covers cross-substrate scenarios (a Coder runner and CF runner should not both claim the same task). The DO serializer prevents a CF-substrate runner from racing with itself.

**Relationship to retries:** When a task fails and is retried on the same branch, the retry attempt's DO key is identical to the original. The DO's storage records `lastAttemptId` and `sandboxState`, allowing the retry to either resume from an R2 snapshot or force a clean clone (see §4).

---

## 4. Git / Worktree Strategy

### 4.1 The Coder model

On Coder, repos are pre-cloned at paths resolved by `WorkspaceResolver`. A new worktree is created via `git worktree add -b <branch> .buildd-worktrees/<branch> origin/<base>`. The worktree persists across sessions until the task is complete. This requires:
- Persistent disk with the repo already present
- `git` on PATH
- Write access to `.buildd-worktrees/`
- Minutes of `git fetch` time if the repo has diverged significantly

### 4.2 CF microVM strategy

In an ephemeral CF container, there is no pre-cloned repo. Two approaches:

**A — Fresh clone per task (simple, correct):**
```
sandbox.exec(`git clone --depth=50 ${repoUrl} /workspace`)
sandbox.exec(`git checkout -b ${branch} origin/${base}`)
```

Cost: clone time on large repos (monorepos with long history: 30-120s for a depth-50 clone). Acceptable for tasks > 5 minutes; adds unacceptable overhead for sub-minute tasks.

**B — R2 snapshot cache (chosen for microVM tasks):**

The Sandbox SDK already manages R2 snapshots of `/workspace` for session persistence. We extend this: on first task in a workspace, clone the repo and immediately snapshot it. Subsequent tasks restore from the snapshot and run `git fetch origin && git checkout -b <branch> origin/<base>`.

```
dispatch() {
  if (isLive()) return  // sandbox already running with this workspace
  if (restoreLatestSnapshot()) {
    exec('git fetch origin && git reset --hard origin/<base>')
  } else {
    exec('git clone --depth=50 <repoUrl> /workspace')
  }
  exec(`git checkout -b ${branch}`)
}
```

Snapshot TTL: 24 hours (R2 lifecycle rule). The snapshot captures an up-to-date `origin/<defaultBranch>` checkout. On restore, `git fetch origin` refreshes remote refs; the expensive clone only happens once per 24-hour window per workspace.

**Retry-same-branch:** When a task is retried, the `SandboxDispatcher` DO records `lastBranchSnapshotKey`. If the prior attempt committed work, its snapshot is restored (preserving in-progress changes). This maps cleanly to the Coder doctrine of "retries continue on the same branch."

**Push strategy:** CF container has full git credentials injected via egress policy (GitHub App token for `git push`). `git push origin <branch>` works identically to Coder.

### 4.3 CF isolate strategy

V8 isolates have no POSIX filesystem and cannot run `git`. The `Workspace` API (`@cloudflare/shell`) provides structured file operations backed by DO SQLite. Isolates should therefore only receive tasks that:
- Do not require git operations (no commit, no PR creation)
- Do not invoke shell commands or build toolchains
- Operate on structured data or text content passed directly in the task prompt

For such tasks, the `cwd` in `SubstrateContext` is a virtual path (`/workspace/task-<id>`) backed by the SQLite workspace. The Claude Agent SDK is invoked via the Anthropic API directly (no `claude` binary); tool calls that touch the filesystem use CF's `cf_write` / `cf_edit` / `cf_read` family.

**Worktree doctrine compliance:** Isolates never create git branches. Tasks routed to isolates must have `outputRequirement: 'artifact_required'` or `'none'` — never `'pr_required'`. The decision matrix in §10 enforces this.

---

## 5. Credential Strategy

### 5.1 Current Coder model

**Anthropic API key / OAuth:** Resolved at claim time from the `secrets` table and attached inline to the claim response. The runner injects it as `ANTHROPIC_API_KEY` into the subprocess environment. For OAuth, `~/.claude/.credentials.json` is read from the runner host's home directory.

**Codex credentials:** `materializeCodexAuth()` creates a temporary `CODEX_HOME/auth.json` with `{ access_token, refresh_token, account_id }` before spawning the Codex backend. Deleted in the session `finally` block. This pattern exists because the Codex CLI reads credentials from a file path, not environment variables.

**GitHub App token:** A short-lived installation token (60 min) is generated at task claim time and injected into the worktree's `.git/config` as a credential helper URL. Used for `git push`, PR creation.

**Pain points:** The `auth.json` materialization dance is fragile (temp file leaks on crash, race on concurrent tasks). The OAuth token refresh rotation requires per-account serialization (60-min lock, PR #836/#837). On Coder, all this happens on the runner host, which means rotating credentials requires re-fetching from the server and re-materializing files.

### 5.2 CF egress injection strategy

CF's egress policy engine intercepts all outgoing HTTPS traffic from the container/isolate before it reaches the public internet. Secrets are injected at the proxy layer — the agent process never holds them.

**Anthropic API key injection:**
```json
// Egress policy (wrangler.jsonc)
{
  "outbound_services": [{
    "service": "anthropic-proxy",
    "match": "api.anthropic.com"
  }]
}
// anthropic-proxy Worker: injects Authorization header from KV secret
```

The Claude Agent SDK's HTTP calls to `api.anthropic.com` pass through the proxy, which injects the `x-api-key` header. The agent process receives `ANTHROPIC_API_KEY=""` (empty string) or omits the variable entirely.

**GitHub App token injection:**
```json
// Egress policy matches github.com and api.github.com
// Proxy Worker injects Authorization: Bearer <installation-token>
// Token is refreshed in the proxy Worker (short-lived, never touches the container)
```

This eliminates the need to inject GitHub tokens into `.git/config` inside the container. The container's `git push` simply succeeds — the auth is invisible.

**Codex OAuth:** CF egress injection fully eliminates the `auth.json` materialization pattern for Codex. The ChatGPT API endpoint is matched in the egress policy; the `access_token` is injected as a request header. No temp file, no CODEX_HOME, no rotation race. The per-account serialization problem (only one Codex session per account simultaneously) would still need a DO-level lock, but the credential materialization complexity disappears.

**MCP server credentials:** VPC bindings (`vpc_services[]` in `wrangler.jsonc`) let the container call internal services (buildd MCP, memory service) without their credentials being visible to the agent. The `cf_call_service` tool routes through the Workers VPC.

**Scope:** Egress injection applies only to the CF substrate. The Coder substrate retains existing credential materialization logic unchanged.

---

## 6. Isolate Routing Policy

### 6.1 The two tiers

| Tier | Backend | Boot time | Cost tier | Filesystem | Shell | Git |
|---|---|---|---|---|---|---|
| **V8 Isolate** | CF Durable Object | < 100ms | Very low | SQLite (DO) | No | No |
| **MicroVM** | CF Container | ~2s | Low–medium | `/workspace` (Linux) | Yes | Yes |
| **Coder (current)** | Long-running process | 0 (always warm) | Fixed monthly | NFS/disk | Yes | Yes (worktrees) |

### 6.2 Task categories and routing

```
task.category × task.outputRequirement × task.roleSlug
       ↓
SubstrateSelector.resolve(task, workspaceConfig)
       ↓
'coder' | 'cf-isolate' | 'cf-microvm'
```

**Route to CF Isolate (no filesystem/git needed):**
- `category: 'analysis'` with no file modification tools
- Triage tasks (read-only KB queries, issue classification)
- Artifact-only tasks (`outputRequirement: 'artifact_required'`) with text/JSON output
- Role: `researcher` or `organizer` with `canDelegateTo: []` (no sub-agents requiring git)
- "Packer note" style non-code work (no git operations)
- `outputRequirement: 'none'` (informational tasks)

**Route to CF MicroVM (needs git/shell, but short-lived):**
- Tasks with `outputRequirement: 'pr_required'` where estimated duration < 20 min
- `category: 'bug'` or `'feature'` on repos with small surface area
- Tasks from workspaces that have opted into `substrateType: 'cf-microvm'`

**Route to Coder (default, long-lived / complex):**
- All tasks not explicitly opted into CF substrates
- `category: 'refactor'` with large scope
- Tasks with `maxTurns > 50` or estimated duration > 20 min
- Workspaces with `substrateType: 'coder'` (default)
- Any task requiring Docker-in-Docker or privileged execution
- Tasks for roles with `requiredEnvVars` that reference runner-host files

**Hard exclusions from CF substrates:**
- Tasks requiring `CODEX_HOME` filesystem artifacts (Codex backend requires local file materialization — CF substrate uses API-only Codex if supported, else routes to Coder)
- Tasks with `sandboxMode: 'read-only'` that reference a pre-existing worktree (CF has no persistent worktrees between unrelated tasks)
- Tasks with active `resumeThreadId` from a Coder session (session context is non-portable)

### 6.3 Routing configuration

`workspaceConfig.substrateType` (new field): `'coder'` | `'cf-isolate'` | `'cf-microvm'` | `'auto'`.

- `'coder'`: all tasks route to Coder (today's behavior, no change)
- `'cf-isolate'`: non-code tasks use isolates; code tasks fall back to Coder
- `'cf-microvm'`: code tasks prefer microVM; long-running fall back to Coder
- `'auto'`: per-category routing per §6.2 above

Tasks can override workspace config via `task.context.substrateHint`. Roles can set `preferredSubstrate` alongside existing `model` and `backend` fields.

---

## 7. Limits & Risks

### 7.1 Hard limits

| Limit | Impact |
|---|---|
| **MicroVM max instance: 4 vCPU / 12 GiB RAM** | Sufficient for most coding tasks; insufficient for large build toolchains (Rust, Android). Excludes Docker-in-Docker. |
| **Max disk: 20 GB per container** | Enough for most repos + node_modules; insufficient for large monorepos with deep build artifacts. |
| **Account limits: 1,500 concurrent vCPU, 6 TiB RAM** | Not a constraint at current scale; becomes relevant at very high concurrency. |
| **Container idle timeout: 3 min (default)** | Tasks that run silently for > 3 min without exec output will trigger snapshot+sleep. The Sandbox SDK's `onActivityExpired` hook provides a callback — we must emit keepalive heartbeats to prevent premature sleep on long agent turns. |
| **R2 snapshot restore time** | The snapshot is of `/workspace` (potentially GiBs for large repos). Restore time is proportional to snapshot size; a 1 GB snapshot on a 1 Gbps link = ~8s restore. Must be measured for real repos. |
| **No Docker-in-Docker** | Rules out CF substrate for tasks that invoke `docker build` or `docker run` (e.g., containerized test suites, build pipelines that produce Docker images). |
| **V8 isolate: no shell, no git** | Entire class of coding tasks is ineligible for isolate tier. Not a risk for isolate-only routing; a risk only if isolate routing is applied too broadly. |
| **Workers subrequest limit: 1,000/request (paid)** | Each `exec()`, `readFile()`, `writeFile()` call counts as a subrequest. A Claude Code session with many file operations could exhaust this. MicroVM sessions using the WebSocket transport avoid this (single subrequest for the connection upgrade). Always use WebSocket transport for sandbox communication. |

### 7.2 Operational risks

**Vendor coupling:** Adopting CF DO semantics for orchestrator doctrine enforcement (§3.2) creates a hard dependency on Cloudflare for a core invariant. If CF pricing changes or the DO API changes, the doctrine enforcement must be re-implemented. Mitigation: keep SQL dedup as the authoritative layer; DO serialization is additive safety only.

**Cold-start container image build time:** First-run container build takes 2-3 minutes (Docker layer compilation). This is a one-time cost per deployment, not per task. CI/CD pipeline must include a container provisioning warm-up step post-deploy to avoid the first user experiencing a 3-minute delay.

**Observability parity:** Current workers emit detailed Pusher events (`worker:progress`, `worker:completed`, `worker:failed`) and heartbeats every 30s. CF sandboxes must emit equivalent events via the buildd API (HTTP PATCH to `POST /api/workers/[id]`). The sandbox has outbound network access; implementing a keepalive + progress reporter inside the container or isolate is required. Without this, the stale-worker detection (30s activity check) will trigger false positives.

**Refire / duplicate-claim risk:** The existing dedup SQL (`NOT EXISTS` guard + 60s per-runner cooldown) was hardened through multiple incidents (PR #320, PR #335, 2026-06-25 budget-reset race fix). A CF runner MUST use the same claim endpoint with the same `runnerId` semantics. Specifically: the 60-second cooldown (`AND w_cd.status IN ('error', 'failed') AND updated_at > <60s ago>`) must apply to CF runner worker IDs to prevent a CF sandbox from immediately re-claiming a task it just failed on. The Pusher `TASK_ASSIGNED` vs `TASK_UPDATED` distinction (budget-reset sends `TASK_UPDATED`, not `TASK_ASSIGNED`) must be honored by the CF Pusher subscriber.

**Session length vs container idle timeout:** The CF container sleeps after 3 min of inactivity. A Claude Code session making a `Bash` call that takes 4 min to return (e.g., `npm install` in a large project) will trigger a premature sleep mid-execution. Mitigation: keepalive exec (`echo keepalive`) every 90 seconds from the control plane side while the agent is active.

**egress allowlist friction:** npm/pip/cargo installs pull from arbitrary package registries. An egress allowlist that blocks unknown domains will break common install steps. Options: (a) open egress (no allowlist) — defeats zero-trust goal, (b) allowlist on commonly used registries (npmjs.org, pypi.org, crates.io, etc.) — requires maintenance, (c) per-workspace egress config — adds operational overhead. The current Coder model has no egress filtering. Phase 1 should use open egress (option a) and restrict only for workspaces that opt in.

**Image size limits (50 GB total, 20 GB per container disk):** The Coder runner image includes Node, Bun, git, the Claude Code binary, and workspace toolchains. A CF container image must fit in 20 GB of disk. This is achievable with a lean base image + on-demand tool installation via the agent's `bash` tool. Trade-off: tool install adds latency per task; baking in common toolchains grows the image.

---

## 8. Cost Analysis

### 8.1 Coder substrate (current)

Coder workspace costs are fixed monthly based on instance type and count. A representative configuration:

| Config | Cost |
|---|---|
| 2 vCPU / 4 GiB, always-on | ~$40-80/mo (Coder Cloud or equivalent) |
| 4 vCPU / 8 GiB, always-on | ~$80-160/mo |

Cost is incurred 24/7 regardless of task volume. At low volume (<20 tasks/day), the per-task amortized cost is high. At high volume (>200 tasks/day with parallel execution), the fixed cost spreads well.

**Current model is economical at high utilization, expensive when idle.**

### 8.2 CF substrate (estimated)

CF Containers pricing is consumption-based (not yet published in flat $/unit form as of spec date). Proxying from published Workers/Containers pricing signals:

**Base Workers fee:** $5/month for the Workers Paid plan (required for Containers + DO bindings).

**Container resource consumption:** CF bills on vCPU-seconds and GiB-seconds of RAM consumed while the container is running (sleeping containers consume storage only).

Representative estimates for a `standard-1` instance (0.5 vCPU, 4 GiB):

| Scenario | Duration | Freq | Est. CF cost/mo |
|---|---|---|---|
| Isolate (triage/KB query) | 30s | 50/day | ~$1-3 |
| MicroVM short code task | 5 min | 20/day | ~$5-15 |
| MicroVM medium task | 15 min | 10/day | ~$10-25 |
| MicroVM long task | 45 min | 5/day | ~$15-35 |

*These are estimates. Actual billing depends on CF's published container rate at time of implementation.*

**R2 storage cost:** Snapshots of `/workspace` are stored in R2. At $0.015/GB/month (R2 standard), a 1 GB workspace snapshot for 10 active workspaces costs $0.15/mo. Negligible.

### 8.3 Crossover point

The break-even between a fixed-cost Coder workspace and per-consumption CF containers:

- At **≤ 50 tasks/month** (sparse usage): CF is cheaper (near-zero consumption cost vs fixed Coder seat)
- At **50-500 tasks/month** (moderate): roughly equivalent, depending on task duration mix
- At **> 500 tasks/month** (heavy, sustained): Coder's fixed cost amortizes well; CF microVM per-task cost may exceed the Coder seat cost for long-running tasks

**Key insight:** CF isolates (non-code tasks) are almost certainly cheaper at all volume levels — boot time < 100ms, CPU cost is minimal, no container provisioning overhead. The ROI argument for CF is strongest for the isolate tier.

**10× volume scenario (5,000+ tasks/month):** At scale, a mix of CF isolates (cheap, fast) + CF microVMs (moderate cost) + Coder (reserved capacity for long-running) likely minimizes total cost. The CF account limits (1,500 concurrent vCPU) are not a constraint at 10× current volume.

---

## 9. Phased Rollout

### Phase 0 — Substrate abstraction (prerequisite, no behavior change)

- Introduce `RunnerSubstrate` interface in `apps/runner/src/substrates/types.ts`
- Wrap existing `setupWorktree` / `cleanupWorktree` / `resolveClaudeBinaryPath` into `CoderSubstrate`
- `WorkerManager` resolves substrate via `resolveSubstrate(worker, config)` (initially always returns `CoderSubstrate`)
- Add `substrateType` field to workspace config (DB migration, default `'coder'`)
- No behavioral change. CI must pass green.

**Success criterion:** All existing tests pass. No regression in Coder behavior.

### Phase 1 — CF Isolate canary for non-code tasks (hypothesis validation)

**Hypothesis:** CF V8 isolates can complete triage/KB/artifact-only tasks faster and cheaper than Coder, with equivalent output quality.

- Implement `CloudflareIsolateSubstrate` against the Sandbox SDK isolate backend
- Deploy CF Workers endpoint with Isolate Runner DO
- Route 5% of `category: 'analysis'` and `outputRequirement: 'artifact_required'` tasks from opted-in workspaces to CF isolates
- Emit equivalent worker progress events via HTTP PATCH to buildd API
- Measure: completion rate, time-to-first-token, task duration, output quality (human-graded sample)
- Run for 2-3 weeks with at least 200 tasks through the isolate path

**This is the single cheapest experiment that de-risks the decision.** It requires only:
1. One new `CloudflareIsolateSubstrate` class
2. One CF Workers deployment (isolate + DO only, no containers)
3. Routing logic in `resolveSubstrate` for 5% of eligible tasks
4. No changes to the buildd server or claim route

**Success criterion:** ≥ 90% completion rate on isolate tasks; p95 duration ≤ Coder baseline for equivalent task type; cost per task < Coder equivalent.

### Phase 2 — CF MicroVM for short code tasks (if Phase 1 passes)

- Implement `CloudflareMicroVMSubstrate`
- Deploy CF container image with git, Node, Bun, Claude Code binary
- Implement R2 snapshot cache for repo state
- Wire egress injection for Anthropic API key + GitHub App token
- Route tasks with `outputRequirement: 'pr_required'` AND estimated duration < 15 min from opted-in workspaces
- Keepalive heartbeat from DO to prevent premature container sleep
- Measure: completion rate, clone/restore time, cost vs Coder for equivalent tasks

**Success criterion:** ≥ 85% completion rate; end-to-end time (including clone/restore) ≤ 1.3× Coder equivalent; cost < Coder for tasks < 10 min.

### Phase 3 — Per-workspace substrate selection in dashboard

- Expose `substrateType` as a workspace setting in the dashboard
- Add per-role `preferredSubstrate` field
- Analytics: substrate utilization, per-substrate cost and completion rate
- Auto-routing (`substrateType: 'auto'`) becomes the recommended default for new workspaces

### Phase 4 — DO-as-serializer for branch doctrine enforcement (optional)

Only if Phases 1-3 succeed and branch-doctrine violations are observed at scale:
- Key `SandboxDispatcher` DO by `workspaceId:branch`
- Add `lastAttemptId` + `sandboxState` to DO storage for retry continuity
- This replaces zero app-layer changes to the doctrine invariants; the SQL guards remain authoritative

---

## 10. Decision Matrix

| Task category | Output req | Duration est. | Recommended substrate | Notes |
|---|---|---|---|---|
| Triage / classification | `none` | < 2 min | **CF Isolate** | No git, structured output only |
| KB query / research | `artifact` | < 5 min | **CF Isolate** | Reads, no writes to repo |
| Packer note / summary | `artifact` | < 5 min | **CF Isolate** | Text generation only |
| Role analysis (Researcher) | `artifact` | < 10 min | **CF Isolate** | No code execution |
| Simple bug fix | `pr` | < 10 min | **CF MicroVM** | Git + shell, short session |
| Feature implementation | `pr` | 10-30 min | **CF MicroVM** (if opted in) or **Coder** | MicroVM viable with R2 cache |
| Large refactor | `pr` | > 30 min | **Coder** | Long-running, high RAM |
| Build pipeline (Docker) | `pr` | any | **Coder** | Docker-in-Docker excluded from CF |
| Multi-agent mission | `pr` | > 20 min | **Coder** | Sub-agent spawning; complex state |
| Codex backend task | `pr` | any | **Coder** (initially) | auth.json pattern; CF egress injection defers this |
| Browser / visual QA | `artifact` | < 10 min | **CF MicroVM** | CF browser bindings available |

---

## 11. Open Questions

1. **CF Containers pricing:** The official $/vCPU-second rate was not published in accessible docs as of this spec. The cost analysis uses estimates. Confirm actual pricing before Phase 2 go/no-go.

2. **Claude Agent SDK in a CF Worker:** The `ClaudeBackend` currently spawns `claude` as a subprocess. In an isolate, subprocess execution is not available — the SDK must be called via its Node.js/HTTP API directly. Confirm that the Claude Agent SDK can run in a CF Workers-compatible runtime (no subprocess dependency).

3. **R2 snapshot restore time at real repo sizes:** The spec assumes a 1 GB snapshot restores in ~8s. For large monorepos (5-10 GB), restore time may be unacceptably long. Benchmark with real repo sizes before committing to Phase 2.

4. **Pusher subscription from CF Worker:** The current runner subscribes to Pusher WebSocket channels. CF Workers support outbound WebSocket connections. Confirm the Pusher client library is compatible with the CF Workers runtime (no Node-specific APIs).

5. **Session resume for multi-turn tasks:** The buildd runner supports `worker:command` messages mid-flight (pause, resume, user input). How are these delivered to a CF sandbox that may have hibernated? The `SandboxDispatcher` DO must buffer incoming commands and replay them on container wake.

6. **Max concurrent containers per CF account:** The published limit is 1,500 concurrent vCPU and 6 TiB RAM. At current task volume, this is not a constraint. Confirm that burst traffic (mission-spawned fan-out creating 50+ parallel tasks) stays within these limits.

7. **`nodejs_compat` flag and CF Workers:** CF Workers with `nodejs_compat` support Node APIs up to the flag's current coverage. Confirm that `@anthropic-ai/claude-agent-sdk` and its dependencies work under `nodejs_compat` without modification.

---

## 12. Recommendation

### Decision: **DEFER** — validate Phase 1 isolate experiment first

**Rationale:**

The CF substrate is architecturally sound and the interface separation (`RunnerSubstrate`) is worth doing regardless of the CF decision — it removes implicit substrate assumptions that complicate future work. Phase 0 (abstraction only) is a **GO** at any time.

For the CF substrate itself:

- **V8 Isolate tier (non-code tasks): DEFER pending Phase 1 experiment.** The hypothesis is plausible (fast, cheap, no git required) but unvalidated. The cheapest possible experiment — routing 5% of artifact-only tasks to CF isolates for 2-3 weeks — directly tests the assumption with minimal risk. Run Phase 1 before committing to Phase 2.

- **MicroVM tier (code tasks): NO-GO until Phase 1 succeeds.** The integration complexity (R2 snapshot cache, keepalive heartbeat, egress injection, container image maintenance, clone-time overhead) is non-trivial. The cost advantage over Coder is unclear without real pricing data. The refire/duplicate-claim history demonstrates that claim-loop edge cases have real production consequences; introducing a new claim path via CF DOs requires careful validation. MicroVM is the right long-term direction but the risk/reward ratio is inverted until the isolate tier is proven.

**Cheapest de-risking experiment (Phase 1):**

1. Deploy a single CF Worker with one `IsolateRunner` DO
2. Add `CloudflareIsolateSubstrate` implementing `RunnerSubstrate` (one new file, ~200 lines)
3. Route `category: 'analysis'` + `outputRequirement: 'artifact_required'` tasks from one volunteer workspace to CF isolates for 2 weeks
4. Measure completion rate, cost, and quality
5. If ≥ 90% completion rate + cost saving confirmed: proceed to Phase 2. If not: stop, learn, re-evaluate.

**If Phase 1 succeeds,** the CF substrate becomes the default for non-code tasks across all workspaces. The fixed Coder cost is reduced (fewer always-on workspaces needed). The Phase 2 MicroVM effort becomes justified by proven Phase 1 value.

**The runner substrate is commodity. The orchestration layer is the moat. Ship Phase 0, experiment with Phase 1, decide on Phase 2 from data.**

---

*Spec authored by builder agent · 2026-07-07*
