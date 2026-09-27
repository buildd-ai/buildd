import { describe, expect, it, mock } from 'bun:test';

/**
 * The default key check is the one a chat turn makes: the fallback tier through
 * resolveChatModel (which reaches OpenRouter when that is the only key, #2858),
 * not "any provider has any key". Otherwise the nav could say chat is on while
 * every turn fails with no_key.
 */
const calls: any[] = [];
let modelOk = false;

mock.module('@buildd/core/db', () => ({
  db: { query: { teams: { findFirst: async () => ({ chatDisabled: true, inferenceKeyPolicy: 'team' }) } } },
}));
mock.module('@/lib/team-access', () => ({ getUserTeamRole: async () => 'admin' }));
mock.module('@/lib/chat/models', () => ({
  resolveChatModel: async (opts: any) => { calls.push(opts); return modelOk ? { ok: true } : { ok: false, reason: 'no_key' }; },
}));

const { computeChatAvailability } = await import('./chat-availability');
const { FALLBACK_TIER } = await import('./chat/routing');

describe('computeChatAvailability default deps', () => {
  // The team row still carries the deprecated chat_disabled = true: it must not matter.
  it('asks resolveChatModel for the fallback tier, for this person', async () => {
    expect(await computeChatAvailability('u-1', 't-1')).toMatchObject({ available: false, reason: 'no_key', canManageTeamKeys: true });
    expect(calls[0]).toEqual({ tier: FALLBACK_TIER, teamId: 't-1', workspaceId: null, userId: 'u-1' });
    modelOk = true;
    expect((await computeChatAvailability('u-1', 't-1')).available).toBe(true);
  });
});
