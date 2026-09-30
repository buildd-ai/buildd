/**
 * One Durable Object (Agents SDK agent) per buildd task, named by task ID, so
 * a duplicate webhook for the same task reaches the same instance. It owns one
 * container and supervises one `buildd-once --task <id>` process at a time.
 *
 * The run logic lives in supervisor.ts and the decisions in lifecycle.ts; this
 * class only wires them to `this.ctx.container`, agent state and keepAlive.
 * Design: docs/design/cloudflare-sandbox-runner.md, Components 3 and 4.
 */
import { Agent } from 'agents';
import type { Env } from './env';
import {
  INITIAL_STATE,
  resolveInactivityTimeoutMs,
  resolveStartTimeoutMs,
  parseTaskTokenResponse,
  taskTokenRequest,
  type RunState,
} from './lifecycle';
import {
  GithubTokenCache,
  INTERCEPTED_HOSTS,
  ModelEndpointCache,
  NoModelEndpointError,
  githubTokenRequest,
  modelEndpointRequest,
  parseGithubGrant,
  parseServerModelEndpoint,
  type GithubGrant,
  type ServerModelEndpoint,
  type ServerModelEndpointState,
} from './outbound';
import type { EgressProps } from './egress';
import { TaskSupervisor, type ContainerPort, type DispatchResult } from './supervisor';

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

  private get supervisor(): TaskSupervisor {
    if (this.supervisorInstance) return this.supervisorInstance;
    const container = this.ctx.container;
    if (!container) throw new Error('WorkerAgent has no container binding (check wrangler.jsonc `containers`)');
    const env = this.env;
    this.supervisorInstance = new TaskSupervisor({
      taskId: this.name,
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
        inactivityTimeoutMs: resolveInactivityTimeoutMs(env),
        startTimeoutMs: resolveStartTimeoutMs(env),
        instanceType: env.CONTAINER_INSTANCE_TYPE,
        // No instance ID on ctx.container; the container is bound to this
        // Durable Object and Cloudflare identifies the instance by its ID
        // (run-report.ts, RunReport.containerInstanceId).
        containerInstanceId: this.ctx.id.toString(),
      },
      keepAliveWhile: (fn) => this.keepAliveWhile(fn),
      waitUntil: (p) => this.ctx.waitUntil(p),
      installEgress: () => this.installEgressHandlers(),
      mintTaskToken: () => this.mintTaskToken(),
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

  /** RPC from the dispatcher Worker. Idempotent while a run is live. */
  async dispatch(): Promise<DispatchResult> {
    return this.supervisor.dispatch();
  }

  /** RPC from the dispatcher Worker, for `GET /tasks/:taskId`. */
  async getRunState(): Promise<RunState> {
    return this.supervisor.status();
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
    log: (m) => console.log(m),
  });

  /**
   * RPC from EgressHandler when the container talks to GitHub. Only while a
   * run is live: an exited run's container is gone, and nothing else should
   * be able to pull a token out of this agent.
   */
  async getGithubGrant(): Promise<GithubGrant | null> {
    if (this.state.status !== 'starting' && this.state.status !== 'running') return null;
    return this.githubTokens.get();
  }

  /**
   * Asks buildd for a token scoped to this task's repo. Fetched lazily on the
   * container's first GitHub request, which comes after the claim (the clone
   * runs inside claimAndStart), so the task already has this account's worker.
   */
  private async fetchGithubGrant(): Promise<GithubGrant> {
    const { url, init } = githubTokenRequest(this.env, this.name, this.state.workerId);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(GITHUB_TOKEN_TIMEOUT_MS) });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`POST ${new URL(url).pathname} returned ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return parseGithubGrant(await res.json());
  }

  /**
   * A fresh per-task token for each run, minted with the Worker's runner key.
   * The container is started with this token and never sees the runner key.
   */
  private async mintTaskToken(): Promise<string> {
    const { url, init } = taskTokenRequest(this.env, this.name);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TASK_TOKEN_TIMEOUT_MS) });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`POST ${new URL(url).pathname} returned ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return parseTaskTokenResponse(await res.json(), this.name);
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

  /** RPC from EgressHandler after the endpoint answered 401/403. */
  async reportModelEndpointAuthFailure(): Promise<void> {
    this.modelEndpoints.invalidate();
  }

  private async fetchModelEndpoint(): Promise<ServerModelEndpoint> {
    const { url, init } = modelEndpointRequest(this.env, this.name, this.state.workerId);
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
   * is intercepted too, and refused by the handler. Every other host keeps
   * open egress. Called before each start, so each run gets a fresh token.
   */
  private async installEgressHandlers(): Promise<void> {
    this.githubTokens.reset();
    this.modelEndpoints.reset();
    const container = this.ctx.container;
    if (!container) throw new Error('WorkerAgent has no container binding');
    const exports = (this.ctx as unknown as { exports: EgressExports }).exports;
    const handler = exports.EgressHandler({ props: { taskId: this.name } });
    for (const host of INTERCEPTED_HOSTS) {
      await container.interceptOutboundHttps(host, handler);
      await container.interceptOutboundHttp(host, handler);
    }
  }
}
