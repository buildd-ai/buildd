/**
 * Shared HTTP transport for control-plane calls.
 *
 * Owns: URL construction, auth header injection, per-request timeout, and a
 * pluggable outbound-body interceptor chain. Error handling, outbox queueing,
 * and retry logic stay in callers so each client can preserve its own
 * semantics. The raw Response is returned — callers decide what to do with
 * non-ok statuses.
 *
 * Interceptors are the hook point for outbound-body mutation (e.g. redaction).
 * They run in order before the body is sent. Shipped empty here — the
 * redaction task wires them in a later PR.
 */

/** Transforms an outbound request body before it leaves the process. */
export type BodyInterceptor = (body: string, route: string) => string;

export interface BuilddTransportConfig {
  /** Control-plane base URL, e.g. https://buildd.dev */
  baseUrl: string;
  /** API key sent as Bearer token in every request. */
  apiKey: string;
  /**
   * Per-request AbortSignal timeout in milliseconds.
   * Omit to send no timeout signal (matches apiCall() behavior in
   * buildd-mcp-server.ts). Set 30_000 for runner, 120_000 for ingest.
   */
  timeoutMs?: number;
  /**
   * Ordered list of outbound-body interceptors.
   * Each receives the serialized body string and the route path and must
   * return the (possibly mutated) body. Interceptors only run when a body is
   * present on the request.
   */
  interceptors?: BodyInterceptor[];
}

export interface BuilddTransportRequestInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  /** Caller-supplied abort signal. Takes precedence over the config timeout. */
  signal?: AbortSignal;
}

/**
 * Thin HTTP transport. Callers wrap this to add error handling, retry, and
 * outbox logic appropriate to their context.
 */
export class BuilddTransport {
  readonly config: BuilddTransportConfig;

  constructor(config: BuilddTransportConfig) {
    this.config = config;
  }

  async request(route: string, init: BuilddTransportRequestInit = {}): Promise<Response> {
    let body = init.body;

    if (body !== undefined && this.config.interceptors?.length) {
      for (const fn of this.config.interceptors) {
        body = fn(body, route);
      }
    }

    const signal = init.signal ??
      (this.config.timeoutMs != null ? AbortSignal.timeout(this.config.timeoutMs) : undefined);

    return fetch(`${this.config.baseUrl}${route}`, {
      method: init.method ?? 'GET',
      body,
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
        ...init.headers,
      },
    });
  }
}
