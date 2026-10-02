/**
 * OpenTelemetry export for a cloud dispatch: pure decisions, no Workers
 * runtime imports, so Bun tests load this file directly.
 *
 * Claude Code has its own OpenTelemetry exporter (see README "Telemetry"). The
 * container only gets the non-secret settings that turn it on and say where to
 * send it; any collector credential is a Worker secret that the egress handler
 * adds for the configured endpoint's exact origin, after stripping whatever
 * the container supplied. Nothing here runs unless OTEL_EXPORTER_OTLP_ENDPOINT
 * is set: without it the container env and the egress rules are unchanged.
 */
import {
  AI_GATEWAY_HOST,
  INTERCEPTED_HOSTS,
  LOCAL_HTTP_HOSTS,
  stripContainerCredentials,
  type EgressDecision,
  type OutboundRequestLike,
} from './outbound';

// ── Config ────────────────────────────────────────────────────────────────────

/** Worker vars that shape the container's telemetry. None is secret. */
export interface OtelEnv {
  /** Base OTLP/HTTP endpoint; Claude Code appends `/v1/logs`, `/v1/metrics`, `/v1/traces`. */
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  /** `http/protobuf` (default) or `http/json`. gRPC is refused. */
  OTEL_EXPORTER_OTLP_PROTOCOL?: string;
  /** `1` passes Claude Code's OTEL_LOG_TOOL_DETAILS (tool arguments, Bash commands). Default off. */
  OTEL_LOG_TOOL_DETAILS?: string;
  /** `1` turns on Claude Code's beta span tracing, with one TRACEPARENT per dispatch. Default off. */
  OTEL_TRACES_BETA?: string;
}

/** What the egress handler reads: the vars above plus the collector credential (secrets). */
export interface OtelEgressEnv extends OtelEnv {
  /** Secret. Header name for the collector credential; defaults to `authorization`. */
  OTEL_EXPORTER_OTLP_AUTH_HEADER?: string;
  /** Secret. The header's full value, e.g. `Bearer <token>`. */
  OTEL_EXPORTER_OTLP_AUTH_VALUE?: string;
}

export type OtlpProtocol = 'http/protobuf' | 'http/json';
export const OTLP_DEFAULT_PROTOCOL: OtlpProtocol = 'http/protobuf';

export type OtlpConfig =
  | { ok: true; endpoint: string; origin: string; hostname: string; scheme: 'https' | 'http'; protocol: OtlpProtocol }
  | { ok: false; error: string };

/** Hosts whose rules live in outbound.ts. An OTLP endpoint there would fight them. */
const RESERVED_HOSTS: readonly string[] = [...INTERCEPTED_HOSTS, AI_GATEWAY_HOST];

/**
 * Validate the endpoint and protocol. `null` when no endpoint is set.
 * Same https rule as MODEL_PROXY_URL: plain http only for LOCAL_HTTP_HOSTS.
 */
export function parseOtlpConfig(env: OtelEnv): OtlpConfig | null {
  const raw = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'OTEL_EXPORTER_OTLP_ENDPOINT is not a valid URL' };
  }
  let scheme: 'https' | 'http';
  if (url.protocol === 'https:') scheme = 'https';
  else if (url.protocol === 'http:' && LOCAL_HTTP_HOSTS.includes(url.hostname)) scheme = 'http';
  else return { ok: false, error: `OTEL_EXPORTER_OTLP_ENDPOINT must be https (plain http only for ${LOCAL_HTTP_HOSTS.join(', ')})` };
  if (url.username || url.password || raw.includes('@')) {
    return { ok: false, error: 'OTEL_EXPORTER_OTLP_ENDPOINT must not carry credentials; set OTEL_EXPORTER_OTLP_AUTH_VALUE instead' };
  }
  if (url.search || url.hash || raw.includes('?') || raw.includes('#')) {
    return { ok: false, error: 'OTEL_EXPORTER_OTLP_ENDPOINT must not have a query or fragment' };
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (RESERVED_HOSTS.includes(hostname)) {
    return { ok: false, error: `OTEL_EXPORTER_OTLP_ENDPOINT must not be ${hostname}` };
  }
  const p = (env.OTEL_EXPORTER_OTLP_PROTOCOL ?? '').trim().toLowerCase();
  let protocol: OtlpProtocol;
  if (p === '' || p === 'http/protobuf') protocol = 'http/protobuf';
  else if (p === 'http/json') protocol = 'http/json';
  else if (p === 'grpc') return { ok: false, error: 'OTEL_EXPORTER_OTLP_PROTOCOL grpc is not supported: the egress handler forwards HTTP requests; use http/protobuf' };
  else return { ok: false, error: 'OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf or http/json' };
  return {
    ok: true,
    endpoint: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
    origin: url.origin,
    hostname,
    scheme,
    protocol,
  };
}

// ── Container env ─────────────────────────────────────────────────────────────

export interface DispatchIdentity {
  taskId: string;
  attempt: number;
  /** Known only after the claim; the runner adds it for the agent (apps/runner agent-env.ts). */
  workerId?: string;
}

/** `OTEL_RESOURCE_ATTRIBUTES` for one dispatch. Values percent-encoded as the spec requires. */
export function otlpResourceAttributes(run: DispatchIdentity): string {
  const attrs = [`buildd.task_id=${encodeURIComponent(run.taskId)}`, `buildd.attempt=${run.attempt}`];
  if (run.workerId) attrs.push(`buildd.worker_id=${encodeURIComponent(run.workerId)}`);
  return attrs.join(',');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

const defaultRandomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/**
 * The Claude Code telemetry variables for the container, or `{}` when no
 * endpoint is set. Never a credential and never OTEL_EXPORTER_OTLP_HEADERS:
 * the collector's auth is added at egress. Content stays redacted (no
 * OTEL_LOG_USER_PROMPTS / OTEL_LOG_TOOL_CONTENT); tool arguments only with
 * the OTEL_LOG_TOOL_DETAILS opt-in. Throws on an invalid endpoint, so a
 * misconfigured Worker fails the run before start instead of exporting
 * nothing without saying so.
 */
export function otelContainerEnv(
  env: OtelEnv,
  run: DispatchIdentity,
  deps: { randomBytes?: (n: number) => Uint8Array } = {},
): Record<string, string> {
  const config = parseOtlpConfig(env);
  if (!config) return {};
  if (!config.ok) throw new Error(config.error);
  const out: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_ENDPOINT: config.endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: config.protocol,
    OTEL_RESOURCE_ATTRIBUTES: otlpResourceAttributes(run),
  };
  if (env.OTEL_LOG_TOOL_DETAILS === '1') out.OTEL_LOG_TOOL_DETAILS = '1';
  if (env.OTEL_TRACES_BETA === '1') {
    const random = deps.randomBytes ?? defaultRandomBytes;
    out.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = '1';
    out.OTEL_TRACES_EXPORTER = 'otlp';
    // Agent SDK sessions read an inbound TRACEPARENT, so every prompt's
    // interaction span in this dispatch shares one trace ID.
    out.TRACEPARENT = `00-${hex(random(16))}-${hex(random(8))}-01`;
  }
  return out;
}

// ── Egress ────────────────────────────────────────────────────────────────────

/** Hosts to route through the egress handler for the OTLP endpoint. Empty when unset or invalid. */
export function otlpInterceptHosts(env: OtelEnv): { https: string[]; http: string[] } {
  const config = parseOtlpConfig(env);
  if (!config?.ok) return { https: [], http: [] };
  // For an https endpoint, plain http to the same host is intercepted too and
  // refused, as for the credentialed hosts in outbound.ts.
  return config.scheme === 'https'
    ? { https: [config.hostname], http: [config.hostname] }
    : { https: [], http: [config.hostname] };
}

const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const FORBIDDEN_AUTH_HEADERS = new Set(['host', 'content-length', 'content-type', 'content-encoding', 'transfer-encoding', 'connection', 'te', 'upgrade']);

function authHeaderName(env: OtelEgressEnv): string | null {
  const name = (env.OTEL_EXPORTER_OTLP_AUTH_HEADER ?? '').trim().toLowerCase() || 'authorization';
  return HEADER_NAME_RE.test(name) && !FORBIDDEN_AUTH_HEADERS.has(name) ? name : null;
}

/**
 * The egress decision for a request to the OTLP endpoint, or `null` when the
 * request is not one (no endpoint configured, or any other origin: a
 * look-alike host, another port, a subdomain). `null` means the caller's
 * existing rules apply unchanged.
 *
 * For the exact origin: container credentials (outbound.ts's list plus the
 * configured header) are stripped, then the Worker's own is set when
 * OTEL_EXPORTER_OTLP_AUTH_VALUE is. Plain http to an https endpoint's host
 * is refused. An unusable header name refuses the export rather than sending
 * it unauthenticated.
 */
export function rewriteOtlp(req: OutboundRequestLike, env: OtelEgressEnv): EgressDecision | null {
  const config = parseOtlpConfig(env);
  if (!config?.ok) return null;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host !== config.hostname) return null;
  if (config.scheme === 'https' && url.protocol === 'http:') {
    return { action: 'reject', status: 403, message: `${url.hostname} is reachable only over HTTPS`, reason: 'plain_http' };
  }
  if (url.origin !== config.origin) return null;

  const name = authHeaderName(env);
  if (!name) {
    return { action: 'reject', status: 503, message: 'telemetry egress is not configured: OTEL_EXPORTER_OTLP_AUTH_HEADER is not a usable header name', reason: 'unconfigured' };
  }
  const headers = stripContainerCredentials(req.headers);
  headers.delete(name);
  url.username = '';
  url.password = '';
  const value = env.OTEL_EXPORTER_OTLP_AUTH_VALUE;
  if (value) headers.set(name, value);
  return { action: 'forward', url: url.toString(), headers, injected: value ? 'otlp' : 'none' };
}
