/**
 * MCP reads run the API's own GET handlers in-process (spec 3ef37387 R-22).
 * The table must name real GET routes, match static segments before dynamic
 * ones, and keep the proxy's read rate limit in front of each call.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { LOCAL_READS, matchLocalRead, runLocalRead } from './mcp-local-reads';

const APP = join(import.meta.dir, '..', 'app');
const fileOf = (path: string) => join(APP, ...path.split('/').filter(Boolean).map(s => (s.startsWith(':') ? `[${s.slice(1)}]` : s)), 'route.ts');

describe('LOCAL_READS', () => {
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

describe('runLocalRead', () => {
  const ok = () => new Response(null, { status: 200 });

  it('returns null for a path not in the table (the caller fetches)', async () => {
    expect(await runLocalRead('http://x/api/not-local', {}, { gate: async () => ok() })).toBeNull();
  });

  it('runs the route GET with the caller headers and params', async () => {
    let seen: { auth: string | null; id: string } | null = null;
    const res = await runLocalRead('http://x/api/tasks/t1?view=status', { Authorization: 'Bearer k' }, {
      gate: async () => ok(),
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
      load: async () => ({ GET: async () => { ran = true; return ok(); } }),
    });
    expect(res!.status).toBe(429);
    expect(ran).toBe(false);
  });
});
