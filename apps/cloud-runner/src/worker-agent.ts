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
  parseGithubGrant,
  parseServerModelEndpoint,
  type GithubGrant,
  type GithubGrantLookup,
  type ServerModelEndpoint,
  type ServerModelEndpointState,
} from './outbound';
import type { EgressProps } from './egress';
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
    if (req.resumeWorkerId || !req.workspaceId || !containerReuseEnabled(this.env) || live || this.supervisor.hasLiveRun) {
      return this.supervisor.dispatch(req);
    }
    if (this.routing) return { accepted: false, reason: 'already_live', attempt: this.state.attempt, status: this.state.status };
    this.routing = true;
    try {
      const routed = await routeToLease(
        { getLease: (name) => this.leaseAgent(name), log: (m) => console.log(m) },
        { taskId: this.name, workspaceId: req.workspaceId, size: this.runnerSize, slots: resolveReuseSlots(this.env, this.runnerSize), request: req },
      );
      if (routed) {
        this.setState({ ...this.state, leasedTo: routed.lease });
        console.log(`[cloud-runner] task ${this.name}: running in ${routed.lease}${routed.result.reused ? ' (warm container)' : ''}`);
        return { accepted: true, attempt: routed.result.attempt };
      }
    } finally {
      this.routing = false;
    }
    // Every slot busy: run here, as without reuse. The fresh state drops `leasedTo`.
    return this.supervisor.dispatch(req);
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
    if (this.state.status !== 'starting' && this.state.status !== 'running') return null;
    const grant = await this.githubTokens.get();
    if (!grant?.workspaceId) return null;
    const lease = this.lease;
    if (lease && grant.workspaceId !== lease.workspaceId) return null;
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
    return parseTaskTokenResponse(await res.json(), this.taskId);
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
