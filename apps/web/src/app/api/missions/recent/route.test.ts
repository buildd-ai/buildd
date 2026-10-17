/**
 * GET /api/missions/recent (spec c7410e76 R-24): who may ask, that the read is
 * scoped to the caller's reachable workspaces, and the shape handed back.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

const mockGetCurrentUser = mock(async (): Promise<any> => null);
const mockAuthenticateApiKey = mock(async (_key: string | null, _req?: unknown): Promise<any> => null);
const mockListReachable = mock(async (_caller: unknown): Promise<string[]> => []);
let stagesImpl: (missionIds: string[], workspaceIds: string[]) => Promise<Map<string, any>> = async () => new Map();
const mockLoadMissionStages = mock((missionIds: string[], workspaceIds: string[]) => stagesImpl(missionIds, workspaceIds));
let rows: any[] = [];
const mockFindMany = mock(async (args: any): Promise<any[]> => {
  const params = dialect.sqlToQuery(args.where).params;
  const matches = rows.filter(r => params.includes(r.status));
  return args.limit ? matches.slice(0, args.limit) : matches;
});

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/workspace-access', () => ({ listReachableWorkspaceIds: mockListReachable }));
mock.module('@/lib/mission-stage-load', () => ({ loadMissionStages: mockLoadMissionStages }));
mock.module('@buildd/core/db', () => ({ db: { query: { missions: { findMany: mockFindMany } } } }));

const { GET } = await import('./route');
const { RECENT_DAYS, deliveredAtSql, deliveredAtSqlFor } = await import('@/lib/missions-recent');
const { missionStatusNoteBody, MISSION_COMPLETED_MARKER } = await import('@/lib/mission-status-note');
const dialect = new PgDialect();

const NOW = Date.now();
const day = (n: number) => new Date(NOW - n * 86_400_000);

function req(headers: Record<string, string> = {}) {
  return new NextRequest(new URL('http://localhost:3000/api/missions/recent'), { headers });
}

describe('GET /api/missions/recent', () => {
  beforeEach(() => {
    for (const m of [mockGetCurrentUser, mockAuthenticateApiKey, mockListReachable, mockLoadMissionStages, mockFindMany]) m.mockClear();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockListReachable.mockResolvedValue([]);
    stagesImpl = async () => new Map();
    rows = [];
  });

  it('401 without a key or a session, and reads nothing', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('reaches no workspace: empty list, no read', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    const res = await GET(req({ authorization: 'Bearer bld_x' }));
    expect(await res.json()).toEqual({ missions: [] });
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('scopes to the reachable workspaces and returns open and recently finished missions with their stage', async () => {
    const account = { id: 'a1' };
    mockAuthenticateApiKey.mockResolvedValue(account);
    mockListReachable.mockResolvedValue(['ws-1', 'ws-2']);
    rows = [
      { id: 'm-open', title: 'Open one', workspaceId: 'ws-1', status: 'active', isHeld: false, executor: 'runner', deliveredAt: null },
      { id: 'm-local', title: 'Local one', workspaceId: 'ws-2', status: 'paused', isHeld: true, executor: 'local', deliveredAt: null },
      // neon-http hands a raw-SQL timestamp back as a string.
      { id: 'm-done', title: 'Done one', workspaceId: 'ws-1', status: 'completed', isHeld: false, executor: 'runner', deliveredAt: day(2).toISOString().replace('T', ' ') },
      // Reopened: open again, so never delivered, whatever an old stamp says.
      { id: 'm-reopened', title: 'Reopened', workspaceId: 'ws-1', status: 'active', isHeld: false, executor: 'runner', deliveredAt: day(3) },
    ];
    stagesImpl = async () => new Map([['m-open', { step: 'building', waitingOn: null }]]);

    const res = await GET(req({ authorization: 'Bearer bld_x' }));
    expect(res.status).toBe(200);
    expect(mockListReachable.mock.calls[0]![0]).toEqual({ account });
    expect(mockLoadMissionStages.mock.calls[0]).toEqual([['m-open', 'm-local', 'm-reopened', 'm-done'], ['ws-1', 'ws-2']]);
    const body = await res.json();
    expect(body.missions.map((m: any) => m.id)).toEqual(['m-open', 'm-local', 'm-reopened', 'm-done']);
    expect(body.missions[0]).toEqual({
      id: 'm-open', title: 'Open one', workspaceId: 'ws-1', status: 'active', isHeld: false, executor: 'runner',
      completedAt: null, stage: { step: 'building', waitingOn: null },
    });
    expect(body.missions[1].executor).toBe('local');
    expect(body.missions[1].isHeld).toBe(true);
    expect(body.missions[3].completedAt).toBe(day(2).toISOString());
    expect(body.missions[2]).toMatchObject({ status: 'active', completedAt: null });
    expect(body.missions[3].stage).toBeNull();
  });

  it('keeps stale open missions even when recent deliveries exceed the cap, but caps open missions with a safety limit', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    mockListReachable.mockResolvedValue(['ws-1']);
    rows = [
      ...Array.from({ length: 301 }, (_, i) => ({ id: `done-${i}`, status: 'completed', deliveredAt: day(1) })),
      ...Array.from({ length: 301 }, (_, i) => ({ id: `open-${i}`, status: 'active', deliveredAt: null })),
      { id: 'held', status: 'paused' },
      { id: 'budget', status: 'budget_exhausted' },
    ];
    const body = await (await GET(req({ authorization: 'Bearer bld_x' }))).json();
    expect(body.missions.filter((m: any) => m.status !== 'completed')).toHaveLength(303);
    expect(body.missions.filter((m: any) => m.status === 'completed')).toHaveLength(300);
    const calls = mockFindMany.mock.calls.map(([args]) => args as any);
    expect(calls[0].limit).toBe(1001); // MAX_OPEN_MISSIONS + 1 for overflow detection
    expect(calls[1].limit).toBe(300);
    expect(dialect.sqlToQuery(calls[0].where).params).toEqual(['ws-1', 'active', 'paused', 'budget_exhausted']);
    expect(dialect.sqlToQuery(calls[1].where).params).toContain('completed');
    expect(dialect.sqlToQuery(calls[1].where).params).not.toContain('active');
  });

  it('reads the delivered time from the latest transition into completed, not the first stamp', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    mockListReachable.mockResolvedValue(['ws-1']);
    await GET(req({ authorization: 'Bearer bld_x' }));
    expect(mockFindMany).toHaveBeenCalledTimes(2);
    expect(RECENT_DAYS).toBe(7);
    const args = mockFindMany.mock.calls[0]![0] as any;
    expect(args.columns.workspaceId).toBe(true);
    expect(args.columns.completedAt).toBeUndefined();
    expect(Object.keys(args.extras)).toEqual(['deliveredAt']);
  });

  describe('delivered time calculation', () => {
    it('a re-completion through a status PATCH counts: its "→ completed" feed note is read', () => {
      const delivered = dialect.sqlToQuery(deliveredAtSql);
      const pattern = delivered.params.find(p => typeof p === 'string' && p.includes('→')) as string;
      // The pattern matches exactly the body the PATCH route writes for a transition into completed.
      const like = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`);
      expect(like.test(missionStatusNoteBody('active', 'completed'))).toBe(true);
      expect(like.test(missionStatusNoteBody('archived', 'completed'))).toBe(true);
      expect(like.test(missionStatusNoteBody('completed', 'active'))).toBe(false);
    });

    it('a forged post_note (author_type != system) with body matching "→ completed" does not update delivered time', () => {
      const rendered = dialect.sqlToQuery(deliveredAtSqlFor(new Date(0)));
      const sql = rendered.sql;
      // The query must check author_type = 'system' to reject user-posted notes
      expect(sql).toContain('author_type');
      expect(sql).toContain("'system'");
      // The query must check the title is one of the system-generated ones
      expect(sql).toContain('title');
      const titleCheck = [...sql.matchAll(/title.*in\s*\([^)]+\)/g)];
      expect(titleCheck.length).toBeGreaterThan(0);
    });
  });

  it('500 with a plain message when the read fails', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    mockListReachable.mockResolvedValue(['ws-1']);
    mockFindMany.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(req({ authorization: 'Bearer bld_x' }));
    expect(res.status).toBe(500);
  });
});
