import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import { proxy, config, MARKETING_PATHS, hasSessionCookie, apiReadProxy } from './proxy';
import type { ReadVerdict } from './lib/read-rate-limit';
import nextConfig from '../next.config.mjs';

const WWW = 'https://www.buildd.dev';

function req(url: string, opts: { host?: string; cookie?: string } = {}) {
  const u = new URL(url);
  const headers = new Headers({ host: opts.host ?? u.host });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  return new NextRequest(u, { headers });
}

function location(res: Response) {
  return res.headers.get('location');
}

/** NextResponse.next() carries this header; a redirect does not. */
function passedThrough(res: Response) {
  return res.headers.get('x-middleware-next') === '1';
}

describe('proxy: apex root', () => {
  it('sends a logged-out visitor on the apex to the marketing site', () => {
    const res = proxy(req('https://buildd.dev/'));
    expect(res.status).toBe(307);
    expect(location(res)).toBe(`${WWW}/`);
  });

  it('preserves the query string on the apex root redirect', () => {
    const res = proxy(req('https://buildd.dev/?utm_source=x&ref=y'));
    expect(location(res)).toBe(`${WWW}/?utm_source=x&ref=y`);
  });

  it('is temporary, never permanent — the answer depends on the cookie', () => {
    const res = proxy(req('https://buildd.dev/'));
    expect([301, 308]).not.toContain(res.status);
  });

  for (const cookie of [
    'authjs.session-token=abc',
    '__Secure-authjs.session-token=abc',
    '__Secure-authjs.session-token.0=abc; __Secure-authjs.session-token.1=def',
  ]) {
    it(`keeps a logged-in visitor in the app (${cookie.split('=')[0]})`, () => {
      const res = proxy(req('https://buildd.dev/', { cookie }));
      expect(res.status).toBe(307);
      expect(location(res)).toBe('https://buildd.dev/app/home');
    });
  }

  it('ignores unrelated and empty session-looking cookies', () => {
    const res = proxy(req('https://buildd.dev/', { cookie: 'authjs.csrf-token=x; authjs.session-token=' }));
    expect(location(res)).toBe(`${WWW}/`);
  });

  it('treats the apex host case-insensitively and with a port', () => {
    const res = proxy(req('https://buildd.dev/', { host: 'BUILDD.dev:443' }));
    expect(location(res)).toBe(`${WWW}/`);
  });

  for (const host of [
    'localhost:3000',
    'buildd-git-dev-example.vercel.app',
    'www.buildd.dev',
    'docs.buildd.dev',
    'evilbuildd.dev',
  ]) {
    it(`keeps the /app/home redirect for logged-out visitors on non-apex host ${host}`, () => {
      const res = proxy(req(`http://${host}/`, { host }));
      expect(res.status).toBe(307);
      expect(new URL(location(res)!).pathname).toBe('/app/home');
      expect(new URL(location(res)!).host).toBe(host);
    });
  }
});

describe('proxy: marketing paths', () => {
  it('lists exactly the pages the marketing site owns', () => {
    expect([...MARKETING_PATHS].sort()).toEqual(
      ['/ai-kit', '/integrations', '/memory', '/pricing', '/privacy', '/terms'],
    );
  });

  for (const path of ['/pricing', '/integrations', '/memory', '/ai-kit', '/privacy', '/terms']) {
    it(`redirects apex ${path} to www, preserving the query`, () => {
      const res = proxy(req(`https://buildd.dev${path}?plan=team`));
      expect(res.status).toBe(308);
      expect(location(res)).toBe(`${WWW}${path}?plan=team`);
    });

    it(`redirects apex ${path} to www even when logged in`, () => {
      const res = proxy(req(`https://buildd.dev${path}`, { cookie: 'authjs.session-token=abc' }));
      expect(location(res)).toBe(`${WWW}${path}`);
    });

    it(`matches ${path} in the proxy matcher`, () => {
      expect(config.matcher).toContain(path);
    });
  }

  it('leaves /pricing alone on a preview host', () => {
    const res = proxy(req('https://buildd-git-x.vercel.app/pricing'));
    expect(passedThrough(res)).toBe(true);
  });

  it('keeps the old /memory -> docs redirect on non-apex hosts', () => {
    const res = proxy(req('http://localhost:3000/memory', { host: 'localhost:3000' }));
    expect(res.status).toBe(307);
    expect(location(res)).toBe('https://docs.buildd.dev/docs/features/memory');
  });

  it('does not redirect sub-paths the marketing site does not own', () => {
    const res = proxy(req('https://buildd.dev/pricing/extra'));
    expect(passedThrough(res)).toBe(true);
  });
});

describe('proxy: must not redirect', () => {
  const untouched = [
    '/api/workers/claim',
    '/api/mcp',
    '/api/auth/callback/github',
    '/api/github/webhook',
    '/app/home',
    '/app/auth/signin',
    '/.well-known/oauth-authorization-server',
    '/share/some-token',
    '/manifest.webmanifest',
  ];
  for (const path of untouched) {
    it(`passes ${path} through on the apex, logged out`, async () => {
      const res = await proxy(req(`https://buildd.dev${path}`));
      expect(passedThrough(res)).toBe(true);
    });

    it(`does not list ${path} in the matcher`, () => {
      expect(config.matcher).not.toContain(path);
      expect(config.matcher.some((m: string) => m !== '/' && path.startsWith(m))).toBe(false);
    });
  }

  it('never matches /app prefixes, and /api only for the read limiter', () => {
    for (const m of config.matcher) {
      if (m === '/api/:path*') continue;
      expect(m.startsWith('/api')).toBe(false);
      expect(m.startsWith('/app')).toBe(false);
      expect(m.startsWith('/.well-known')).toBe(false);
    }
  });

  it('still sends install scripts to GitHub raw, on any host', () => {
    for (const host of ['buildd.dev', 'localhost:3000']) {
      const sh = proxy(req(`http://${host}/install.sh`, { host }));
      expect(sh.status).toBe(302);
      expect(location(sh)).toContain('/apps/runner/install.sh');
      const ps = proxy(req(`http://${host}/install.ps1`, { host }));
      expect(location(ps)).toContain('/apps/runner/install.ps1');
    }
  });
});

describe('next.config redirects do not shadow the proxy', () => {
  // next.config redirects run BEFORE the proxy, so a config redirect on a
  // path the proxy owns makes the proxy branch dead code.
  it('has no config redirect for / or any marketing path', async () => {
    const redirects = await nextConfig.redirects!();
    const sources = redirects.map((r: { source: string }) => r.source);
    expect(sources).not.toContain('/');
    for (const p of MARKETING_PATHS) expect(sources).not.toContain(p);
  });
});

describe('hasSessionCookie', () => {
  it('is false with no cookies', () => {
    expect(hasSessionCookie(req('https://buildd.dev/'))).toBe(false);
  });
});

describe('proxy: read rate limit on /api', () => {
  function apiReq(path: string, opts: { method?: string; bearer?: string; cookie?: string } = {}) {
    const headers = new Headers({ host: 'buildd.dev' });
    if (opts.bearer) headers.set('authorization', `Bearer ${opts.bearer}`);
    if (opts.cookie) headers.set('cookie', opts.cookie);
    return new NextRequest(new URL(`https://buildd.dev${path}`), { method: opts.method ?? 'GET', headers });
  }
  const refuse = async (): Promise<ReadVerdict> => ({ allowed: false, retryAfterSec: 4, cls: 'poll', limitPerMin: 30 });

  it('matches /api in the matcher', () => {
    expect(config.matcher).toContain('/api/:path*');
  });

  it('over the limit: 429 with Retry-After and the JSON body', async () => {
    const res = await apiReadProxy(apiReq('/api/tasks', { bearer: 'bld_x' }), { gate: refuse });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('4');
    const body = await res.json();
    expect(body.code).toBe('rate_limited');
    expect(body.retryAfterSec).toBe(4);
  });

  it('under the limit: passes through', async () => {
    const res = await apiReadProxy(apiReq('/api/tasks', { bearer: 'bld_x' }), { gate: async () => ({ allowed: true }) });
    expect(passedThrough(res)).toBe(true);
  });

  it('a bearer is counted under its hash; the key itself never reaches the gate', async () => {
    let seen: string | null = null;
    await apiReadProxy(apiReq('/api/tasks', { bearer: 'bld_secret' }), { gate: async (_r, s) => { seen = s; return { allowed: true }; } });
    expect(seen!).toMatch(/^key:[0-9a-f]{32}$/);
  });

  it('a browser session is counted per user', async () => {
    let seen: string | null = null;
    await apiReadProxy(apiReq('/api/missions', { cookie: 'authjs.session-token=abc' }), {
      gate: async (_r, s) => { seen = s; return { allowed: true }; },
      sessionUserId: async () => 'u-1',
    });
    expect(seen!).toBe('user:u-1');
  });

  it('no credential: not counted (the route answers 401)', async () => {
    let seen: string | null = 'unset';
    await apiReadProxy(apiReq('/api/tasks'), { gate: async (_r, s) => { seen = s; return { allowed: true }; } });
    expect(seen).toBeNull();
  });

  it('exempt runner coordination and writes pass through untouched, even with a refusing gate', async () => {
    for (const [path, method] of [
      ['/api/workers/claim', 'POST'],
      ['/api/workers/queue', 'GET'],
      ['/api/workers/heartbeat', 'POST'],
      ['/api/workers/0b7c1e2a-0000-4000-8000-000000000000', 'PATCH'],
      ['/api/tasks', 'POST'],
    ] as const) {
      const res = await apiReadProxy(apiReq(path, { method, bearer: 'bld_x' }), { gate: refuse });
      expect(passedThrough(res)).toBe(true);
    }
  });

  it('fails open with Redis unconfigured (the default gate)', async () => {
    const res = await apiReadProxy(apiReq('/api/tasks', { bearer: 'bld_x' }));
    expect(passedThrough(res)).toBe(true);
  });
});
