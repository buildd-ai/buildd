import { describe, it, expect, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const seen: any[] = [];
mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => ({ caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } }),
  resolveChatTeam: async (_r: any, c: any, requested?: string | null) => ((requested ?? 't-1') === 't-1' ? 't-1' : null),
  chatAvailability: async (...args: any[]) => { seen.push(args); return { available: false, reason: 'capability_disabled', canManageTeamKeys: true }; },
}));
mock.module('@/lib/team-access', () => ({ getUserTeamRole: async () => 'admin' }));

const { GET } = await import('./route');

describe('GET /api/chat/availability', () => {
  it('reports availability for the caller in their team', async () => {
    const res = await GET(new NextRequest('http://localhost/api/chat/availability'));
    expect(await res.json()).toEqual({ available: false, reason: 'capability_disabled', canManageTeamKeys: true });
    expect(seen[0]).toEqual(['t-1', 'u-1', 'admin']);
  });

  it('404s a team the caller is not in', async () => {
    expect((await GET(new NextRequest('http://localhost/api/chat/availability?teamId=t-x'))).status).toBe(404);
  });
});
