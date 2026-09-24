/**
 * GET /api/missions/[id]/artifacts/content?ids=… — the Records sheet's lazy
 * content read (docs/design/mission-feed-mobile-continuity.md, slice S7,
 * AC-18). The mission page no longer selects artifact bodies; the sheet asks
 * for them on open.
 *
 * The WHERE is rendered through PgDialect so its scoping is observable: an id
 * list alone would let any mission's reader fetch any artifact by id.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockResolveAccountTeamIds = mock(() => Promise.resolve(['team-1'] as string[]));
const mockMissionsFindFirst = mock(() => null as any);
const mockWorkspacesFindFirst = mock(() => null as any);

let selectedWhere: any = null;
let selectRows: Array<{ id: string; content: string | null }> = [];
const joins: string[] = [];
const chain = {
  from: () => chain,
  leftJoin: (t: any) => { joins.push(t?.[Symbol.for('drizzle:Name')] ?? 'table'); return chain; },
  where: (w: any) => { selectedWhere = w; return Promise.resolve(selectRows); },
};
const mockSelect = mock((_sel: unknown) => chain);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({ resolveAccountTeamIds: mockResolveAccountTeamIds }));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missions: { findFirst: mockMissionsFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    select: mockSelect,
  },
}));

const { GET } = await import('./route');
const { RECORDS_CONTENT_MAX_IDS: MAX_IDS } = await import('@/lib/mission-records-content');

const dialect = new PgDialect();
const render = (w: any) => dialect.sqlToQuery(w);

// Illustrative ids only.
const MISSION = '11111111-1111-4111-8111-111111111111';
const A1 = '22222222-2222-4222-8222-222222222222';
const A2 = '33333333-3333-4333-8333-333333333333';

const params = Promise.resolve({ id: MISSION });
const req = (qs: string) => new NextRequest(`http://localhost:3000/api/missions/${MISSION}/artifacts/content${qs}`);

describe('GET /api/missions/[id]/artifacts/content', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockResolveAccountTeamIds.mockReset();
    mockResolveAccountTeamIds.mockResolvedValue(['team-1']);
    mockMissionsFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockSelect.mockClear();
    selectedWhere = null;
    selectRows = [];
    joins.length = 0;
  });

  it('401 without a session or API key', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(req(`?ids=${A1}`), { params });
    expect(res.status).toBe(401);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('404 for a mission outside the caller’s teams', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockMissionsFindFirst.mockResolvedValue({ id: MISSION, teamId: 'team-other', workspaceId: null });
    const res = await GET(req(`?ids=${A1}`), { params });
    expect(res.status).toBe(404);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('returns content by id, scoped to the mission', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockMissionsFindFirst.mockResolvedValue({ id: MISSION, teamId: 'team-1', workspaceId: null });
    selectRows = [{ id: A1, content: '# Example plan' }, { id: A2, content: null }];

    const res = await GET(req(`?ids=${A1},${A2}`), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contents: { [A1]: '# Example plan', [A2]: null } });

    const { sql, params: p } = render(selectedWhere);
    // Both requested ids, and the mission id on both ownership arms.
    expect(p).toContain(A1);
    expect(p).toContain(A2);
    expect(sql).toContain('"artifacts"."mission_id" = ');
    expect(sql).toContain('"tasks"."mission_id" = ');
    expect(sql).toMatch(/ or /);
    expect(p.filter(x => x === MISSION)).toHaveLength(2);
  });

  it('drops non-uuid ids and answers empty without a query when none remain', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockMissionsFindFirst.mockResolvedValue({ id: MISSION, teamId: 'team-1', workspaceId: null });
    const res = await GET(req('?ids=not-a-uuid,,'), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contents: {} });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('caps the id list at RECORDS_CONTENT_MAX_IDS', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockMissionsFindFirst.mockResolvedValue({ id: MISSION, teamId: 'team-1', workspaceId: null });
    const many = Array.from({ length: MAX_IDS + 10 }, (_, i) => `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`);
    await GET(req(`?ids=${many.join(',')}`), { params });
    const { params: p } = render(selectedWhere);
    expect(p.filter(x => typeof x === 'string' && x.startsWith('44444444'))).toHaveLength(MAX_IDS);
  });

  it('allows an open-access workspace mission outside the caller’s teams', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockMissionsFindFirst.mockResolvedValue({ id: MISSION, teamId: 'team-other', workspaceId: 'ws-1' });
    mockWorkspacesFindFirst.mockResolvedValue({ accessMode: 'open' });
    const res = await GET(req(`?ids=${A1}`), { params });
    expect(res.status).toBe(200);
  });
});
