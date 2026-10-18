/**
 * MCP reads run the API's own handler in process (spec 3ef37387 R-22): the
 * listed GETs never reach HTTP, carry the same URL and headers, keep the read
 * rate limit, and fail the way the HTTP call did. Writes still go over HTTP.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';
import { READ_ROUTES, matchReadRoute, withInProcessReads } from './mcp-read-dispatch';

let http: Array<{ endpoint: string; method: string }>;
let handled: Array<{ url: string; auth: string | null; grant: string | null; params: Record<string, string> }>;
let answer: Response;

const routes = [
  { re: /^\/api\/tasks$/, load: async () => ({ GET: handler }) },
  { re: /^\/api\/tasks\/([^/]+)$/, params: ['id'], load: async () => ({ GET: handler }) },
];
async function handler(req: NextRequest, ctx: { params: Promise<Record<string, string>> }) {
  handled.push({ url: req.url, auth: req.headers.get('authorization'), grant: req.headers.get('x-grant'), params: await ctx.params });
  return answer.clone();
}

const allow = async () => ({ allowed: true as const });
const make = (gate: any = allow) => withInProcessReads(
  async (endpoint, options = {}) => { http.push({ endpoint, method: options.method ?? 'GET' }); return { via: 'http' }; },
  { baseUrl: 'https://buildd.test', bearer: 'bld_k', headersFor: (o) => ({ Authorization: 'Bearer bld_k', 'x-grant': 'ws-1', ...(o.headers as Record<string, string> | undefined) }) },
  { routes, gate },
);

beforeEach(() => {
  http = [];
  handled = [];
  answer = Response.json({ tasks: [{ id: 't1' }] });
});

describe('in-process MCP reads', () => {
  it('a listed GET runs the handler with the same URL and headers, and never reaches HTTP', async () => {
    expect(await make()('/api/tasks?status=active&limit=5')).toEqual({ tasks: [{ id: 't1' }] });
    expect(http).toEqual([]);
    expect(handled).toEqual([{ url: 'https://buildd.test/api/tasks?status=active&limit=5', auth: 'Bearer bld_k', grant: 'ws-1', params: {} }]);
  });

  it('a dynamic segment reaches the handler as its param, decoded', async () => {
    await make()('/api/tasks/abc%20d?include=full');
    expect(handled[0]!.params).toEqual({ id: 'abc d' });
  });

  it('writes and unlisted reads still go over HTTP', async () => {
    const api = make();
    expect(await api('/api/tasks', { method: 'POST', body: '{}' })).toEqual({ via: 'http' });
    expect(await api('/api/tasks/t1/messages')).toEqual({ via: 'http' });
    expect(http.map(h => `${h.method} ${h.endpoint}`)).toEqual(['POST /api/tasks', 'GET /api/tasks/t1/messages']);
    expect(handled).toEqual([]);
  });

  it('a refusal throws as the HTTP call did', async () => {
    answer = Response.json({ error: 'Task not found' }, { status: 404 });
    await expect(make()('/api/tasks/t9')).rejects.toThrow('API error: 404 - {"error":"Task not found"}');
  });

  it('the read rate limit applies, on the bearer\'s subject, before the handler runs', async () => {
    const seen: unknown[] = [];
    const gate = async (req: unknown, subject: string | null) => { seen.push([req, subject]); return { allowed: false as const, retryAfterSec: 7, cls: 'poll' as const, limitPerMin: 30 }; };
    await expect(make(gate)('/api/tasks')).rejects.toThrow(/API error: 429 - .*Retry after 7s/);
    expect(handled).toEqual([]);
    expect(seen[0]).toEqual([{ method: 'GET', pathname: '/api/tasks' }, expect.stringMatching(/^key:/)]);
  });
});

describe('READ_ROUTES', () => {
  it('names the reads MCP actions make, and nothing that writes', () => {
    for (const p of ['/api/tasks', '/api/tasks/x', '/api/missions', '/api/missions/x', '/api/workspaces', '/api/workers/x', '/api/prs', '/api/roles', '/api/workspaces/x/schedules', '/api/workspaces/x/skills', '/api/github/pr/review']) {
      expect(matchReadRoute(p), p).not.toBeNull();
    }
    for (const p of ['/api/workers/claim/x', '/api/tasks/x/attach-pr', '/api/github/pr', '/api/workspaces/x/schedules/y']) {
      expect(matchReadRoute(p), p).toBeNull();
    }
    expect(READ_ROUTES.length).toBe(11);
  });
});
