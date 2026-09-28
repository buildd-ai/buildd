/**
 * GET /api/workspaces/[id]/memory reads memory under the key resolveMemoryProjectKey
 * gives the workspace, the same rule as every other memory read.
 *
 * Invariant: a workspace that must get no memory (sensitive, sharing a key with
 * a sensitive workspace in its team, or with no key at all) gets an empty
 * result, and the team-wide store is never searched without a project. The
 * search path is enforced inside retrieveMemory itself; the list path by the
 * route.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { NextRequest } from 'next/server';

type Ws = { id: string; teamId: string; repo: string | null; name: string; dataClass: string };
let wsRow: Ws | null = null;
let teamRows: Ws[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: async () => ({ id: 'acct-1' }) },
      workspaces: {
        findFirst: async () => wsRow,
        // The resolver's sensitive-sibling lookup; answers with the team's
        // sensitive rows, as its WHERE asks for.
        findMany: async () => teamRows.filter(w => w.dataClass === 'sensitive'),
      },
    },
  },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => null }));
mock.module('@/lib/api-auth', () => ({ hashApiKey: (k: string) => `h:${k}` }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async () => true,
  verifyAccountWorkspaceAccess: async () => true,
}));

const search = mock(async (_q: any) => ({ results: [{ id: 'mem-1' }], total: 1 }));
const batch = mock(async (_ids: string[]) => ({ memories: [{ id: 'mem-1', title: 'T', project: 'acme/widgets' }] }));
mock.module('@/lib/memory-helper', () => ({
  getMemoryStoreForTeam: async () => ({ search, batch }),
  getMemoryClientForTeam: async () => ({ search, batch }),
  getMemoryIndexStore: () => ({ upsert: async () => ({}), query: async () => [], delete: async () => {}, listNamespaces: async () => [] }),
}));

const originalNodeEnv = process.env.NODE_ENV;
const { GET } = await import('./route');

const own = (over: Partial<Ws> = {}): Ws => ({
  id: 'ws-1', teamId: 'team-1', repo: 'https://github.com/acme/widgets', name: 'widgets', dataClass: 'standard', ...over,
});
const req = (qs: string) => new NextRequest(`http://localhost:3000/api/workspaces/ws-1/memory?${qs}`, {
  headers: new Headers({ authorization: 'Bearer bld_test' }),
});
const params = Promise.resolve({ id: 'ws-1' });

beforeEach(() => {
  search.mockClear();
  batch.mockClear();
  wsRow = own();
  teamRows = [wsRow];
  process.env.NODE_ENV = 'production';
});
afterAll(() => { process.env.NODE_ENV = originalNodeEnv; });

describe('GET /api/workspaces/[id]/memory: project scope', () => {
  it('searches under the resolved key', async () => {
    const res = await GET(req('query=fix&limit=5'), { params });
    expect(res.status).toBe(200);
    expect(search.mock.calls[0][0].project).toBe('acme/widgets');
  });

  it('no key: empty result, and the store is never searched', async () => {
    wsRow = own({ repo: null, name: '' });
    teamRows = [wsRow];
    for (const qs of ['query=fix&limit=5', 'files=a.ts&limit=5', 'limit=50']) {
      const res = await GET(req(qs), { params });
      expect(await res.json()).toEqual({ memories: [], total: 0 });
    }
    expect(search).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it('a key shared with a sensitive workspace in the team: empty, never searched', async () => {
    teamRows = [own(), own({ id: 'ws-sensitive', dataClass: 'sensitive' })];
    const res = await GET(req('query=fix&limit=5'), { params });
    expect(await res.json()).toEqual({ memories: [], total: 0 });
    expect(search).not.toHaveBeenCalled();
  });

  it('a sensitive workspace: empty, never searched', async () => {
    wsRow = own({ dataClass: 'sensitive' });
    teamRows = [wsRow];
    const res = await GET(req('limit=50'), { params });
    expect(await res.json()).toEqual({ memories: [], total: 0 });
    expect(search).not.toHaveBeenCalled();
  });
});
