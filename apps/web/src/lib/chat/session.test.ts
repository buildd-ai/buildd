import { describe, it, expect, beforeEach, mock } from 'bun:test';

/** Chat availability: the capability AND a resolvable key, or nothing shows. */

let team: any = { enabledInferenceCapabilities: null, timezone: null, chatDailyBudgetUsd: null, chatUserDailyBudgetUsd: null };
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
  team = { enabledInferenceCapabilities: null, timezone: null, chatDailyBudgetUsd: null, chatUserDailyBudgetUsd: null };
  modelOk = true;
});

describe('chatAvailability', () => {
  it('capability off (the default) ⇒ no Chat entry point, even with a key', async () => {
    expect(await chatAvailability('t', 'u', 'member')).toEqual({ available: false, reason: 'capability_disabled', canManageTeamKeys: false });
  });

  it('capability on but no key resolves (e.g. an OAuth-only team) ⇒ no turn is possible', async () => {
    team.enabledInferenceCapabilities = ['chat'];
    modelOk = false;
    expect(await chatAvailability('t', 'u', 'admin')).toEqual({ available: false, reason: 'no_key', canManageTeamKeys: true });
  });

  it('capability on and a key ⇒ available', async () => {
    team.enabledInferenceCapabilities = ['chat'];
    expect((await chatAvailability('t', 'u', 'member')).available).toBe(true);
  });

  it('other capabilities being on does not turn chat on', async () => {
    team.enabledInferenceCapabilities = ['criteria_grading', 'task_category_shadow'];
    expect((await chatAvailability('t', 'u', 'member')).available).toBe(false);
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
