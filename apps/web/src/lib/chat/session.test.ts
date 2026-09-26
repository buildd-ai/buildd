import { describe, it, expect, beforeEach, mock } from 'bun:test';

/** Chat availability: on whenever a key resolves, unless an admin switched chat off. */

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

const { chatAvailability, loadTeamChatSettings } = await import('./session');

beforeEach(() => {
  team = { chatDisabled: false, timezone: null, chatDailyBudgetUsd: null, chatUserDailyBudgetUsd: null };
  modelOk = true;
});

describe('chatAvailability', () => {
  it('a key resolves ⇒ available, with no separate "turn on chat" step', async () => {
    expect(await chatAvailability('t', 'u', 'member')).toEqual({ available: true, reason: null, canManageTeamKeys: false });
  });

  it('no key resolves (e.g. an OAuth-only team) ⇒ no_key', async () => {
    modelOk = false;
    expect(await chatAvailability('t', 'u', 'admin')).toEqual({ available: false, reason: 'no_key', canManageTeamKeys: true });
  });

  it('an admin switched chat off ⇒ capability_disabled, even with a key', async () => {
    team.chatDisabled = true;
    expect(await chatAvailability('t', 'u', 'member')).toEqual({ available: false, reason: 'capability_disabled', canManageTeamKeys: false });
  });

  it('the old opt-in list no longer gates chat', async () => {
    team.enabledInferenceCapabilities = null;
    expect((await chatAvailability('t', 'u', 'member')).available).toBe(true);
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
