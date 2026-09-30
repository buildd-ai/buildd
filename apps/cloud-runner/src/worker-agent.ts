/**
 * One Durable Object (Agents SDK agent) per buildd task, named by task ID, so
 * a duplicate webhook for the same task reaches the same instance. It owns one
 * container and supervises one `buildd-once --task <id>` process at a time.
 *
 * The run logic lives in supervisor.ts and the decisions in lifecycle.ts; this
 * class only wires them to `this.ctx.container`, agent state and keepAlive.
 * Design: docs/design/cloudflare-sandbox-runner.md, Components 3.
 */
import { Agent } from 'agents';
import type { Env } from './env';
import {
  INITIAL_STATE,
  resolveInactivityTimeoutMs,
  resolveStartTimeoutMs,
  type RunState,
} from './lifecycle';
import { TaskSupervisor, type ContainerPort, type DispatchResult } from './supervisor';

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
        ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
        MODEL: env.MODEL,
        PUSHER_KEY: env.PUSHER_KEY,
        PUSHER_CLUSTER: env.PUSHER_CLUSTER,
        BUILDD_ONCE_MAX_WAIT_MS: env.BUILDD_ONCE_MAX_WAIT_MS,
        DEV_ANTHROPIC_API_KEY: env.DEV_ANTHROPIC_API_KEY,
        inactivityTimeoutMs: resolveInactivityTimeoutMs(env),
        startTimeoutMs: resolveStartTimeoutMs(env),
      },
      keepAliveWhile: (fn) => this.keepAliveWhile(fn),
      waitUntil: (p) => this.ctx.waitUntil(p),
      installEgress: () => this.installEgressHandlers(),
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
   * Egress credential injection hook (design Components 4, next step). It
   * will route the container's outbound HTTPS through a Worker entrypoint with
   * `this.ctx.container.interceptOutboundHttps(host, this.ctx.exports.<Egress>(...))`:
   *   api.anthropic.com         -> AI Gateway, placeholder key swapped for the gateway token
   *   github.com, api.github.com -> + short-lived installation token
   * Until then this is a no-op, so the container has open egress and no
   * model or GitHub credential.
   */
  private async installEgressHandlers(): Promise<void> {}
}
