/**
 * MCP reads run the API's own GET handlers in-process (spec 3ef37387 R-22).
 * The table must name real GET routes, match static segments before dynamic
 * ones, and keep the proxy's read rate limit in front of each call.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { NextRequest } from 'next/server';
import { matchLocalRead as match, runLocalRead, shadowedRoutes } from './mcp-local-reads';
import { MCP_LOCAL_READS as LOCAL_READS, MCP_LOCAL_READ_SHADOWS as SHADOWS } from '../mcp-read-routes';

const matchLocalRead = (p: string) => match(p, LOCAL_READS, SHADOWS);

const APP = join(import.meta.dir, '..', 'app');
const fileOf = (path: string) => join(APP, ...path.split('/').filter(Boolean).map(s => (s.startsWith(':') ? `[${s.slice(1)}]` : s)), 'route.ts');

describe('MCP_LOCAL_READS (the composition root\'s table)', () => {
  it('names a route file that exports GET for every entry, with its own param names', () => {
    for (const r of LOCAL_READS) {
      const file = fileOf(r.path);
      expect(existsSync(file), `${r.path} → ${file}`).toBe(true);
      expect(readFileSync(file, 'utf8'), `${r.path} exports GET`).toMatch(/export (async function|const) GET\b/);
      // The import in the table is the same file.
      expect(r.load.toString()).toContain(`@/${file.slice(join(APP, '..').length + 1).replace(/\.ts$/, '')}`);
    }
  });

  it('matches static segments before dynamic ones, and extracts params', () => {
    expect(matchLocalRead('/api/workspaces/by-repo')?.read.path).toBe('/api/workspaces/by-repo');
    expect(matchLocalRead('/api/workspaces/abc')).toMatchObject({ read: { path: '/api/workspaces/:id' }, params: { id: 'abc' } });
    expect(matchLocalRead('/api/artifacts/linked')?.read.path).toBe('/api/artifacts/linked');
    expect(matchLocalRead('/api/artifacts/x%20y')?.params).toEqual({ artifactId: 'x y' });
    expect(matchLocalRead('/api/tasks/t1/messages')?.params).toEqual({ id: 't1' });
    expect(matchLocalRead('/api/workers/claim/extra')).toBeNull();
    expect(matchLocalRead('/api/unknown')).toBeNull();
  });
});

/** Every API route on disk as a table-style path (`[x]` → `:x`). */
function apiRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (/^route\.tsx?$/.test(e.name)) {
        const segs = relative(APP, dir).split(sep).filter(s => !/^\(.*\)$/.test(s));
        out.push('/' + segs.map(s => s.replace(/^\[+\.{0,3}([^\]]+)\]+$/, ':$1')).join('/'));
      }
    }
  };
  walk(join(APP, 'api'));
  return out.sort();
}

describe('a dynamic entry never takes a path a static sibling route serves', () => {
  const routes = apiRoutes();

  it('regression: /api/missions/capabilities is not the mission named "capabilities"', () => {
    expect(routes).toContain('/api/missions/capabilities');
    expect(matchLocalRead('/api/missions/capabilities')).toBeNull();
    expect(matchLocalRead('/api/missions/m1')?.read.path).toBe('/api/missions/:id');
  });

  it('the same for the other static siblings of a table entry', () => {
    for (const p of ['/api/releases/readiness', '/api/releases/compose', '/api/tasks/waiting-input', '/api/tasks/bulk',
      '/api/tasks/cleanup', '/api/workers/active', '/api/workers/mine', '/api/workers/queue', '/api/workspaces/match-repos']) {
      if (!routes.includes(p)) continue;
      expect(matchLocalRead(p), p).toBeNull();
    }
  });

  it('every route on disk is either matched by its own entry or goes over HTTP', () => {
    for (const route of routes) {
      // A concrete path for the route: each dynamic segment gets a value no static directory has.
      const concrete = route.split('/').map(s => (s.startsWith(':') ? 'v-0' : s)).join('/');
      const m = matchLocalRead(concrete);
      if (m) expect(m.read.path.replace(/:[^/]+/g, ':'), `${concrete} (served by ${route})`).toBe(route.replace(/:[^/]+/g, ':'));
    }
  });

  it('MCP_LOCAL_READ_SHADOWS is the set derived from the routes on disk', () => {
    expect(
      [...SHADOWS].sort(),
      'regenerate: shadowedRoutes(apiRoutes(), MCP_LOCAL_READS) in lib/mcp-local-reads.test.ts',
    ).toEqual(shadowedRoutes(routes, LOCAL_READS));
  });

  it('only lib/mcp-local-reads.ts imports the table, and modules.ts names no route handler', () => {
    // modules.ts is imported by dozens of routes; a route table there put every
    // route it names into each of their server bundles and `next build` ran out
    // of memory in compile.
    const SRC = join(import.meta.dir, '..');
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
        if (/['"]@\/mcp-read-routes['"]|['"]\.\.?\/(\.\.\/)*mcp-read-routes['"]/.test(readFileSync(p, 'utf8'))) importers.push(relative(SRC, p).split(sep).join('/'));
      }
    };
    walk(SRC);
    expect(importers.filter(f => f !== 'mcp-read-routes.ts')).toEqual(['lib/mcp-local-reads.ts']);
    expect(readFileSync(join(SRC, 'modules.ts'), 'utf8')).not.toMatch(/import\(['"]@\/app\/[^'"]*\/route['"]\)/);
  });

  it('a more specific entry wins regardless of table order', () => {
    const t = [{ path: '/api/a/:id', load: async () => ({}) }, { path: '/api/a/fixed', load: async () => ({}) }];
    expect(match('/api/a/fixed', t)?.read.path).toBe('/api/a/fixed');
    expect(match('/api/a/other', t)?.read.path).toBe('/api/a/:id');
    expect(match('/api/a/s', t, ['/api/a/s'])).toBeNull();
  });
});

describe('runLocalRead', () => {
  const ok = () => new Response(null, { status: 200 });

  it('returns null for a path not in the table (the caller fetches)', async () => {
    expect(await runLocalRead('http://x/api/not-local', {}, { gate: async () => ok(), table: LOCAL_READS })).toBeNull();
  });

  it('runs the route GET with the caller headers and params', async () => {
    let seen: { auth: string | null; id: string } | null = null;
    const res = await runLocalRead('http://x/api/tasks/t1?view=status', { Authorization: 'Bearer k' }, {
      gate: async () => ok(),
      table: LOCAL_READS,
      load: async () => ({
        GET: async (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
          seen = { auth: req.headers.get('authorization'), id: (await ctx.params).id };
          return Response.json({ view: req.nextUrl.searchParams.get('view') });
        },
      }),
    });
    expect(seen).toEqual({ auth: 'Bearer k', id: 't1' });
    expect(await res!.json()).toEqual({ view: 'status' });
  });

  it('keeps the read rate limit: a 429 from the gate is returned and the route never runs', async () => {
    let ran = false;
    const res = await runLocalRead('http://x/api/tasks', {}, {
      gate: async () => new Response('{}', { status: 429, headers: { 'Retry-After': '3' } }),
      table: LOCAL_READS,
      load: async () => ({ GET: async () => { ran = true; return ok(); } }),
    });
    expect(res!.status).toBe(429);
    expect(ran).toBe(false);
  });
});
