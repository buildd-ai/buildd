/**
 * GET /api/missions/recent (spec c7410e76 R-24): who may ask, that the read is
 * scoped to the caller's reachable workspaces, the shape handed back, and the
 * not-changed reply (spec 3ef37387 R-20, AC-4).
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
  return rows.filter(r => r.status !== 'completed' && params.includes(r.status));
});
/** The delivered read's builder chain: records each clause, answers the completed rows. */
let deliveredCalls: Record<string, any[]> = {};
const mockSelect = mock((fields: any) => {
  deliveredCalls = { fields: [fields] };
  const chain: any = {};
  for (const k of ['from', 'leftJoin', 'where', 'groupBy', 'having', 'orderBy', 'limit']) {
    chain[k] = (...args: any[]) => { deliveredCalls[k] = args; return chain; };
  }
  chain.then = (ok: any, bad: any) => Promise.resolve()
    .then(() => { if (selectFails) throw new Error('boom'); return rows.filter(r => r.status === 'completed').slice(0, deliveredCalls.limit?.[0] ?? Infinity); })
    .then(ok, bad);
  return chain;
});
let selectFails = false;

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/workspace-access', () => ({ listReachableWorkspaceIds: mockListReachable }));
mock.module('@/lib/mission-stage-load', () => ({ loadMissionStages: mockLoadMissionStages }));
mock.module('@buildd/core/db', () => ({ db: { query: { missions: { findMany: mockFindMany } }, select: mockSelect } }));
mock.module('@/lib/redis', () => ({
  mgetKeys: async (keys: string[]) => keys.map(k => versions.get(k) ?? null),
  setKeys: async (entries: Array<[string, string]>, _ttl: number, opts?: { nx?: boolean }) => {
    for (const [k, v] of entries) if (!opts?.nx || !versions.has(k)) versions.set(k, v);
    return true;
  },
}));
const versions = new Map<string, string>();

const { GET } = await import('./route');
const { RECENT_DAYS, completionNoteSql } = await import('@/lib/missions-recent');
const { missionStatusNoteBody, MISSION_COMPLETED_MARKER } = await import('@/lib/mission-status-note');
const { MAX_STAGE_MISSION_IDS } = await import('@/lib/mission-stage');
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
    selectFails = false;
    versions.clear();
    mockSelect.mockClear();
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

  it('keeps stale open missions even when recent deliveries exceed the cap', async () => {
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
    const open = mockFindMany.mock.calls[0]![0] as any;
    expect(open.limit).toBeUndefined();
    expect(dialect.sqlToQuery(open.where).params).toEqual(['ws-1', 'active', 'paused', 'budget_exhausted']);
    expect(deliveredCalls.limit).toEqual([300]);
    expect(dialect.sqlToQuery(deliveredCalls.where[0]).params).toEqual(['ws-1', 'completed']);
  });

  it('asks for at most MAX_STAGE_MISSION_IDS stages, the first listed, and still lists every mission', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    mockListReachable.mockResolvedValue(['ws-1']);
    rows = Array.from({ length: MAX_STAGE_MISSION_IDS + 20 }, (_, i) => ({ id: `open-${i}`, workspaceId: 'ws-1', status: 'active', deliveredAt: null }));
    stagesImpl = async (ids) => new Map(ids.map(id => [id, { step: 'building', waitingOn: null }]));
    const body = await (await GET(req({ authorization: 'Bearer bld_x' }))).json();
    expect(MAX_STAGE_MISSION_IDS).toBe(100);
    expect(mockLoadMissionStages).toHaveBeenCalledTimes(1);
    expect(mockLoadMissionStages.mock.calls[0]![0]).toEqual(rows.slice(0, MAX_STAGE_MISSION_IDS).map(r => r.id));
    expect(body.missions).toHaveLength(MAX_STAGE_MISSION_IDS + 20);
    expect(body.missions[MAX_STAGE_MISSION_IDS - 1].stage).toEqual({ step: 'building', waitingOn: null });
    // Past the cap a mission is listed without a stage, never a fabricated one.
    expect(body.missions[MAX_STAGE_MISSION_IDS].stage).toBeNull();
  });

  it('reads the delivered time from the latest transition into completed, not the first stamp', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    mockListReachable.mockResolvedValue(['ws-1']);
    await GET(req({ authorization: 'Bearer bld_x' }));
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(RECENT_DAYS).toBe(7);
    const args = mockFindMany.mock.calls[0]![0] as any;
    expect(args.columns.workspaceId).toBe(true);
    expect(args.columns.completedAt).toBeUndefined();
    expect(args.extras).toBeUndefined();
    expect(Object.keys(deliveredCalls.fields[0])).toContain('deliveredAt');
  });

  describe('the delivered read, rendered (a mocked builder cannot run it)', () => {
    const render = (x: any) => dialect.sqlToQuery(x);
    // Drizzle's parenthesisation is not the point: compare the clauses.
    const text = (x: any) => render(x).sql.replace(/[()]/g, '').replace(/\s+/g, ' ');

    it('one grouped pass: the window\'s completion notes joined to the reachable completed missions, no correlated subquery', async () => {
      mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
      mockListReachable.mockResolvedValue(['ws-1', 'ws-2']);
      await GET(req({ authorization: 'Bearer bld_x' }));
      const since = day(RECENT_DAYS);
      const join = render(deliveredCalls.leftJoin[1]);
      expect(text(deliveredCalls.leftJoin[1])).toBe(
        '"mission_notes"."mission_id" = "missions"."id" and "mission_notes"."created_at" >= $1 and "mission_notes"."type" = \'update\' '
        + 'and "mission_notes"."collapse_key" = $2 or "mission_notes"."author_type" = \'system\' and "mission_notes"."title" in $3, $4 '
        + 'and "mission_notes"."body" like $5',
      );
      expect(Math.abs(new Date(join.params[0] as string).getTime() - since.getTime())).toBeLessThan(5_000);
      expect(join.params.slice(1)).toEqual([MISSION_COMPLETED_MARKER, 'Mission status changed', 'Mission reopened', '% → completed']);
      expect(text(deliveredCalls.where[0])).toBe('"missions"."workspace_id" in $1, $2 and "missions"."status" = $3');
      expect(text(deliveredCalls.having[0])).toBe('greatest"missions"."completed_at", max"mission_notes"."created_at" >= $1');
      expect(text(deliveredCalls.fields[0].deliveredAt)).not.toContain('select');
    });

    it('a re-completion through a status PATCH counts: its "→ completed" feed note is read', () => {
      const delivered = dialect.sqlToQuery(completionNoteSql());
      const pattern = delivered.params.find(p => typeof p === 'string' && p.includes('→')) as string;
      // The pattern matches exactly the body the PATCH route writes for a transition into completed.
      const like = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`);
      expect(like.test(missionStatusNoteBody('active', 'completed'))).toBe(true);
      expect(like.test(missionStatusNoteBody('archived', 'completed'))).toBe(true);
      expect(like.test(missionStatusNoteBody('completed', 'active'))).toBe(false);
    });

    it('a forged post_note (author_type != system) with body matching "→ completed" does not update delivered time', () => {
      const rendered = dialect.sqlToQuery(completionNoteSql());
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

  it('AC-4: a client holding the current version gets 304 and no mission is read', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    mockListReachable.mockResolvedValue(['ws-1']);
    rows = [{ id: 'm-open', title: 'Open', workspaceId: 'ws-1', status: 'active', isHeld: false, executor: 'runner' }];
    // First read seeds the version (fail open: no tag yet); the second carries it.
    expect((await GET(req({ authorization: 'Bearer bld_x' }))).headers.get('etag')).toBeNull();
    const full = await GET(req({ authorization: 'Bearer bld_x' }));
    const tag = full.headers.get('etag')!;
    expect(tag).toMatch(/^W\/"cv1-/);
    for (const m of [mockFindMany, mockSelect, mockLoadMissionStages]) m.mockClear();
    const res = await GET(req({ authorization: 'Bearer bld_x', 'if-none-match': tag }));
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(tag);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockLoadMissionStages).not.toHaveBeenCalled();
  });

  it('a write to the workspace moves the version: the old tag reads in full', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    mockListReachable.mockResolvedValue(['ws-1']);
    await GET(req({ authorization: 'Bearer bld_x' }));
    const tag = (await GET(req({ authorization: 'Bearer bld_x' }))).headers.get('etag')!;
    versions.set('buildd:cv:ws:ws-1', 'moved');
    const res = await GET(req({ authorization: 'Bearer bld_x', 'if-none-match': tag }));
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).not.toBe(tag);
  });

  it('500 with a plain message when the read fails', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    mockListReachable.mockResolvedValue(['ws-1']);
    mockFindMany.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(req({ authorization: 'Bearer bld_x' }));
    expect(res.status).toBe(500);
  });
});
