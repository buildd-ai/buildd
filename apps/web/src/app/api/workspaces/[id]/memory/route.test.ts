/**
 * Invariant: dashboard memory routes act only on the calling workspace's own
 * memories. The memory store is team-wide, so the workspace's memory project
 * key (resolveMemoryProjectKey, the rule every memory read uses) decides:
 * a write is filed under that key, an edit or delete reaches only a memory
 * already under it, and a memory under another key looks exactly like a
 * missing one. A workspace with no key (sensitive, or sharing its key with a
 * sensitive workspace) gets no memory writes.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'team-dash';
const WS = 'ws-dash';
const OWN = 'acme/widgets';

type Row = { id: string; project: string | null };
let rows: Row[] = [];
let workspaceKey: string | null = OWN;
const keyLookups: Array<string | null | undefined> = [];
const saved: any[] = [];
const updated: any[] = [];
const deleted: string[] = [];

const full = (r: Row) => ({ teamId: TEAM, type: 'gotcha', title: 'T', content: 'C', tags: [], files: [], source: null, ...r });
const memClient = {
  teamId: TEAM,
  save: mock(async (input: any) => {
    saved.push(input);
    return { memory: full({ id: 'mem-new', project: input.project ?? null }) };
  }),
  get: mock(async (id: string) => {
    const r = rows.find(x => x.id === id);
    if (!r) throw new Error(`Memory not found: ${id}`);
    return { memory: full(r) };
  }),
  update: mock(async (id: string, fields: any) => {
    updated.push({ id, fields });
    return { memory: full({ id, project: OWN, ...fields }) };
  }),
  delete: mock(async (id: string) => { deleted.push(id); return { success: true }; }),
  search: mock(async () => ({ results: [], total: 0 })),
  batch: mock(async () => ({ memories: [] })),
};

// The recall index dashboard writes mirror into.
const upserts: Array<{ ns: string; chunks: any[] }> = [];
const indexDeletes: Array<{ ns: string; ids: string[] }> = [];
const index = {
  upsert: mock(async (ns: string, chunks: any[]) => {
    upserts.push({ ns, chunks });
    return { inserted: chunks.length, updated: 0, superseded: 0 };
  }),
  query: async () => [],
  delete: mock(async (ns: string, ids: string[]) => { indexDeletes.push({ ns, ids }); }),
  listNamespaces: async () => [],
};

mock.module('@/lib/memory-helper', () => ({
  getMemoryStoreForTeam: async () => memClient,
  getMemoryClientForTeam: async () => memClient,
  getMemoryIndexStore: () => index,
}));
mock.module('@buildd/core/memory-scope', () => ({
  resolveMemoryProjectKey: async (wsId: string | null | undefined) => {
    keyLookups.push(wsId);
    return workspaceKey;
  },
  resolveMemoryHitScope: async () => null,
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => ({ id: 'user-1' }) }));
mock.module('@/lib/api-auth', () => ({ hashApiKey: (k: string) => k }));
let hasAccess = true;
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async () => (hasAccess ? { teamId: TEAM } : null),
  verifyAccountWorkspaceAccess: async () => (hasAccess ? { teamId: TEAM } : null),
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: async () => null },
      workspaces: { findFirst: async () => ({ repo: 'https://github.com/acme/widgets', name: 'widgets' }) },
    },
  },
}));

const { GET, POST } = await import('./route');
const { PATCH, DELETE } = await import('./[memoryId]/route');

const req = (method: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/workspaces/${WS}/memory`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const idParams = (memoryId: string) => ({ params: Promise.resolve({ id: WS, memoryId }) });

beforeEach(() => {
  rows = [
    { id: 'mem-own', project: OWN },
    { id: 'mem-foreign', project: 'acme/secret-thing' },
    { id: 'mem-teamwide', project: null },
  ];
  workspaceKey = OWN;
  hasAccess = true;
  keyLookups.length = 0;
  memClient.search.mockClear();
  memClient.batch.mockClear();
  memClient.get.mockClear();
  saved.length = 0;
  updated.length = 0;
  deleted.length = 0;
  upserts.length = 0;
  indexDeletes.length = 0;
});

describe('POST: filed under the workspace memory key', () => {
  it('saves under the resolved key', async () => {
    const res = await POST(req('POST', { type: 'gotcha', title: 'T', content: 'C' }), { params: Promise.resolve({ id: WS }) });
    expect(res.status).toBe(201);
    expect(keyLookups).toEqual([WS]);
    expect(saved[0].project).toBe(OWN);
  });

  it('refuses a workspace with no memory key and saves nothing', async () => {
    workspaceKey = null;
    const res = await POST(req('POST', { type: 'gotcha', title: 'T', content: 'C' }), { params: Promise.resolve({ id: WS }) });
    expect(res.status).toBe(403);
    expect(saved).toHaveLength(0);
  });

  it('ignores a project named in the body', async () => {
    await POST(req('POST', { type: 'gotcha', title: 'T', content: 'C', project: 'acme/secret-thing' }), { params: Promise.resolve({ id: WS }) });
    expect(saved[0].project).toBe(OWN);
  });
});

describe('PATCH: only the workspace own memories', () => {
  it('edits an own memory', async () => {
    const res = await PATCH(req('PATCH', { content: 'edited' }), idParams('mem-own'));
    expect(res.status).toBe(200);
    expect(updated).toEqual([{ id: 'mem-own', fields: expect.objectContaining({ content: 'edited' }) }]);
  });

  it('a foreign memory and a missing one get the same 404, and nothing is written', async () => {
    const foreign = await PATCH(req('PATCH', { content: 'x' }), idParams('mem-foreign'));
    const teamwide = await PATCH(req('PATCH', { content: 'x' }), idParams('mem-teamwide'));
    const missing = await PATCH(req('PATCH', { content: 'x' }), idParams('mem-missing'));
    expect([foreign.status, teamwide.status, missing.status]).toEqual([404, 404, 404]);
    const bodies = await Promise.all([foreign.json(), teamwide.json(), missing.json()]);
    expect(bodies[0]).toEqual(bodies[2]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(updated).toHaveLength(0);
  });

  it('refuses moving a memory to another project key', async () => {
    const res = await PATCH(req('PATCH', { project: 'acme/secret-thing' }), idParams('mem-own'));
    expect(res.status).toBe(400);
    expect(updated).toHaveLength(0);
  });

  it('accepts the own key spelled differently and never writes a foreign one', async () => {
    const res = await PATCH(req('PATCH', { content: 'e', project: 'https://github.com/Acme/Widgets.git' }), idParams('mem-own'));
    expect(res.status).toBe(200);
    expect(updated[0].fields.project).toBeUndefined();
  });

  it('a workspace with no memory key edits nothing', async () => {
    workspaceKey = null;
    const res = await PATCH(req('PATCH', { content: 'x' }), idParams('mem-own'));
    expect(res.status).toBe(404);
    expect(updated).toHaveLength(0);
  });
});

describe('DELETE: only the workspace own memories', () => {
  it('deletes an own memory', async () => {
    const res = await DELETE(req('DELETE'), idParams('mem-own'));
    expect(res.status).toBe(200);
    expect(deleted).toEqual(['mem-own']);
  });

  it('a foreign memory and a missing one get the same 404, and nothing is deleted', async () => {
    const foreign = await DELETE(req('DELETE'), idParams('mem-foreign'));
    const missing = await DELETE(req('DELETE'), idParams('mem-missing'));
    expect([foreign.status, missing.status]).toEqual([404, 404]);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(deleted).toHaveLength(0);
  });

  it('a workspace with no memory key deletes nothing', async () => {
    workspaceKey = null;
    const res = await DELETE(req('DELETE'), idParams('mem-own'));
    expect(res.status).toBe(404);
    expect(deleted).toHaveLength(0);
  });
});

describe('GET: listed under the workspace memory key only', () => {
  const list = (qs = '') => GET(
    new NextRequest(`http://localhost/api/workspaces/${WS}/memory${qs}`),
    { params: Promise.resolve({ id: WS }) },
  );

  it('searches under the resolved key', async () => {
    const res = await list('?search=auth');
    expect(res.status).toBe(200);
    expect(keyLookups).toEqual([WS]);
    expect(memClient.search).toHaveBeenCalledTimes(1);
    expect((memClient.search.mock.calls[0] as any[])[0]).toMatchObject({ project: OWN, query: 'auth' });
  });

  it('a workspace with no key lists nothing and never searches the team store', async () => {
    workspaceKey = null;
    const res = await list();
    expect(await res.json()).toEqual({ memories: [], total: 0, memoryUnavailable: true });
    expect(memClient.search).not.toHaveBeenCalled();
  });
});

describe('workspace access is checked before any memory store call', () => {
  it('GET, POST, PATCH and DELETE all 404 and touch nothing', async () => {
    hasAccess = false;
    const statuses = [
      (await GET(new NextRequest(`http://localhost/api/workspaces/${WS}/memory`), { params: Promise.resolve({ id: WS }) })).status,
      (await POST(req('POST', { type: 'gotcha', title: 'T', content: 'C' }), { params: Promise.resolve({ id: WS }) })).status,
      (await PATCH(req('PATCH', { content: 'x' }), idParams('mem-own'))).status,
      (await DELETE(req('DELETE'), idParams('mem-own'))).status,
    ];
    expect(statuses).toEqual([404, 404, 404, 404]);
    expect(keyLookups).toEqual([]);
    expect(memClient.search).not.toHaveBeenCalled();
    expect(memClient.get).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(updated).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });
});

describe('dashboard writes reach the recall index', () => {
  it('POST mirrors the new memory into the team memory namespace', async () => {
    await POST(req('POST', { type: 'gotcha', title: 'T', content: 'C' }), { params: Promise.resolve({ id: WS }) });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].ns).toBe(`${TEAM}:memory`);
    expect(upserts[0].chunks[0]).toMatchObject({ id: 'mem-new', sourceType: 'memory' });
  });

  it('POST still returns 201 when the mirror fails (reconcile picks it up)', async () => {
    index.upsert.mockImplementationOnce(async () => { throw new Error('index down'); });
    const warn = console.warn;
    console.warn = () => {};
    const res = await POST(req('POST', { type: 'gotcha', title: 'T', content: 'C' }), { params: Promise.resolve({ id: WS }) });
    console.warn = warn;
    expect(res.status).toBe(201);
    expect(saved).toHaveLength(1);
  });

  it('PATCH re-mirrors an own memory, and a refused edit mirrors nothing', async () => {
    await PATCH(req('PATCH', { content: 'edited' }), idParams('mem-own'));
    await PATCH(req('PATCH', { content: 'x' }), idParams('mem-foreign'));
    expect(upserts).toHaveLength(1);
    expect(upserts[0].chunks[0]).toMatchObject({ id: 'mem-own', content: 'edited' });
  });

  it('DELETE drops the chunk from the index too, and a refused delete drops nothing', async () => {
    await DELETE(req('DELETE'), idParams('mem-own'));
    await DELETE(req('DELETE'), idParams('mem-foreign'));
    expect(indexDeletes).toEqual([{ ns: `${TEAM}:memory`, ids: ['mem-own'] }]);
  });
});
