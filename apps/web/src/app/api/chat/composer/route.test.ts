import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const saves: Array<[string, string, unknown]> = [];
const seeds: Array<[string, string, readonly string[]]> = [];

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => ({ caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } }),
  resolveChatTeam: async (_req: unknown, caller: { teamIds: string[] }, requested?: string | null) =>
    caller.teamIds.includes(requested ?? 't-1') ? (requested ?? 't-1') : null,
}));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: async (_u: string, ws: string) => (ws === 'ws-1' ? { teamId: 't-1' } : ws === 'ws-x' ? { teamId: 't-other' } : null),
  getTeamWorkspaceIds: async () => ['ws-1'],
}));
mock.module('@/lib/chat/composer-prefs-store', () => ({
  loadComposerSeed: async (teamId: string, userId: string, ids: readonly string[]) => {
    seeds.push([teamId, userId, ids]);
    return { workspaceId: 'ws-1', tier: 'standard' };
  },
  saveComposerPrefs: async (teamId: string, userId: string, patch: unknown) => { saves.push([teamId, userId, patch]); return true; },
}));

const { GET, PATCH } = await import('./route');

const get = (q = '') => GET(new NextRequest(`http://localhost/api/chat/composer${q}`));
const patch = (body: unknown) => PATCH(new NextRequest('http://localhost/api/chat/composer', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => { saves.length = 0; seeds.length = 0; });

describe('/api/chat/composer', () => {
  it('GET returns the caller\'s seed for the team', async () => {
    const res = await get('?teamId=t-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: 'ws-1', tier: 'standard' });
    expect(seeds).toEqual([['t-1', 'u-1', ['ws-1']]]);
  });

  it('PATCH remembers only the keys sent, null included', async () => {
    expect((await patch({ tier: 'premium' })).status).toBe(200);
    expect((await patch({ workspaceId: null })).status).toBe(200);
    expect((await patch({ workspaceId: 'ws-1', tier: null })).status).toBe(200);
    expect(saves).toEqual([
      ['t-1', 'u-1', { tier: 'premium' }],
      ['t-1', 'u-1', { workspaceId: null }],
      ['t-1', 'u-1', { workspaceId: 'ws-1', tier: null }],
    ]);
  });

  it('refuses an unknown tier, or a workspace outside the team', async () => {
    expect((await patch({ tier: 'premium-plus' })).status).toBe(400);
    expect((await patch({ workspaceId: 'ws-x' })).status).toBe(404);
    expect((await patch({ workspaceId: 'nope' })).status).toBe(404);
    expect((await patch({})).status).toBe(400);
    expect(saves).toHaveLength(0);
  });

  it('a team the caller is not in is a 404', async () => {
    expect((await get('?teamId=t-other')).status).toBe(404);
    expect((await patch({ teamId: 't-other', tier: 'budget' })).status).toBe(404);
  });
});
