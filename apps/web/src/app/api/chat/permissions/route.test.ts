import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

let stored: string[] = [];
const sets: Array<[string, string, string, string]> = [];
let callerResponse: Response | null = null;

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => (callerResponse ? { response: callerResponse } : { caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } }),
  resolveChatTeam: async (_req: unknown, caller: { teamIds: string[] }, requested?: string | null) =>
    caller.teamIds.includes(requested ?? 't-1') ? (requested ?? 't-1') : null,
}));
mock.module('@/lib/chat/permissions-store', () => ({
  loadAllowedToolGroups: async () => new Set(stored),
  setToolGroupMode: async (teamId: string, userId: string, group: string, mode: string) => {
    sets.push([teamId, userId, group, mode]);
    stored = mode === 'allow' ? [...new Set([...stored, group])] : stored.filter(g => g !== group);
    return true;
  },
}));

const { GET, PATCH } = await import('./route');

const get = (q = '') => GET(new NextRequest(`http://localhost/api/chat/permissions${q}`));
const patch = (body: unknown) => PATCH(new NextRequest('http://localhost/api/chat/permissions', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => { stored = []; sets.length = 0; callerResponse = null; });

describe('/api/chat/permissions', () => {
  it('GET lists the groups, every write on ask by default', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const { rows } = await res.json();
    expect(rows.find((r: { key: string }) => r.key === 'tasks')).toMatchObject({ mode: 'ask', locked: false });
    expect(rows.find((r: { key: string }) => r.key === 'admin')).toMatchObject({ mode: 'ask', locked: true });
  });

  it('PATCH allows a group for the caller only, and GET reflects it', async () => {
    const res = await patch({ group: 'tasks', mode: 'allow' });
    expect(res.status).toBe(200);
    expect(sets).toEqual([['t-1', 'u-1', 'tasks', 'allow']]);
    const { rows } = await (await get()).json();
    expect(rows.find((r: { key: string }) => r.key === 'tasks').mode).toBe('allow');
  });

  it('locked groups and bad modes are refused', async () => {
    expect((await patch({ group: 'admin', mode: 'allow' })).status).toBe(400);
    expect((await patch({ group: 'prs', mode: 'allow' })).status).toBe(400);
    expect((await patch({ group: 'secrets', mode: 'allow' })).status).toBe(400);
    expect((await patch({ group: 'tasks', mode: 'always' })).status).toBe(400);
    expect(sets).toHaveLength(0);
  });

  it('a team the caller is not in is a 404', async () => {
    expect((await get('?teamId=t-other')).status).toBe(404);
    expect((await patch({ teamId: 't-other', group: 'tasks', mode: 'allow' })).status).toBe(404);
    expect(sets).toHaveLength(0);
  });

  it('refuses without a session', async () => {
    callerResponse = new Response('{}', { status: 401 });
    expect((await get()).status).toBe(401);
  });
});
