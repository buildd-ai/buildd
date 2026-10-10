/**
 * One Durable Object (Agents SDK agent) per buildd task, named by task ID, so
 * a duplicate webhook for the same task reaches the same instance. It owns one
 * container and supervises one `buildd-once --task <id>` process at a time.
 *
 * With container reuse on (container-lease.ts), the same class also serves
 * lease agents, named `lease:<size>:<workspaceId>:<slot>`, which run one task
 * after another in a container they keep warm in between. A task agent then
 * routes its task to a lease and remembers which (`leasedTo`); GET, kill and
 * resume reach the lease through it. A lease agent's task is its current run's.
 *
 * The run logic lives in supervisor.ts and the decisions in lifecycle.ts; this
 * class only wires them to `this.ctx.container`, agent state and keepAlive.
 * Design: docs/design/cloudflare-sandbox-runner.md, Components 3 and 4.
 */
import { Agent, getAgentByName } from 'agents';
import type { Env } from './env';
import { BrowserBridge, BROWSER_BRIDGE_HOST, handleScopedBrowserRequest } from './browser-bridge';
import { bindingBrowserPort } from './browser-binding';
import {
  INITIAL_STATE,
  resolveInactivityTimeoutMs,
  resolveStartTimeoutMs,
  parseTaskTokenResponse,
  resumableRunsEnabled,
  taskTokenRequest,
  warmReposEnabled,
  type DispatchRequest,
  type RunState,
} from './lifecycle';
import {
  GithubTokenCache,
  GrantFetchError,
  INTERCEPTED_HOSTS,
  ModelEndpointCache,
  NoModelEndpointError,
  githubTokenRequest,
  lookupGithubGrant,
  modelEndpointRequest,
  needsServerModelEndpoint,
  plannedModelAuth,
  parseGithubGrant,
  parseServerModelEndpoint,
  type GithubGrant,
  type GithubGrantLookup,
  type ServerModelEndpoint,
  type ServerModelEndpointState,
} from './outbound';
import type { EgressProps } from './egress';
import {
  EMPTY_SEAT_GATE,
  OWNER_SEAT_GATE_NAME,
  OwnerSeatRun,
  acquireSeat,
  markSeatWall,
  ownerSeatCap,
  ownerSeatEnabled,
  releaseSeat,
  type SeatAcquire,
  type SeatGateState,
  type SeatRouteDecision,
} from './owner-seat';
import { otlpInterceptHosts } from './otel';
import { SNAPSHOT_HOST, type SnapshotScope } from './snapshots';
import { instanceTypeFor, normalizeRunnerSizeDecision, type RunnerSize } from './runner-class';
import {
  containerReuseEnabled,
  parseLeaseName,
  resolveReuseSlots,
  resolveReuseWindowMs,
  routeToLease,
  taskStateOnLease,
  waitForTailLease,
  type Routed,
  type LeaseHandle,
  type LeaseKey,
  type LeasedDispatchRequest,
  type LeasedDispatchResult,
} from './container-lease';
import {
  TaskSupervisor,
  type ContainerPort,
  type DispatchResult,
  type ScheduleDispatchResult,
  type ScheduledDispatchPayload,
} from './supervisor';

/** `ctx.exports` loopback for the EgressHandler entrypoint exported from index.ts. */
type EgressExports = { EgressHandler(options: { props: EgressProps }): Fetcher };

const GITHUB_TOKEN_TIMEOUT_MS = 10_000;
const TASK_TOKEN_TIMEOUT_MS = 10_000;
const MODEL_ENDPOINT_TIMEOUT_MS = 10_000;

export class WorkerAgent extends Agent<Env, RunState> {
  initialState: RunState = INITIAL_STATE;

  // No WebSocket clients are expected; don't send identity frames to any.
  static options = { sendIdentityOnConnect: false };

  private supervisorInstance: TaskSupervisor | null = null;
  /** A task agent routing its task to a lease: a duplicate arriving meanwhile is a duplicate. */
  private routing = false;
  private browserBridge: BrowserBridge | null = null;
  private browserSessionToken: string | undefined;

  /**
   * Set when this agent is a lease (named by container-lease.ts leaseName) of
   * its own class. A lease name of the other class is refused outright.
   */
  private get lease(): LeaseKey | null {
    const key = parseLeaseName(this.name);
    if (key && key.size !== this.runnerSize) throw new Error(`lease ${this.name} reached the ${this.runnerSize} class`);
    return key;
  }

  /** The task this agent runs: its name, or on a lease, its current run's task. */
  protected get taskId(): string {
    return this.lease ? (this.state.taskId ?? '') : this.name;
  }

  private async leaseAgent(name: string): Promise<LeaseHandle & { getRunState(): Promise<RunState>; killContainer(): Promise<{ killed: boolean }> }> {
    const ns = this.runnerSize === 'large' ? this.env.WorkerAgentLarge : this.env.WorkerAgent;
    return (await getAgentByName(ns as never, name)) as never;
  }

  /**
   * The container class this agent's container is (wrangler.jsonc binds one
   * container class per agent class). WorkerAgentLarge overrides it.
   */
  protected get runnerSize(): RunnerSize {
    return 'standard';
  }

  private get supervisor(): TaskSupervisor {
    if (this.supervisorInstance) return this.supervisorInstance;
    const container = this.ctx.container;
    if (!container) throw new Error('WorkerAgent has no container binding (check wrangler.jsonc `containers`)');
    const env = this.env;
    const agent = this;
    const lease = this.lease;
    this.supervisorInstance = new TaskSupervisor({
      get taskId() { return agent.taskId; },
      getState: () => this.state,
      setState: (s) => this.setState(s),
      container: container as unknown as ContainerPort,
      config: {
        BROWSER_BRIDGE: env.BROWSER_BRIDGE === '1' && env.BROWSER ? '1' : undefined,
        get browserSessionToken() { return agent.browserSessionToken; },
        BUILDD_SERVER: env.BUILDD_SERVER,
        BUILDD_API_KEY: env.BUILDD_API_KEY,
        MODEL: env.MODEL,
        PUSHER_KEY: env.PUSHER_KEY,
        PUSHER_CLUSTER: env.PUSHER_CLUSTER,
        BUILDD_ONCE_MAX_WAIT_MS: env.BUILDD_ONCE_MAX_WAIT_MS,
        RUNNER_GROUP: env.RUNNER_GROUP,
        // Telemetry vars only; the collector credential stays with the egress handler.
        OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT,
        OTEL_EXPORTER_OTLP_PROTOCOL: env.OTEL_EXPORTER_OTLP_PROTOCOL,
        OTEL_LOG_TOOL_DETAILS: env.OTEL_LOG_TOOL_DETAILS,
        OTEL_TRACES_BETA: env.OTEL_TRACES_BETA,
        WARM_REPOS: warmReposEnabled(env) ? '1' : undefined,
        RESUMABLE_RUNS: resumableRunsEnabled(env) ? '1' : undefined,
        resumableRuns: resumableRunsEnabled(env),
        reuseEnabled: env.CONTAINER_REUSE === '1',
        agentVersion: env.CF_VERSION_METADATA?.id,
        inactivityTimeoutMs: resolveInactivityTimeoutMs(env),
        startTimeoutMs: resolveStartTimeoutMs(env),
        // The class actually used: this agent's, whatever was asked for.
        instanceType: instanceTypeFor(this.runnerSize, env),
        runnerSize: this.runnerSize,
        // No instance ID on ctx.container; the container is bound to this
        // Durable Object and Cloudflare identifies the instance by its ID
        // (run-report.ts, RunReport.containerInstanceId).
        containerInstanceId: this.ctx.id.toString(),
        ...(lease ? { lease, reuseWindowMs: resolveReuseWindowMs(env) } : {}),
      },
      keepAliveWhile: (fn) => this.keepAliveWhile(fn),
      waitUntil: (p) => this.ctx.waitUntil(p),
      installEgress: () => this.installEgressHandlers(),
      closeBrowser: async () => {
        const bridge = this.browserBridge;
        this.browserBridge = null;
        this.browserSessionToken = undefined;
        return bridge ? await bridge.close() : undefined;
      },
      // Only with the seat secret on the Worker (owner-seat.ts); otherwise runs start as before.
      ...(ownerSeatEnabled(env) ? { ownerSeat: this.ownerSeatRun } : {}),
      // The route its egress will take, so the runner reports the matching
      // cost basis. Without the seat every route is metered: no lookup.
      plannedModelAuth: async () => ownerSeatEnabled(env)
        ? plannedModelAuth(env, needsServerModelEndpoint(env) ? await this.modelEndpoints.get() : null)
        : 'metered',
      mintTaskToken: () => this.mintTaskToken(),
      // One-shot alarms only (Agents SDK schedule, backed by the Durable
      // Object alarm), for task.scheduled. The callback is runScheduledDispatch.
      scheduler: {
        scheduleAt: async (at, payload) => (await this.schedule(new Date(at), 'runScheduledDispatch', payload)).id,
        cancel: async (id) => { await this.cancelSchedule(id); },
      },
      ...(lease ? { scheduleWarmExpiry: async (at: number) => { await this.schedule(new Date(at), 'expireWarmContainer', {}); } } : {}),
      fetch: (input, init) => fetch(input, init),
      now: () => Date.now(),
      sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
      log: (m) => console.log(m),
    });
    return this.supervisorInstance;
  }

  /** A run marked live in storage but absent from memory was lost to a restart. */
  async onStart(): Promise<void> {
    if (!this.ctx.container) return;
    await this.supervisor.recoverOrphan();
    // A dispatch held for a lease's tail when the agent restarted: route it now, no more waiting.
    const held = !this.lease ? this.state.routePending : undefined;
    if (held && !this.routing) {
      this.routing = true;
      this.ctx.waitUntil(this.keepAliveWhile(() => this.routeAfterTail(held.request, [], 0)).finally(() => { this.routing = false; }));
    }
  }

  /**
   * RPC from the dispatcher Worker. Idempotent while a run is live. With
   * container reuse on, a fresh dispatch is routed to a lease of the task's
   * workspace (container-lease.ts) and falls back to this agent when none
   * takes it; a task already on a lease (a duplicate, a resume) goes back to it.
   */
  async dispatch(request: DispatchRequest = {}): Promise<DispatchResult> {
    if (this.lease) throw new Error('a lease agent takes dispatchLeased only');
    const runnerSize = normalizeRunnerSizeDecision(request.runnerSize) ?? undefined;
    const req: DispatchRequest = { ...request, runnerSize };
    const strip = (r: LeasedDispatchResult): DispatchResult => r.accepted
      ? { accepted: true, attempt: r.attempt }
      : { accepted: false, reason: r.reason === 'not_parked' ? 'not_parked' : 'already_live', attempt: r.attempt, status: r.status };

    const leasedTo = this.state.leasedTo;
    const leasedKey = leasedTo ? parseLeaseName(leasedTo) : null;
    if (leasedTo && leasedKey && !this.supervisor.hasLiveRun) {
      try {
        const r = await (await this.leaseAgent(leasedTo)).dispatchLeased({ ...req, taskId: this.name, workspaceId: leasedKey.workspaceId });
        // The lease still has this task (a duplicate, or its resume): its answer stands.
        if (r.accepted || r.reason === 'already_live' || req.resumeWorkerId) return strip(r);
      } catch (err) {
        console.log(`[cloud-runner] task ${this.name}: lease ${leasedTo} unreachable: ${err instanceof Error ? err.message : String(err)}`);
        if (req.resumeWorkerId) return { accepted: false, reason: 'not_parked', attempt: this.state.attempt, status: this.state.status };
      }
    }

    const live = this.state.status === 'starting' || this.state.status === 'running';
    if (req.resumeWorkerId || !req.workspaceId || !containerReuseEnabled(this.env, req.warmHandover) || live || this.supervisor.hasLiveRun) {
      return this.supervisor.dispatch(req);
    }
    if (this.routing || this.state.routePending) return { accepted: false, reason: 'already_live', attempt: this.state.attempt, status: this.state.status };
    this.routing = true;
    let held = false;
    try {
      const routed = await routeToLease(this.routeDeps(), this.routeArgs(req));
      if (routed.lease !== null) return this.ranOnLease(routed);
      if (routed.tails.length) {
        // A lease is in its tail: wait for it to go warm, in the background.
        // buildd's webhook is answered now (it must be fast); a duplicate
        // meanwhile is a duplicate, and a restart routes the held dispatch at
        // once (onStart). The attempt number is the one this agent would use.
        held = true;
        this.setState({ ...this.state, routePending: { since: Date.now(), request: req } });
        this.ctx.waitUntil(this.keepAliveWhile(() => this.routeAfterTail(req, routed.tails)).finally(() => { this.routing = false; }));
        return { accepted: true, attempt: this.state.attempt + 1 };
      }
    } finally {
      if (!held) this.routing = false;
    }
    // Every slot busy: run here, as without reuse. The fresh state drops `leasedTo`.
    return this.supervisor.dispatch(req);
  }

  private routeDeps() {
    return { getLease: (name: string) => this.leaseAgent(name), log: (m: string) => console.log(m), sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)), now: () => Date.now() };
  }

  private routeArgs(req: DispatchRequest & { workspaceId?: string }) {
    return { taskId: this.name, workspaceId: req.workspaceId!, size: this.runnerSize, slots: resolveReuseSlots(this.env, this.runnerSize), request: req };
  }

  private ranOnLease(routed: Routed): DispatchResult {
    const { routePending: _held, ...rest } = this.state;
    this.setState({ ...rest, leasedTo: routed.lease });
    console.log(`[cloud-runner] task ${this.name}: running in ${routed.lease}${routed.result.reused ? ' (warm container)' : ''}`);
    return { accepted: true, attempt: routed.result.attempt };
  }

  /**
   * The held dispatch: the lease in its tail if it goes warm in time, else
   * any warm or idle lease, else this agent. Never throws.
   */
  private async routeAfterTail(req: DispatchRequest, tails: string[], maxWaitMs?: number): Promise<void> {
    const start = this.state.routePending?.since ?? Date.now();
    try {
      const args = this.routeArgs(req);
      let routed: Routed | null = await waitForTailLease(this.routeDeps(), { ...args, tails, since: start, ...(maxWaitMs !== undefined ? { maxWaitMs } : {}) });
      const leaseWaitMs = Date.now() - start;
      if (!routed) {
        const again = await routeToLease(this.routeDeps(), { ...args, request: { ...req, leaseWaitMs } });
        routed = again.lease !== null ? again : null;
      }
      if (routed) { this.ranOnLease(routed); return; }
      const { routePending: _held, ...rest } = this.state;
      this.setState(rest);
      const r = this.supervisor.dispatch({ ...req, leaseWaitMs });
      console.log(`[cloud-runner] task ${this.name}: no lease after ${Math.round(leaseWaitMs / 1000)}s; running here (${JSON.stringify(r)})`);
    } catch (err) {
      console.log(`[cloud-runner] task ${this.name}: routing the held dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      if (this.state.routePending) {
        const { routePending: _held, ...rest } = this.state;
        this.setState(rest);
        this.supervisor.dispatch({ ...req, leaseWaitMs: Date.now() - start });
      }
    }
  }

  /** RPC from a task agent: run its task in this lease (container-lease.ts). */
  async dispatchLeased(request: LeasedDispatchRequest): Promise<LeasedDispatchResult> {
    if (!this.lease || !this.ctx.container) {
      return { accepted: false, reason: 'busy', attempt: this.state.attempt, status: this.state.status };
    }
    const runnerSize = normalizeRunnerSizeDecision(request.runnerSize) ?? undefined;
    return this.supervisor.dispatchLeased({ ...request, runnerSize });
  }

  /** Agents SDK schedule callback on a lease: the warm window ended. */
  async expireWarmContainer(): Promise<void> {
    if (!this.lease || !this.ctx.container) return;
    try {
      await this.supervisor.expireWarmContainer();
    } catch (err) {
      console.log(`[cloud-runner] ${this.name}: warm expiry failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** RPC from the dispatcher Worker for `task.scheduled`: start a run at `notBefore` (epoch ms). */
  async scheduleDispatch(notBefore: number, runnerSize?: unknown): Promise<ScheduleDispatchResult> {
    return this.supervisor.scheduleDispatch(notBefore, { runnerSize: normalizeRunnerSizeDecision(runnerSize) ?? undefined });
  }

  /**
   * Agents SDK schedule callback: the `task.scheduled` wake is due. The SDK
   * passes the schedule row, whose id tells the latest wake from a replaced
   * one. Never throws, so the SDK has nothing to retry.
   */
  async runScheduledDispatch(payload: ScheduledDispatchPayload, schedule?: { id: string }): Promise<void> {
    if (!this.ctx.container) return;
    try {
      const result = this.supervisor.fireScheduledDispatch(payload, schedule?.id);
      console.log(`[cloud-runner] task ${this.name}: scheduled dispatch fired: ${JSON.stringify(result)}`);
    } catch (err) {
      console.log(`[cloud-runner] task ${this.name}: scheduled dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * RPC from the dispatcher Worker, for the debug `POST /tasks/:taskId/kill`.
   * Destroys the container without touching run state, so the supervisor
   * sees exactly what an OOM kill or a platform stop produces.
   */
  async killContainer(): Promise<{ killed: boolean }> {
    const leasedTo = !this.lease ? this.state.leasedTo : undefined;
    if (leasedTo) {
      const lease = await this.leaseAgent(leasedTo);
      // Only while the lease still runs this task: never another task's container.
      if ((await lease.getRunState()).taskId === this.name) return lease.killContainer();
      return { killed: false };
    }
    const container = this.ctx.container;
    if (!container?.running) return { killed: false };
    console.log(`[cloud-runner] task ${this.name}: debug kill requested; destroying the container`);
    await container.destroy('debug kill');
    return { killed: true };
  }

  /**
   * RPC from the dispatcher Worker, for `GET /tasks/:taskId`. A task on a
   * lease answers with the lease's state while the lease still has it, else
   * with its last report there.
   */
  async getRunState(): Promise<RunState> {
    const leasedTo = !this.lease ? this.state.leasedTo : undefined;
    if (!leasedTo) return this.supervisor.status();
    try {
      const st = await (await this.leaseAgent(leasedTo)).getRunState();
      return taskStateOnLease(this.name, leasedTo, st, this.state);
    } catch (err) {
      console.log(`[cloud-runner] task ${this.name}: lease ${leasedTo} unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return { ...this.supervisor.status(), leasedTo };
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === BROWSER_BRIDGE_HOST) {
      return this.browserRequest(request.headers.get('x-buildd-browser-task') ?? '', request);
    }
    return super.fetch(request);
  }

  /** Egress identity is supplied by interception, never a task id from the client. */
  async browserRequest(taskId: string, request: Request): Promise<Response> {
    if (taskId !== this.taskId || !this.browserBridge || !this.supervisor.hasLiveRun) {
      return Response.json({ code: 'session_revoked' }, { status: 401 });
    }
    return handleScopedBrowserRequest(taskId, this.taskId, this.browserBridge, request);
  }

  /**
   * RPC from EgressHandler: one request seen, or one response body's size.
   * Counts only; no URL or header ever crosses this call (run-report.ts
   * EgressEvent). Ignored unless a run is live.
   */
  async recordEgress(event: unknown): Promise<void> {
    if (!this.ctx.container) return;
    this.supervisor.recordEgress(event);
  }

  /**
   * The installation token for this task's repo. Memory only: not in agent
   * state or storage, and never in the container env. Refetched near expiry.
   */
  private readonly githubTokens = new GithubTokenCache({
    fetchGrant: () => this.fetchGithubGrant(),
    now: () => Date.now(),
    log: (m) => console.log(`${m} (task ${this.name})`),
    // Into the run report (egressDetail.github.grantFetchFailures): status only.
    onFailure: (status) => { if (this.ctx.container) this.supervisor.recordEgress({ type: 'grant_failure', cls: 'github', status }); },
  });

  /**
   * RPC from EgressHandler when the container talks to GitHub. Only while a
   * run is live: an exited run's container is gone, and nothing else should
   * be able to pull a token out of this agent. Says why when there is no
   * grant, so the run report can count unauthenticated GitHub requests.
   */
  async getGithubGrant(): Promise<GithubGrantLookup> {
    const live = this.state.status === 'starting' || this.state.status === 'running';
    const lease = this.lease;
    return lookupGithubGrant(live, async () => {
      const grant = await this.githubTokens.get();
      // A lease serves one workspace: a grant for any other is never handed out.
      return lease && grant?.workspaceId && grant.workspaceId !== lease.workspaceId ? null : grant;
    });
  }

  /**
   * RPC from EgressHandler for the snapshot host: whose keys this run may
   * touch. Only while a run is live and warm repos are on. The workspace ID
   * is the one buildd returned with the GitHub grant (authenticated with the
   * dispatch token), never anything the container or the webhook body said.
   */
  async getSnapshotScope(): Promise<SnapshotScope | null> {
    if (!warmReposEnabled(this.env) && !resumableRunsEnabled(this.env)) return null;
    const lease = this.lease;
    // A lease's deferred warm upload, after its run: the lease's own
    // workspace (from buildd's runner-size answer), warm keys only (no worker,
    // so no park bundle), with the cap the run's grant carried.
    if (lease && this.state.warmUploadSince !== undefined && this.state.status !== 'starting' && this.state.status !== 'running') {
      return { workspaceId: lease.workspaceId, ...(this.state.snapshotMaxBytes ? { maxBytes: this.state.snapshotMaxBytes } : {}) };
    }
    if (this.state.status !== 'starting' && this.state.status !== 'running') return null;
    const grant = await this.githubTokens.get();
    if (!grant?.workspaceId) return null;
    if (lease && grant.workspaceId !== lease.workspaceId) return null;
    if (lease && grant.warmSnapshotMaxBytes !== this.state.snapshotMaxBytes) {
      const { snapshotMaxBytes: _old, ...rest } = this.state;
      this.setState({ ...rest, ...(grant.warmSnapshotMaxBytes ? { snapshotMaxBytes: grant.warmSnapshotMaxBytes } : {}) });
    }
    // The worker is the one this agent is running (its claim line, or the
    // task.resume it was dispatched with), so a park bundle is only ever
    // this run's own.
    return {
      workspaceId: grant.workspaceId,
      ...(this.state.workerId ? { workerId: this.state.workerId } : {}),
      // The workspace's own warm cap (gitConfig.warmSnapshot.maxBytes), from
      // the same authenticated grant; the Worker default applies without it.
      ...(grant.warmSnapshotMaxBytes ? { maxBytes: grant.warmSnapshotMaxBytes } : {}),
    };
  }

  /**
   * Asks buildd for a token scoped to this task's repo. Fetched lazily on the
   * container's first GitHub request, which comes after the claim (the clone
   * runs inside claimAndStart), so the task already has this account's worker.
   */
  private async fetchGithubGrant(): Promise<GithubGrant> {
    const { url, init } = githubTokenRequest(this.env, this.taskId, this.state.workerId);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(GITHUB_TOKEN_TIMEOUT_MS) });
    if (!res.ok) {
      // The refusal's body is buildd's fixed error text, never a token.
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new GrantFetchError(res.status, detail);
    }
    return parseGithubGrant(await res.json());
  }

  /**
   * A fresh per-task token for each run, minted with the Worker's runner key.
   * The container is started with this token and never sees the runner key.
   */
  private async mintTaskToken(): Promise<string> {
    const { url, init } = taskTokenRequest(this.env, this.taskId);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TASK_TOKEN_TIMEOUT_MS) });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`POST ${new URL(url).pathname} returned ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const body = await res.json() as { roleSlug?: string };
    const token = parseTaskTokenResponse(body, this.taskId);
    this.browserSessionToken = undefined;
    if (body.roleSlug === 'visual-auditor' && this.env.BROWSER_BRIDGE === '1' && this.env.BROWSER) {
      this.browserSessionToken = crypto.randomUUID() + crypto.randomUUID();
    }
    return token;
  }

  /**
   * The team's agent model endpoint for this task (docs/design/agent-model-endpoint.md §3).
   * Memory only: not in agent state or storage, and never in the container env.
   */
  private readonly modelEndpoints = new ModelEndpointCache({
    fetchEndpoint: () => this.fetchModelEndpoint(),
    now: () => Date.now(),
    log: (m) => console.log(m),
  });

  /** RPC from EgressHandler on a model request. Only while a run is live. */
  async getModelEndpoint(): Promise<ServerModelEndpointState> {
    if (this.state.status !== 'starting' && this.state.status !== 'running') return null;
    return this.modelEndpoints.get();
  }

  // ── Owner seat (owner-seat.ts) ──
  // The token itself never reaches the agent's state, RPC surface or logs: it
  // is read from env by the egress handler alone. Here: slots and a label.

  private ownerSeatRunInstance: OwnerSeatRun | null = null;

  private get ownerSeatRun(): OwnerSeatRun {
    if (this.ownerSeatRunInstance) return this.ownerSeatRunInstance;
    const agent = this;
    const gate = async () => (await getAgentByName(this.env.WorkerAgent, OWNER_SEAT_GATE_NAME)) as unknown as {
      seatGateAcquire(taskId: string, cap: number): Promise<SeatAcquire>;
      seatGateRelease(taskId: string): Promise<void>;
      seatGateWall(untilMs: number): Promise<void>;
    };
    this.ownerSeatRunInstance = new OwnerSeatRun({
      get taskId() { return agent.taskId; },
      gate: {
        acquire: async (taskId) => (await gate()).seatGateAcquire(taskId, ownerSeatCap(this.env)),
        release: async (taskId) => (await gate()).seatGateRelease(taskId),
        wall: async (untilMs) => (await gate()).seatGateWall(untilMs),
      },
      now: () => Date.now(),
      log: (m) => console.log(m),
    });
    return this.ownerSeatRunInstance;
  }

  /** RPC from EgressHandler before a model request goes out (seat route or not). Only while a run is live. */
  async noteModelRoute(seat: boolean): Promise<SeatRouteDecision> {
    if (!ownerSeatEnabled(this.env) || (this.state.status !== 'starting' && this.state.status !== 'running')) return { proceed: true };
    return this.ownerSeatRun.noteRoute(seat);
  }

  /** RPC from EgressHandler when the seat route answered 429. Header values only. */
  async noteOwnerSeatWall(headers: { retryAfter: string | null; reset: string | null }): Promise<void> {
    if (!ownerSeatEnabled(this.env)) return;
    await this.ownerSeatRun.noteWall(headers);
  }

  // The gate: this Worker's one shared counter, kept by the WorkerAgent named
  // OWNER_SEAT_GATE_NAME (never a task, never a lease). Durable Object input
  // gates make each of these a single atomic step.
  private async readSeatGate(): Promise<SeatGateState> {
    return (await this.ctx.storage.get<SeatGateState>('ownerSeatGate')) ?? EMPTY_SEAT_GATE;
  }

  async seatGateAcquire(taskId: string, cap: number): Promise<SeatAcquire> {
    if (this.name !== OWNER_SEAT_GATE_NAME) throw new Error('not the owner seat gate');
    const r = acquireSeat(await this.readSeatGate(), taskId, Date.now(), cap);
    await this.ctx.storage.put('ownerSeatGate', r.state);
    return r.result;
  }

  async seatGateRelease(taskId: string): Promise<void> {
    if (this.name !== OWNER_SEAT_GATE_NAME) throw new Error('not the owner seat gate');
    await this.ctx.storage.put('ownerSeatGate', releaseSeat(await this.readSeatGate(), taskId, Date.now()));
  }

  async seatGateWall(untilMs: number): Promise<void> {
    if (this.name !== OWNER_SEAT_GATE_NAME) throw new Error('not the owner seat gate');
    await this.ctx.storage.put('ownerSeatGate', markSeatWall(await this.readSeatGate(), untilMs, Date.now()));
  }

  /** RPC from EgressHandler after the endpoint answered 401 (endpointRejectedKey). */
  async reportModelEndpointAuthFailure(): Promise<void> {
    this.modelEndpoints.invalidate();
  }

  private async fetchModelEndpoint(): Promise<ServerModelEndpoint> {
    const { url, init } = modelEndpointRequest(this.env, this.taskId, this.state.workerId);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(MODEL_ENDPOINT_TIMEOUT_MS) });
    if (res.status === 404) throw new NoModelEndpointError();
    if (!res.ok) {
      // The body of a refusal carries no key; still, keep it short.
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`POST ${new URL(url).pathname} returned ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return parseServerModelEndpoint(await res.json());
  }

  /**
   * Route the container's traffic for the credentialed hosts through
   * EgressHandler (egress.ts; rules in outbound.ts). HTTPS is re-signed with
   * the per-container CA that buildd-once trusts; plain HTTP to the same hosts
   * is intercepted too, and refused by the handler. So is the OTLP collector's
   * host when OTEL_EXPORTER_OTLP_ENDPOINT is set. Every other host keeps
   * open egress. Called before each start, so each run gets a fresh token.
   */
  private async installEgressHandlers(): Promise<void> {
    if (this.browserBridge) await this.browserBridge.close();
    this.browserBridge = null;
    if (this.env.BROWSER_BRIDGE === '1' && this.env.BROWSER && this.browserSessionToken) {
      this.browserBridge = new BrowserBridge({
        token: this.browserSessionToken,
        browser: bindingBrowserPort(this.env.BROWSER),
        fetchService: (port, request) => this.ctx.container!.getTcpPort(port).fetch(request),
      });
    }
    this.githubTokens.reset();
    this.modelEndpoints.reset();
    const container = this.ctx.container;
    if (!container) throw new Error('WorkerAgent has no container binding');
    const exports = (this.ctx as unknown as { exports: EgressExports }).exports;
    // The handler calls back into THIS agent (agentName) about THIS run's task.
    const handler = exports.EgressHandler({ props: { taskId: this.taskId, agentName: this.name, runnerSize: this.runnerSize } });
    for (const host of INTERCEPTED_HOSTS) {
      await container.interceptOutboundHttps(host, handler);
      await container.interceptOutboundHttp(host, handler);
    }
    // The browser pseudo-host is served only by this run's agent.
    if (this.browserBridge) await container.interceptOutboundHttps(BROWSER_BRIDGE_HOST, handler);
    // The OTLP collector's host, when one is configured (otel.ts); nothing otherwise.
    const otlp = otlpInterceptHosts(this.env);
    for (const host of otlp.https) await container.interceptOutboundHttps(host, handler);
    for (const host of otlp.http) await container.interceptOutboundHttp(host, handler);
    // The snapshot pseudo-host, HTTPS only, and only with warm repos or
    // resumable runs on.
    if (warmReposEnabled(this.env) || resumableRunsEnabled(this.env)) {
      await container.interceptOutboundHttps(SNAPSHOT_HOST, handler);
    }
  }
}

/**
 * The same agent on the large container class (standard-3; wrangler.jsonc
 * `WorkerAgentLarge`). Only the class differs: buildd picks it per task at
 * dispatch (runner-class.ts), and everything a run does is the same.
 */
export class WorkerAgentLarge extends WorkerAgent {
  protected override get runnerSize(): RunnerSize {
    return 'large';
  }
}
