/**
 * Dashboard memory writes go through the one write helper, so a memory created
 * or edited in the dashboard is mirrored into the `{teamId}:memory` index that
 * recall reads, not just the `memories` table.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'team-dash';
const WS = 'ws-dash';

const saved: any[] = [];
const updated: any[] = [];
const memClient = {
  teamId: TEAM,
  save: mock(async (input: any) => {
    saved.push(input);
    return { memory: { id: 'mem-new', teamId: TEAM, tags: [], files: [], source: 'dashboard', ...input, project: input.project ?? null } };
  }),
  update: mock(async (id: string, fields: any) => {
    updated.push({ id, fields });
    return { memory: { id, teamId: TEAM, type: 'gotcha', title: 'T', content: 'C', tags: [], files: [], project: 'acme/widgets', source: null, ...fields } };
  }),
  search: mock(async () => ({ results: [], total: 0 })),
  batch: mock(async () => ({ memories: [] })),
};

const upserts: Array<{ ns: string; chunks: any[] }> = [];
const index = {
  upsert: mock(async (ns: string, chunks: any[]) => {
    upserts.push({ ns, chunks });
    return { inserted: chunks.length, updated: 0, superseded: 0 };
  }),
  query: async () => [],
  delete: async () => {},
  listNamespaces: async () => [],
};

mock.module('@/lib/memory-helper', () => ({
  getMemoryStoreForTeam: async () => memClient,
  getMemoryClientForTeam: async () => memClient,
  getMemoryIndexStore: () => index,
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => ({ id: 'user-1' }) }));
mock.module('@/lib/api-auth', () => ({ hashApiKey: (k: string) => k }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async () => ({ teamId: TEAM }),
  verifyAccountWorkspaceAccess: async () => ({ teamId: TEAM }),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: async () => null },
      workspaces: {
        findFirst: async () => ({ repo: 'https://github.com/acme/widgets', name: 'widgets' }),
      },
    },
  },
}));

const { POST } = await import('./route');
const { PATCH } = await import('./[memoryId]/route');

const req = (method: string, body: unknown) =>
  new NextRequest(`http://localhost/api/workspaces/${WS}/memory`, { method, body: JSON.stringify(body) });

beforeEach(() => {
  saved.length = 0;
  updated.length = 0;
  upserts.length = 0;
});

describe('dashboard memory POST', () => {
  it('saves under the workspace project and mirrors into the team memory index', async () => {
    const res = await POST(req('POST', { type: 'gotcha', title: 'T', content: 'C' }), { params: Promise.resolve({ id: WS }) });
    expect(res.status).toBe(201);
    expect(saved[0].project).toBe('acme/widgets');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].ns).toBe(`${TEAM}:memory`);
    expect(upserts[0].chunks[0]).toMatchObject({ id: 'mem-new', sourceType: 'memory' });
  });

  it('still returns 201 when the mirror fails (reconcile picks it up)', async () => {
    index.upsert.mockImplementationOnce(async () => { throw new Error('index down'); });
    const warn = console.warn;
    console.warn = () => {};
    const res = await POST(req('POST', { type: 'gotcha', title: 'T', content: 'C' }), { params: Promise.resolve({ id: WS }) });
    console.warn = warn;
    expect(res.status).toBe(201);
    expect(saved).toHaveLength(1);
  });
});

describe('dashboard memory PATCH', () => {
  it('re-mirrors the edited memory', async () => {
    const res = await PATCH(req('PATCH', { content: 'edited' }), { params: Promise.resolve({ id: WS, memoryId: 'mem-7' }) });
    expect(res.status).toBe(200);
    expect(updated[0].id).toBe('mem-7');
    expect(upserts).toHaveLength(1);
    expect(upserts[0].chunks[0]).toMatchObject({ id: 'mem-7', content: 'edited' });
  });
});
