/**
 * PATCH /api/workspaces/[id]/memory/[memoryId] with `{ action }`: the
 * dashboard's review actions (promote / dismiss / reverified).
 *
 * Invariants:
 * - Team admins only: a member session or a non-admin key is refused before
 *   any memory is read.
 * - Same scope as the edit PATCH: the memory must sit under the workspace's
 *   memory project key; another key, a missing row and a keyless workspace
 *   all read as 404, and nothing is written.
 * - The write goes through memory-write's transitionMemory, with the
 *   workspace's own key, and is mirrored into the team's memory index.
 * - A row the action cannot start from is a 409, not a silent 200.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'team-rev';
const WS = 'ws-rev';
const OWN = 'acme/widgets';

type Row = { id: string; project: string | null; state: string; reverifyFlaggedAt?: string | null; supersededBy?: string | null };
let rows: Row[] = [];
let workspaceKey: string | null = OWN;
let role: 'owner' | 'admin' | 'member' = 'admin';
let apiAccount: { id: string; teamId: string; level: string } | null = null;
let hasAccess = true;
const transitions: Array<{ id: string; project: string; action: string }> = [];
const upserts: Array<{ ns: string; chunks: any[] }> = [];

const full = (r: Row) => ({ teamId: TEAM, type: 'gotcha', title: 'T', content: 'C', tags: [], files: [], source: null, ...r });
// Mirrors the store's guarded UPDATE: team + project + allowed starting state.
const FROM: Record<string, string[]> = {
  promote: ['candidate'],
  dismiss: ['candidate', 'active', 'expired'],
  reverified: ['candidate', 'active', 'expired', 'invalidated'],
};
const memClient = {
  teamId: TEAM,
  get: mock(async (id: string) => {
    const r = rows.find(x => x.id === id);
    if (!r) throw new Error(`Memory not found: ${id}`);
    return { memory: full(r) };
  }),
  transition: mock(async (id: string, project: string, action: string) => {
    transitions.push({ id, project, action });
    const r = rows.find(x => x.id === id && x.project === project);
    if (!r || r.supersededBy || !FROM[action].includes(r.state)) return null;
    if (action === 'reverified' && !r.reverifyFlaggedAt) return null;
    const next: Row = action === 'promote' ? { ...r, state: 'active' }
      : action === 'dismiss' ? { ...r, state: 'invalidated', reverifyFlaggedAt: null }
      : { ...r, reverifyFlaggedAt: null };
    return { memory: full(next), supersededIds: action === 'promote' ? ['old-1'] : [] };
  }),
  update: mock(async () => { throw new Error('edit path must not run for an action'); }),
};

mock.module('@/lib/memory-helper', () => ({
  getMemoryStoreForTeam: async () => memClient,
  getMemoryClientForTeam: async () => memClient,
  getMemoryIndexStore: () => ({
    upsert: async (ns: string, chunks: any[]) => { upserts.push({ ns, chunks }); return { inserted: 1, updated: 0, superseded: 0 }; },
    query: async () => [], delete: async () => {}, listNamespaces: async () => [],
  }),
}));
mock.module('@buildd/core/memory-scope', () => ({
  resolveMemoryProjectKey: async () => workspaceKey,
  resolveMemoryHitScope: async () => null,
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => ({ id: 'user-1' }) }));
mock.module('@/lib/api-auth', () => ({ hashApiKey: (k: string) => k }));
const RANK = { member: 1, admin: 2, owner: 3 } as const;
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async (_u: string, _w: string, required?: keyof typeof RANK) => {
    if (!hasAccess) return null;
    if (required && RANK[role] < RANK[required]) return null;
    return { teamId: TEAM, role };
  },
  verifyAccountWorkspaceAccess: async () => (hasAccess ? { teamId: TEAM } : null),
  canCallerAdminTeam: async (caller: any, teamId: string) =>
    caller.kind === 'account' && caller.level === 'admin' && caller.teamId === teamId,
}));
mock.module('@buildd/core/db', () => ({
  db: { query: { accounts: { findFirst: async () => apiAccount } } },
}));

const { PATCH } = await import('./route');

const patch = (memoryId: string, body: unknown, bearer?: string) => PATCH(
  new NextRequest(`http://localhost:3000/api/workspaces/${WS}/memory/${memoryId}`, {
    method: 'PATCH',
    headers: new Headers({ 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }),
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: WS, memoryId }) },
);

beforeEach(() => {
  rows = [
    { id: 'cand-1', project: OWN, state: 'candidate' },
    { id: 'act-1', project: OWN, state: 'active', reverifyFlaggedAt: '2026-09-01T00:00:00.000Z' },
    { id: 'act-2', project: OWN, state: 'active' },
    { id: 'gone-1', project: OWN, state: 'active', supersededBy: 'act-1' },
    { id: 'foreign-1', project: 'acme/other', state: 'candidate' },
  ];
  workspaceKey = OWN;
  role = 'admin';
  apiAccount = null;
  hasAccess = true;
  transitions.length = 0;
  upserts.length = 0;
  memClient.get.mockClear();
  memClient.transition.mockClear();
  (process.env as any).NODE_ENV = 'production';
});

describe('review actions: who may act', () => {
  it('a member session is refused before any memory is read', async () => {
    role = 'member';
    const res = await patch('cand-1', { action: 'promote' });
    expect(res.status).toBe(403);
    expect(memClient.get).not.toHaveBeenCalled();
    expect(transitions).toHaveLength(0);
  });

  it('an owner session may act', async () => {
    role = 'owner';
    expect((await patch('cand-1', { action: 'promote' })).status).toBe(200);
  });

  it('a worker-level key of the team is refused', async () => {
    apiAccount = { id: 'acct-1', teamId: TEAM, level: 'worker' };
    const res = await patch('cand-1', { action: 'promote' }, 'bld_worker');
    expect(res.status).toBe(403);
    expect(transitions).toHaveLength(0);
  });

  it('an admin key of another team is refused', async () => {
    apiAccount = { id: 'acct-2', teamId: 'team-other', level: 'admin' };
    expect((await patch('cand-1', { action: 'promote' }, 'bld_other')).status).toBe(403);
  });

  it('an admin key of the team may act', async () => {
    apiAccount = { id: 'acct-3', teamId: TEAM, level: 'admin' };
    expect((await patch('cand-1', { action: 'promote' }, 'bld_admin')).status).toBe(200);
  });

  it('no workspace access is a 404 before the admin check', async () => {
    hasAccess = false;
    expect((await patch('cand-1', { action: 'promote' })).status).toBe(404);
  });

  it('an unknown action is a 400', async () => {
    expect((await patch('cand-1', { action: 'delete' })).status).toBe(400);
    expect(transitions).toHaveLength(0);
  });
});

describe('review actions: project scope', () => {
  it('a memory under another project key is a 404 and is never transitioned', async () => {
    const res = await patch('foreign-1', { action: 'promote' });
    expect(res.status).toBe(404);
    expect(transitions).toHaveLength(0);
  });

  it('a missing memory is the same 404', async () => {
    expect((await patch('nope', { action: 'dismiss' })).status).toBe(404);
  });

  it('a workspace with no memory key acts on nothing', async () => {
    workspaceKey = null;
    expect((await patch('cand-1', { action: 'promote' })).status).toBe(404);
    expect(transitions).toHaveLength(0);
  });

  it('the transition is bound to the workspace key, whatever the body says', async () => {
    await patch('cand-1', { action: 'promote', project: 'acme/other' });
    expect(transitions).toEqual([{ id: 'cand-1', project: OWN, action: 'promote' }]);
  });
});

describe('review actions: state transitions', () => {
  it('promote: candidate becomes active and is mirrored, flipping what it superseded', async () => {
    const res = await patch('cand-1', { action: 'promote' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memory.state).toBe('active');
    expect(body.supersededIds).toEqual(['old-1']);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].ns).toBe(`${TEAM}:memory`);
    expect(upserts[0].chunks[0].supersedes).toEqual(['old-1']);
  });

  it('promote on an active memory is a 409', async () => {
    const res = await patch('act-2', { action: 'promote' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Memory cannot be promoted from its current state');
    expect(upserts).toHaveLength(0);
  });

  it('dismiss: active becomes invalidated', async () => {
    const res = await patch('act-1', { action: 'dismiss' });
    expect(res.status).toBe(200);
    expect((await res.json()).memory.state).toBe('invalidated');
  });

  it('dismiss on a superseded memory is a 409', async () => {
    expect((await patch('gone-1', { action: 'dismiss' })).status).toBe(409);
  });

  it('reverified clears the flag and leaves the state', async () => {
    const res = await patch('act-1', { action: 'reverified' });
    expect(res.status).toBe(200);
    const { memory } = await res.json();
    expect(memory.state).toBe('active');
    expect(memory.reverifyFlaggedAt).toBeNull();
  });

  it('reverified on an unflagged memory is a 409', async () => {
    expect((await patch('act-2', { action: 'reverified' })).status).toBe(409);
  });

  it('never runs the edit path', async () => {
    await patch('cand-1', { action: 'promote', title: 'changed' });
    expect(memClient.update).not.toHaveBeenCalled();
  });
});
