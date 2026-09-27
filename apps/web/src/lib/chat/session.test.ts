import { describe, it, expect, beforeEach, mock } from 'bun:test';

/** Team chat settings. Availability itself lives in lib/chat-availability.ts. */

let team: any = { chatDisabled: false, timezone: null, chatDailyBudgetUsd: null, chatUserDailyBudgetUsd: null };
let modelOk = true;

mock.module('@buildd/core/db', () => ({
  db: { query: { teams: { findFirst: async () => team }, workspaces: { findFirst: async () => null } }, update: () => ({}) },
}));
mock.module('@/lib/auth-helpers', () => ({ requireSessionUser: async () => ({ user: { id: 'u' } }) }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => ['t'], getUserTeamRole: async () => 'member', resolveActiveTeamId: async () => 't',
}));
mock.module('./models', () => ({
  resolveChatModel: async () => (modelOk ? { ok: true } : { ok: false, reason: 'no_key', provider: 'anthropic', tier: 'standard' }),
}));

const { loadTeamChatSettings } = await import('./session');

beforeEach(() => {
  team = { chatDisabled: false, timezone: null, chatDailyBudgetUsd: null, chatUserDailyBudgetUsd: null };
  modelOk = true;
});

describe('one availability source', () => {
  it('session no longer carries its own chatAvailability: lib/chat-availability.ts is the only one', async () => {
    const mod = await import('./session') as Record<string, unknown>;
    expect(mod.chatAvailability).toBeUndefined();
  });
});

describe('loadTeamChatSettings', () => {
  it('reads the daily caps as numbers, NULL as not set (the limits apply defaults)', async () => {
    expect(await loadTeamChatSettings('t')).toMatchObject({ dailyBudgetUsd: null, userDailyBudgetUsd: null });
    team.chatDailyBudgetUsd = '12.50';
    team.chatUserDailyBudgetUsd = '4.00';
    expect(await loadTeamChatSettings('t')).toMatchObject({ dailyBudgetUsd: 12.5, userDailyBudgetUsd: 4 });
  });
});
