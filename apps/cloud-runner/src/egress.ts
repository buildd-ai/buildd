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
  endpointRejectedKey,
  rewriteModelInBody,
  isClaudeModelId,
  latin1Decode,
  needsGithubBodyPeek,
  needsServerModelEndpoint,
  resolveModelRoute,
  rewriteOutbound,
  type GithubGrantLookup,
  type ServerModelEndpointState,
} from './outbound';
import { rewriteOtlp } from './otel';
import { measureResponse, egressClassForKind, inspectGithubThrottle, throttleLogLine, type EgressClass, type EgressEvent, type GithubAuthLabel } from './run-report';
import { resumableRunsEnabled, warmMaxBundleBytes, warmReposEnabled } from './lifecycle';
import { SnapshotStore, handleSnapshotRequest, type BucketPort, type SnapshotScope } from './snapshots';

export interface EgressProps {
  /** The task whose container this handler serves. Set by the WorkerAgent, never by the container. */
  taskId: string;
}

interface AgentSource {
  getGithubGrant(): Promise<GithubGrantLookup>;
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
    const reqUrl = new URL(request.url);
    const host = reqUrl.hostname;
    const kind = classifyEgressHost(host);
    if (kind === 'snapshot') return this.snapshot(request);
    const cls = egressClassForKind(kind);
    if (kind === 'passthrough') return this.counted('passthrough', at, fetch(request));

    const lookup = kind === 'github' ? await this.githubGrant() : null;
    // The team's agent model endpoint (or its own Anthropic key), skipped
    // only when the local direct route already wins: MODEL_PROXY_URL no
    // longer skips this, since a resolved Anthropic key must outrank it
    // (resolveModelRoute).
    const server = kind === 'anthropic' && needsServerModelEndpoint(this.env) ? await this.modelEndpoint() : null;
    const viaServer = !!server && server !== 'unavailable';
    // A bounded, inspection-only read of a `request.clone()` — the merge
    // guard's two body-dependent checks (a GraphQL mutation name, a pushed
    // branch name). The original `request.body` stream is untouched, so the
    // eventual forward below is unaffected whether or not this ran.
    const bodyPeek = kind === 'github' && needsGithubBodyPeek(host, request.method, reqUrl.pathname)
      ? await peekRequestBodyPrefix(request, host.toLowerCase() === 'api.github.com' ? GITHUB_JSON_PEEK_MAX_BYTES : GITHUB_BODY_PEEK_MAX_BYTES)
      : undefined;
    const decision = rewriteOutbound(
      { url: request.url, method: request.method, headers: request.headers, ...(bodyPeek !== undefined ? { bodyPeek } : {}) },
      {
        model: resolveModelRoute(this.env, server),
        github: lookup?.grant ?? null,
        ...(lookup && !lookup.grant ? { githubUnavailable: lookup.unavailable } : {}),
      },
    );
    if (decision.action === 'passthrough') return this.counted('passthrough', at, fetch(request));
    if (decision.action === 'respond') return this.counted(cls, at, Promise.resolve(new Response(null, { status: decision.status })));
    if (decision.action === 'reject') {
      this.record({ type: 'request', cls, at, rejected: true, reason: decision.reason, ...(decision.pathLabel ? { pathLabel: decision.pathLabel } : {}) });
      return new Response(`${decision.message}\n`, { status: decision.status });
    }
    if (this.env.EGRESS_DEBUG_ECHO === '1') {
      // Local smoke only: show what would be sent (values fingerprinted).
      return this.counted(cls, at, Promise.resolve(Response.json(await describeForwardForDebug(decision), { headers: { 'x-buildd-egress-echo': '1' } })));
    }
    // GitHub: whether our credential went with this request, or why not. A
    // fixed label only; no URL or header.
    const auth: GithubAuthLabel | undefined = kind === 'github' ? (decision.unauthenticated ?? 'credentialed') : undefined;
    // redirect: 'manual' so a redirect goes back to the container, which
    // follows it itself. The Worker never carries an injected credential to a
    // redirect target.
    let body: BodyInit | null = request.body;
    if (decision.mapModel) {
      // The team endpoint's model names (aliases, or OpenRouter ids), as a
      // host runner would send them. Only `model` changes.
      const text = await request.text();
      const mapped = rewriteModelInBody(text, decision.mapModel);
      body = mapped ?? text;
      if (mapped !== null) {
        decision.headers.delete('content-length');
        // Anthropic betas mean nothing to another vendor's model behind a proxy.
        const target = (JSON.parse(mapped) as { model: string }).model;
        if (!isClaudeModelId(target)) decision.headers.delete('anthropic-beta');
      }
    }
    const res = fetch(decision.url, {
      method: request.method,
      headers: decision.headers,
      body,
      redirect: 'manual',
    }).then((r) => {
      if (viaServer && endpointRejectedKey(r.status)) {
        // The endpoint rejected its key: have the agent drop it and refetch
        // after a short backoff (a rotated key then takes effect mid-run).
        void this.agent().then(a => a?.reportModelEndpointAuthFailure()).catch(() => {});
      }
      return r;
    });
    return this.counted(cls, at, res, auth, host);
  }

  /** An OTLP export: counted as passthrough in the run report (it is not model or GitHub traffic). */
  private async forwardOtlp(request: Request, decision: NonNullable<ReturnType<typeof rewriteOtlp>>, at: number): Promise<Response> {
    if (decision.action === 'reject') {
      this.record({ type: 'request', cls: 'passthrough', at, rejected: true, reason: decision.reason });
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
  private async counted(cls: EgressClass, at: number, response: Promise<Response>, auth?: GithubAuthLabel, host?: string): Promise<Response> {
    this.record({ type: 'request', cls, at, ...(auth ? { auth } : {}) });
    const res = await response;
    if (res.status >= 400) this.record({ type: 'status', cls, status: res.status, ...(auth ? { auth } : {}) });
    if (auth && host && (res.status === 429 || res.status === 403)) this.recordThrottle(res.clone(), host);
    return measureResponse(res, cls, (bytes) => this.record({ type: 'bytes', cls, bytes }));
  }

  /**
   * A GitHub 429 or 403: GitHub's rate-limit signals into the run report
   * (egressDetail.github.rateLimit) and one Worker log line with the task ID.
   * Reads at most THROTTLE_BODY_PREFIX_BYTES of a clone of the body, in the
   * background, and keeps nothing of it but a boolean. Best effort.
   */
  private recordThrottle(clone: Response, host: string): void {
    const taskId = this.ctx.props?.taskId ?? 'unknown';
    this.ctx.waitUntil(inspectGithubThrottle(clone, host).then((ev) => {
      if (!ev) return;
      this.record(ev);
      console.log(throttleLogLine(taskId, ev));
    }).catch(() => {}));
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
      // Streamed straight into R2 with its length: never read into memory.
      fixedLength: (body, length) => body.pipeThrough(new FixedLengthStream(length)),
      maxPartBytes: warmMaxBundleBytes(this.env),
    });
  }

  /** The task's installation token, from its WorkerAgent's in-memory cache, or why there is none. */
  private async githubGrant(): Promise<GithubGrantLookup> {
    const taskId = this.ctx.props?.taskId;
    if (!taskId) return { grant: null, unavailable: 'no_run' };
    try {
      const agent = (await getAgentByName(this.env.WorkerAgent, taskId)) as unknown as AgentSource;
      return await agent.getGithubGrant();
    } catch (err) {
      console.log(`[cloud-runner] task ${taskId}: GitHub grant lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return { grant: null, unavailable: 'fetch_failed' };
    }
  }
}

/** How much of a peeked GitHub request body to read, at most. Bounds both checks: a GraphQL mutation name and the pkt-line ref list ahead of a push's pack data. */
const GITHUB_BODY_PEEK_MAX_BYTES = 16 * 1024;

/**
 * The same bound for a JSON body to api.github.com (GraphQL, and REST ref
 * writes under the push allow-list). Larger, because the push allow-list
 * refuses a JSON body it cannot parse, and a cut-off prefix never parses: a
 * PR body or file content past this size is refused rather than guessed at.
 */
const GITHUB_JSON_PEEK_MAX_BYTES = 1024 * 1024;

/**
 * A bounded prefix of `request`'s body, read from an independent
 * `request.clone()` so the original stream is never touched — the merge
 * guard's decision in outbound.ts (`graphqlMutationBlocked`,
 * `pushedProtectedBranch`) is the only consumer, and it only ever reads this
 * text; the actual forward below always uses the untouched original request.
 */
async function peekRequestBodyPrefix(request: Request, maxBytes: number): Promise<string> {
  const body = request.clone().body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(size, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.length - off);
    buf.set(c.subarray(0, take), off);
    off += take;
    if (off >= buf.length) break;
  }
  return latin1Decode(buf);
}
