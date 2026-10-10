/**
 * Workers' fetch sends no User-Agent, and GitHub's API refuses a request
 * without one (403 "Request forbidden by administrative rules"). Node's fetch,
 * which the same handlers use on Vercel, always sends one. So every outbound
 * request that does not name a User-Agent gets this one; one that does is
 * left alone. Installed once, before any handler module loads.
 */
export const CONTROL_PLANE_USER_AGENT = 'buildd-control-plane';

export function withDefaultUserAgent(base: typeof fetch): typeof fetch {
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.has('user-agent')) return base(input, init);
    headers.set('user-agent', CONTROL_PLANE_USER_AGENT);
    return base(input, { ...init, headers });
  };
  return wrapped as typeof fetch;
}

let installed = false;
export function installOutboundFetch(): void {
  if (installed) return;
  globalThis.fetch = withDefaultUserAgent(globalThis.fetch.bind(globalThis));
  installed = true;
}
