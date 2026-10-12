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

const GITHUB_API = 'https://api.github.com';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A loopback origin, or null: anything else is ignored, so production never redirects GitHub. */
function loopbackOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' && LOOPBACK.has(u.hostname) ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * GITHUB_API_ORIGIN (a loopback origin, set only by `wrangler dev` in the
 * web-down e2e) sends `https://api.github.com/*` to a fake GitHub served on
 * that origin, the same model the kernel DB tests use. The handlers keep their
 * hardcoded GitHub URLs; only the host changes.
 */
export function withGithubApiOrigin(base: typeof fetch, origin: () => string | undefined): typeof fetch {
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const to = loopbackOrigin(origin());
    const url = input instanceof Request ? input.url : String(input);
    if (!to || !url.startsWith(`${GITHUB_API}/`)) return base(input, init);
    const moved = to + url.slice(GITHUB_API.length);
    return base(input instanceof Request ? new Request(moved, input) : moved, init);
  };
  return wrapped as typeof fetch;
}

let installed = false;
export function installOutboundFetch(): void {
  if (installed) return;
  const base = globalThis.fetch.bind(globalThis);
  globalThis.fetch = withDefaultUserAgent(withGithubApiOrigin(base, () => process.env.GITHUB_API_ORIGIN));
  installed = true;
}
