/**
 * The origin the MCP routes send their internal REST calls to. Each of those
 * calls carries the caller's bearer, so the origin must be this server and
 * nothing else. It comes from this server's own configuration, in order:
 *
 *   1. `VERCEL_URL`: this deployment's own host on Vercel.
 *   2. `NEXTAUTH_URL`, else `AUTH_URL`: the operator-set origin elsewhere.
 *   3. The request's own origin, only when NODE_ENV is not `production` and its
 *      host is loopback (`localhost`, `127.0.0.1`, `::1`): a local dev server.
 *      The Host header is caller-controlled, so in production, or for any
 *      other host, the request never picks the destination.
 *
 * When none applies the result is null and the route refuses with
 * `selfOriginUnconfiguredResponse()`. There is no hardcoded fallback host: a
 * server that cannot name itself must not send a bearer to some other one.
 */

type Env = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function httpOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

export function resolveSelfOrigin(req?: Request, env: Env = process.env): string | null {
  const vercel = env.VERCEL_URL?.trim();
  if (vercel) {
    const origin = httpOrigin(`https://${vercel.replace(/\/+$/, '')}`);
    if (origin) return origin;
  }
  const configured = httpOrigin(env.NEXTAUTH_URL) ?? httpOrigin(env.AUTH_URL);
  if (configured) return configured;
  if (req && env.NODE_ENV !== 'production') {
    try {
      const u = new URL(req.url);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname)) return u.origin;
    } catch {
      // fall through
    }
  }
  return null;
}

export function selfOriginUnconfiguredResponse(): Response {
  return new Response(JSON.stringify({
    error: 'self_origin_unconfigured',
    message: "This server cannot resolve its own origin for internal calls. Set NEXTAUTH_URL to this deployment's public origin.",
  }), { status: 500, headers: { 'Content-Type': 'application/json' } });
}
