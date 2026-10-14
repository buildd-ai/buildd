import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = '11111111-1111-4111-8111-111111111111';
const SWITCH = '33333333-3333-4333-8333-333333333333';
const mockRequireSessionUser = mock(async () => ({ user: { id: 'u-1' } }) as any);
const mockGetUserTeamIds = mock(async () => [TEAM] as string[]);
let roles: Record<string, string> = {};
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teamMembers: { findMany: async () => Object.entries(roles).map(([teamId, role]) => ({ teamId, role })) },
      teams: { findFirst: async () => ({ id: 'not-a-personal-team' }) },
    },
  },
}));
mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: mockRequireSessionUser }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: mockGetUserTeamIds }));

// The real switch feed and Undo (lib/decision-model-optimizer/optimizer.ts) over a fake store.
const CLEF = { endpoint: 'systemone', model: 'clef', via: 'cloudflare' };
let stored: unknown = { byKind: { 'buildd.orchestration_claim_hold': CLEF } };
let row: any;
const writes: Array<{ kind: string; route: unknown }> = [];
const ended: Array<{ id: string; status: string; pinnedUntil?: Date | null }> = [];
const switches = {
  pinnedKinds: async () => new Set<string>(),
  insert: async () => 'x',
  supersede: async () => {},
  listActive: async () => (row.status === 'active' ? [row] : []),
  get: async (id: string) => (id === row.id ? row : null),
  end: async (id: string, status: string, patch: { pinnedUntil?: Date | null }) => {
    ended.push({ id, status, pinnedUntil: patch.pinnedUntil });
    row = { ...row, status };
    return true;
  },
};
const deps = {
  switches,
  readDecisionModel: async () => stored,
  setKindModel: async (_t: string, kind: string, route: unknown) => { writes.push({ kind, route }); return { ok: true }; },
  recordLedger: async () => {},
};
mock.module('@/lib/decision-model-optimizer/store', () => ({
  optimizerDeps: () => deps,
  switchFeedDeps: () => deps,
}));

const { GET, POST } = await import('./route');
const ctx = (id = TEAM) => ({ params: Promise.resolve({ id }) });
const url = `http://localhost:3000/api/teams/${TEAM}/decision-model-switches`;
const post = (body: unknown) => new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  mockGetUserTeamIds.mockResolvedValue([TEAM]);
  roles = {};
  stored = { byKind: { 'buildd.orchestration_claim_hold': CLEF } };
  row = {
    id: SWITCH, teamId: TEAM, kind: 'buildd.orchestration_claim_hold', cause: 'optimizer', fromRoute: null, toRoute: CLEF,
    evalRunId: 'run-1', beforeScore: 0.4, afterScore: 0.6, bar: 0.9, n: 80, status: 'active',
    pinnedUntil: null, endedAt: null, endedBy: null, createdAt: new Date(),
  };
  writes.length = 0;
  ended.length = 0;
});

describe('GET /api/teams/[id]/decision-model-switches', () => {
  it('a member sees one plain line per switch and no scores; Undo only for owners/admins', async () => {
    const res = await GET(new NextRequest(url), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ lines: [{ id: SWITCH, kind: 'buildd.orchestration_claim_hold', text: expect.stringContaining('now uses Clef'), at: expect.any(String) }], canUndo: false });
    expect(JSON.stringify(body)).not.toContain('0.6');
    expect(JSON.stringify(body)).not.toContain('run-1');
    roles = { [TEAM]: 'admin' };
    expect((await (await GET(new NextRequest(url), ctx())).json()).canUndo).toBe(true);
  });

  it('404s a non-member', async () => {
    mockGetUserTeamIds.mockResolvedValue([]);
    expect((await GET(new NextRequest(url), ctx())).status).toBe(404);
  });
});

describe('POST /api/teams/[id]/decision-model-switches', () => {
  it('a plain member cannot undo', async () => {
    expect((await POST(post({ switchId: SWITCH, action: 'undo' }), ctx())).status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('an admin undo restores the previous model and pins it for 30 days', async () => {
    roles = { [TEAM]: 'owner' };
    const before = Date.now();
    const res = await POST(post({ switchId: SWITCH, action: 'undo' }), ctx());
    expect(res.status).toBe(200);
    expect(writes).toEqual([{ kind: 'buildd.orchestration_claim_hold', route: null }]);
    expect(ended).toHaveLength(1);
    expect(ended[0].status).toBe('undone');
    const pinMs = ended[0].pinnedUntil!.getTime() - before;
    expect(pinMs).toBeGreaterThanOrEqual(30 * 86_400_000 - 5_000);
    expect(pinMs).toBeLessThanOrEqual(30 * 86_400_000 + 5_000);
    // Undoing again is refused: it is no longer in effect.
    expect((await POST(post({ switchId: SWITCH, action: 'undo' }), ctx())).status).toBe(409);
  });

  it('refuses a malformed body', async () => {
    roles = { [TEAM]: 'admin' };
    expect((await POST(post({ switchId: 'nope', action: 'undo' }), ctx())).status).toBe(400);
    expect((await POST(post({ switchId: SWITCH, action: 'delete' }), ctx())).status).toBe(400);
  });
});
