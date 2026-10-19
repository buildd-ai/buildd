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
// The read itself (scoping, the delivered window and date, the cap) runs on
// real Postgres in apps/web/tests/db/missions-recent.test.ts; here it hands back rows.
const mockLoadRecent = mock(async (_workspaceIds: string[]): Promise<any[]> => rows);

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/workspace-access', () => ({ listReachableWorkspaceIds: mockListReachable }));
mock.module('@/lib/mission-stage-load', () => ({ loadMissionStages: mockLoadMissionStages }));
const realRecent = await import('@/lib/missions-recent');
mock.module('@/lib/missions-recent', () => ({ ...realRecent, loadRecentMissions: mockLoadRecent }));

const { GET } = await import('./route');
const { RECENT_DAYS, recentMissionsWhere, deliveredAtSql, deliveredAtSqlFor } = realRecent;
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
    for (const m of [mockGetCurrentUser, mockAuthenticateApiKey, mockListReachable, mockLoadMissionStages, mockLoadRecent]) m.mockClear();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockListReachable.mockResolvedValue([]);
    stagesImpl = async () => new Map();
    rows = [];
  });

  it('401 without a key or a session, and reads nothing', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mockLoadRecent).not.toHaveBeenCalled();
  });

  it('reaches no workspace: empty list, no read', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    const res = await GET(req({ authorization: 'Bearer bld_x' }));
    expect(await res.json()).toEqual({ missions: [] });
    expect(mockLoadRecent).not.toHaveBeenCalled();
  });

  it('scopes to the reachable workspaces and returns open and recently finished missions with their stage', async () => {
    const account = { id: 'a1' };
    mockAuthenticateApiKey.mockResolvedValue(account);
    mockListReachable.mockResolvedValue(['ws-1', 'ws-2']);
    rows = [
      { id: 'm-open', title: 'Open one', workspaceId: 'ws-1', status: 'active', isHeld: false, executor: 'runner', completedAt: null },
      { id: 'm-local', title: 'Local one', workspaceId: 'ws-2', status: 'paused', isHeld: true, executor: 'local', completedAt: null },
      { id: 'm-reopened', title: 'Reopened', workspaceId: 'ws-1', status: 'active', isHeld: false, executor: 'runner', completedAt: null },
      { id: 'm-done', title: 'Done one', workspaceId: 'ws-1', status: 'completed', isHeld: false, executor: 'runner', completedAt: day(2).toISOString() },
    ];
    stagesImpl = async () => new Map([['m-open', { step: 'building', waitingOn: null }]]);

    const res = await GET(req({ authorization: 'Bearer bld_x' }));
    expect(res.status).toBe(200);
    expect(mockListReachable.mock.calls[0]![0]).toEqual({ account });
    expect(mockLoadRecent.mock.calls[0]![0]).toEqual(['ws-1', 'ws-2']);
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

  it('asks for at most MAX_STAGE_MISSION_IDS stages, the first listed, and still lists every mission', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'a1' });
    mockListReachable.mockResolvedValue(['ws-1']);
    rows = Array.from({ length: MAX_STAGE_MISSION_IDS + 20 }, (_, i) => ({ id: `open-${i}`, workspaceId: 'ws-1', status: 'active', completedAt: null }));
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

  describe('the WHERE, rendered (a mocked findMany cannot see it)', () => {
    const since = day(RECENT_DAYS);
    const rendered = dialect.sqlToQuery(recentMissionsWhere(['ws-1', 'ws-2'], since)!);
    const text = rendered.sql.replace(/\s+/g, ' ');

    it('is the reachable workspaces AND (open status OR completed and delivered since the window start), nothing else', () => {
      expect(text).toBe(
        '(("missions"."workspace_id" in ($1, $2)) and ((("missions"."status" in ($3, $4, $5)) or ((("missions"."status" = $6) and '
        + '(greatest("missions"."completed_at", ( select max("mission_notes"."created_at") from "mission_notes" '
        + 'where "mission_notes"."mission_id" = "missions"."id" and "mission_notes"."created_at" >= $7 and "mission_notes"."type" = \'update\' '
        + 'and ("mission_notes"."collapse_key" = $8 or ("mission_notes"."author_type" = \'system\' and "mission_notes"."title" in ($9, $10) '
        + 'and "mission_notes"."body" like $11)) )) >= $12))))))',
      );
      expect(rendered.params.slice(0, 11)).toEqual(['ws-1', 'ws-2', 'active', 'paused', 'budget_exhausted', 'completed', since, MISSION_COMPLETED_MARKER, 'Mission status changed', 'Mission reopened', '% → completed']);
      expect(new Date(rendered.params[11] as string).getTime()).toBe(since.getTime());
    });

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
    mockLoadRecent.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(req({ authorization: 'Bearer bld_x' }));
    expect(res.status).toBe(500);
  });
});
