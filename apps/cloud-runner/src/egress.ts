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
import { classifyEgressHost, describeForwardForDebug, resolveModelRoute, rewriteOutbound, type GithubGrant } from './outbound';

export interface EgressProps {
  /** The task whose container this handler serves. Set by the WorkerAgent, never by the container. */
  taskId: string;
}

interface GrantSource {
  getGithubGrant(): Promise<GithubGrant | null>;
}

export class EgressHandler extends WorkerEntrypoint<Env, EgressProps> {
  async fetch(request: Request): Promise<Response> {
    const kind = classifyEgressHost(new URL(request.url).hostname);
    if (kind === 'passthrough') return fetch(request);

    const github = kind === 'github' ? await this.githubGrant() : null;
    const decision = rewriteOutbound(
      { url: request.url, headers: request.headers },
      { model: resolveModelRoute(this.env), github },
    );
    if (decision.action === 'passthrough') return fetch(request);
    if (decision.action === 'reject') {
      return new Response(`${decision.message}\n`, { status: decision.status });
    }
    if (this.env.EGRESS_DEBUG_ECHO === '1') {
      // Local smoke only: show what would be sent (values fingerprinted).
      return Response.json(await describeForwardForDebug(decision), { headers: { 'x-buildd-egress-echo': '1' } });
    }
    // redirect: 'manual' so a redirect goes back to the container, which
    // follows it itself. The Worker never carries an injected credential to a
    // redirect target.
    return fetch(decision.url, {
      method: request.method,
      headers: decision.headers,
      body: request.body,
      redirect: 'manual',
    });
  }

  /** The task's installation token, from its WorkerAgent's in-memory cache. */
  private async githubGrant(): Promise<GithubGrant | null> {
    const taskId = this.ctx.props?.taskId;
    if (!taskId) return null;
    try {
      const agent = (await getAgentByName(this.env.WorkerAgent, taskId)) as unknown as GrantSource;
      return await agent.getGithubGrant();
    } catch (err) {
      console.log(`[cloud-runner] task ${taskId}: GitHub grant lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
