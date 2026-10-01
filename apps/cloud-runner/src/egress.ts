/**
 * The Worker entrypoint the container's outbound HTTP(S) is routed through
 * (`ctx.container.interceptOutboundHttps(host, ctx.exports.EgressHandler(...))`,
 * registered by `WorkerAgent.installEgressHandlers`). It runs in the Workers
 * runtime, outside the container, and holds the only copies of the model and
 * GitHub credentials the container's traffic ends up using.
 *
 * All decisions are in outbound.ts (pure, Bun-tested). This file does the
 * I/O: ask the task's WorkerAgent for the GitHub grant, then forward.
 * Design: docs/design/cloudflare-sandbox-runner.md, Components 4.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { getAgentByName } from 'agents';
import type { Env } from './env';
import {
  classifyEgressHost,
  describeForwardForDebug,
  needsServerModelEndpoint,
  resolveModelRoute,
  rewriteOutbound,
  type GithubGrant,
  type ServerModelEndpointState,
} from './outbound';
import { rewriteOtlp } from './otel';
import { countResponseBytes, egressClassForKind, type EgressClass, type EgressEvent } from './run-report';
import { resumableRunsEnabled, warmReposEnabled } from './lifecycle';
import { SnapshotStore, handleSnapshotRequest, type BucketPort, type SnapshotScope } from './snapshots';

export interface EgressProps {
  /** The task whose container this handler serves. Set by the WorkerAgent, never by the container. */
  taskId: string;
}

interface AgentSource {
  getGithubGrant(): Promise<GithubGrant | null>;
  getSnapshotScope(): Promise<SnapshotScope | null>;
  recordEgress(event: EgressEvent): Promise<void>;
  getModelEndpoint(): Promise<ServerModelEndpointState>;
  reportModelEndpointAuthFailure(): Promise<void>;
}

export class EgressHandler extends WorkerEntrypoint<Env, EgressProps> {
  async fetch(request: Request): Promise<Response> {
    const at = Date.now();
    // The OTLP collector, only when OTEL_EXPORTER_OTLP_ENDPOINT is set and this
    // is its exact origin (otel.ts). Otherwise null and nothing below changes.
    const otlp = rewriteOtlp({ url: request.url, headers: request.headers }, this.env);
    if (otlp) return this.forwardOtlp(request, otlp, at);
    const kind = classifyEgressHost(new URL(request.url).hostname);
    if (kind === 'snapshot') return this.snapshot(request);
    const cls = egressClassForKind(kind);
    if (kind === 'passthrough') return this.counted('passthrough', at, fetch(request));

    const github = kind === 'github' ? await this.githubGrant() : null;
    // The team's agent model endpoint, only when neither the local direct
    // route nor the Worker's MODEL_PROXY_URL override would win anyway.
    const server = kind === 'anthropic' && needsServerModelEndpoint(this.env) ? await this.modelEndpoint() : null;
    const viaServer = !!server && server !== 'unavailable';
    const decision = rewriteOutbound(
      { url: request.url, method: request.method, headers: request.headers },
      { model: resolveModelRoute(this.env, server), github },
    );
    if (decision.action === 'passthrough') return this.counted('passthrough', at, fetch(request));
    if (decision.action === 'reject') {
      this.record({ type: 'request', cls, at, rejected: true });
      return new Response(`${decision.message}\n`, { status: decision.status });
    }
    if (this.env.EGRESS_DEBUG_ECHO === '1') {
      // Local smoke only: show what would be sent (values fingerprinted).
      return this.counted(cls, at, Promise.resolve(Response.json(await describeForwardForDebug(decision), { headers: { 'x-buildd-egress-echo': '1' } })));
    }
    // redirect: 'manual' so a redirect goes back to the container, which
    // follows it itself. The Worker never carries an injected credential to a
    // redirect target.
    const res = fetch(decision.url, {
      method: request.method,
      headers: decision.headers,
      body: request.body,
      redirect: 'manual',
    }).then((r) => {
      if (viaServer && (r.status === 401 || r.status === 403)) {
        // The endpoint rejected its key: have the agent drop it and refetch
        // after a short backoff (a rotated key then takes effect mid-run).
        void this.agent().then(a => a?.reportModelEndpointAuthFailure()).catch(() => {});
      }
      return r;
    });
    return this.counted(cls, at, res);
  }

  /** An OTLP export: counted as passthrough in the run report (it is not model or GitHub traffic). */
  private async forwardOtlp(request: Request, decision: NonNullable<ReturnType<typeof rewriteOtlp>>, at: number): Promise<Response> {
    if (decision.action === 'reject') {
      this.record({ type: 'request', cls: 'passthrough', at, rejected: true });
      return new Response(`${decision.message}\n`, { status: decision.status });
    }
    if (decision.action !== 'forward') return this.counted('passthrough', at, fetch(request));
    if (this.env.EGRESS_DEBUG_ECHO === '1') {
      // Local smoke only: the path and what was injected, never a value.
      console.log(`[cloud-runner] otlp echo ${new URL(decision.url).pathname} injected=${decision.injected}`);
      return this.counted('passthrough', at, Promise.resolve(Response.json(await describeForwardForDebug(decision), { headers: { 'x-buildd-egress-echo': '1' } })));
    }
    return this.counted('passthrough', at, fetch(decision.url, {
      method: request.method,
      headers: decision.headers,
      body: request.body,
      redirect: 'manual',
    }));
  }

  /**
   * Count the request for the run report, and its response bytes once the
   * container has read the body. Only the class, a timestamp and a byte count
   * leave this handler; never the URL or a header.
   */
  private async counted(cls: EgressClass, at: number, response: Promise<Response>): Promise<Response> {
    this.record({ type: 'request', cls, at });
    return countResponseBytes(await response, (bytes) => this.record({ type: 'bytes', cls, bytes }));
  }

  /** Fire-and-forget: the report is best effort and must never slow a request. */
  private record(event: EgressEvent): void {
    const taskId = this.ctx.props?.taskId;
    if (!taskId) return;
    this.ctx.waitUntil((async () => {
      try {
        const agent = await this.agent();
        await agent?.recordEgress(event);
      } catch {
        // Counting is best effort.
      }
    })());
  }

  private async agent(): Promise<AgentSource | null> {
    const taskId = this.ctx.props?.taskId;
    if (!taskId) return null;
    return (await getAgentByName(this.env.WorkerAgent, taskId)) as unknown as AgentSource;
  }

  /** The task's agent model endpoint, from its WorkerAgent's in-memory cache. */
  private async modelEndpoint(): Promise<ServerModelEndpointState> {
    const taskId = this.ctx.props?.taskId;
    if (!taskId) return null;
    try {
      const agent = await this.agent();
      return agent ? await agent.getModelEndpoint() : null;
    } catch (err) {
      console.log(`[cloud-runner] task ${taskId}: model endpoint lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'unavailable';
    }
  }

  /**
   * The snapshot store (snapshots.ts), streamed to and from the R2 binding.
   * The scope (which workspace's keys) comes from the task's WorkerAgent,
   * never from the request. Not counted as egress: it never leaves Cloudflare.
   */
  private async snapshot(request: Request): Promise<Response> {
    const bucket = this.env.SNAPSHOTS;
    const enabled = { warm: warmReposEnabled(this.env), park: resumableRunsEnabled(this.env) };
    if (!bucket || (!enabled.warm && !enabled.park)) return Response.json({ error: 'unavailable' }, { status: 503 });
    let scope: SnapshotScope | null = null;
    const taskId = this.ctx.props?.taskId;
    if (taskId) {
      try {
        const agent = await this.agent();
        scope = agent ? await agent.getSnapshotScope() : null;
      } catch (err) {
        console.log(`[cloud-runner] task ${taskId}: snapshot scope lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return handleSnapshotRequest(request, scope, new SnapshotStore(bucket as unknown as BucketPort), {
      enabled,
      fixedLength: (body, length) => body.pipeThrough(new FixedLengthStream(length)),
    });
  }

  /** The task's installation token, from its WorkerAgent's in-memory cache. */
  private async githubGrant(): Promise<GithubGrant | null> {
    const taskId = this.ctx.props?.taskId;
    if (!taskId) return null;
    try {
      const agent = (await getAgentByName(this.env.WorkerAgent, taskId)) as unknown as AgentSource;
      return await agent.getGithubGrant();
    } catch (err) {
      console.log(`[cloud-runner] task ${taskId}: GitHub grant lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
