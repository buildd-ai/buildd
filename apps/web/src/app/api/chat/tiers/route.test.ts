import { describe, it, expect, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const scopes: Array<{ teamId: string; workspaceId: string | null }> = [];

mock.module('@/lib/chat/session', () => ({
  requireChatCaller: async () => ({ caller: { user: { id: 'u-1' }, teamIds: ['t-1'] } }),
  resolveChatTeam: async (_req: unknown, caller: { teamIds: string[] }, requested?: string | null) =>
    caller.teamIds.includes(requested ?? 't-1') ? (requested ?? 't-1') : null,
}));
mock.module('@/lib/chat/store', () => ({
  getOwnConversation: async (id: string, userId: string) => (id === 'c-1' && userId === 'u-1'
    ? { id: 'c-1', teamId: 't-1', workspaceId: 'ws-1', tier: 'premium' }
    : null),
  conversationCostUsd: async () => 0.0421,
}));
mock.module('@/lib/chat/tier-info', () => ({
  loadChatTiers: async (scope: { teamId: string; workspaceId: string | null }) => {
    scopes.push(scope);
    return [{ tier: 'standard', model: 'm', models: ['m'], inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 }];
  },
}));

const { GET } = await import('./route');
const get = (q: string) => GET(new NextRequest(`http://localhost/api/chat/tiers${q}`));

describe('GET /api/chat/tiers', () => {
  it('tiers for the team; no conversation ⇒ no pin, no cost', async () => {
    const body = await (await get('')).json();
    expect(body).toEqual({ tiers: [expect.objectContaining({ tier: 'standard' })], pinned: null, conversationCostUsd: null });
  });

  it('a conversation adds its pin and running cost, priced in its own scope', async () => {
    scopes.length = 0;
    const body = await (await get('?conversationId=c-1')).json();
    expect(body.pinned).toBe('premium');
    expect(body.conversationCostUsd).toBe(0.0421);
    expect(scopes[0]).toEqual({ teamId: 't-1', workspaceId: 'ws-1' });
  });

  it('someone else\'s conversation, or another team, is a 404', async () => {
    expect((await get('?conversationId=c-other')).status).toBe(404);
    expect((await get('?teamId=t-other')).status).toBe(404);
  });
});
