// PATCH /api/accounts/[id]/ai-budget, driven through its handler with fakes
// (no mock.module).
import { describe, it, expect } from 'bun:test';
import { handleAccountAiBudgetPatch, type AccountBudgetDeps } from '@/lib/ai/account-budget';
import type { TeamScopeCaller } from '@/lib/team-access';

const ACCT = '99999999-9999-4999-8999-999999999999';

function makeDeps(caller: TeamScopeCaller | null, opts: { memberOf?: string[]; adminOf?: string[] } = {}) {
  const writes: Array<[string, number | null]> = [];
  const deps: AccountBudgetDeps = {
    caller: async () => caller,
    callerTeamIds: async () => opts.memberOf ?? [],
    canAdminTeam: async (_c, teamId) => (opts.adminOf ?? []).includes(teamId),
    loadAccount: async (id) => (id === ACCT ? { id: ACCT, teamId: 'team-a' } : null),
    setBudget: async (id, usd) => { writes.push([id, usd]); },
  };
  return { deps, writes };
}

const req = (body: unknown) => new Request(`http://localhost/api/accounts/${ACCT}/ai-budget`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const ADMIN: TeamScopeCaller = { kind: 'user', userId: 'u-admin' };

describe('PATCH /api/accounts/[id]/ai-budget', () => {
  it('lets a team admin set and clear the cap', async () => {
    const { deps, writes } = makeDeps(ADMIN, { memberOf: ['team-a'], adminOf: ['team-a'] });
    const res = await handleAccountAiBudgetPatch(req({ aiDailyBudgetUsd: 12.345 }), ACCT, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: ACCT, aiDailyBudgetUsd: 12.35 });
    await handleAccountAiBudgetPatch(req({ aiDailyBudgetUsd: null }), ACCT, deps);
    expect(writes).toEqual([[ACCT, 12.35], [ACCT, null]]);
  });

  it('401s with no caller', async () => {
    const { deps } = makeDeps(null);
    expect((await handleAccountAiBudgetPatch(req({ aiDailyBudgetUsd: 1 }), ACCT, deps)).status).toBe(401);
  });

  it('403s for a plain member of the account\'s team, including the app\'s own non-admin key', async () => {
    const member = makeDeps({ kind: 'user', userId: 'u-member' }, { memberOf: ['team-a'] });
    expect((await handleAccountAiBudgetPatch(req({ aiDailyBudgetUsd: 1 }), ACCT, member.deps)).status).toBe(403);
    const ownKey = makeDeps({ kind: 'account', accountId: ACCT, teamId: 'team-a', level: 'trigger' }, { memberOf: ['team-a'] });
    expect((await handleAccountAiBudgetPatch(req({ aiDailyBudgetUsd: 1000 }), ACCT, ownKey.deps)).status).toBe(403);
    expect([...member.writes, ...ownKey.writes]).toHaveLength(0);
  });

  it('404s for an account in a team the caller is not in, even as an admin elsewhere', async () => {
    const { deps, writes } = makeDeps(ADMIN, { memberOf: ['team-b'], adminOf: ['team-b'] });
    expect((await handleAccountAiBudgetPatch(req({ aiDailyBudgetUsd: 1 }), ACCT, deps)).status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  it('404s for a missing or malformed id', async () => {
    const { deps } = makeDeps(ADMIN, { memberOf: ['team-a'], adminOf: ['team-a'] });
    expect((await handleAccountAiBudgetPatch(req({ aiDailyBudgetUsd: 1 }), 'not-a-uuid', deps)).status).toBe(404);
    expect((await handleAccountAiBudgetPatch(req({ aiDailyBudgetUsd: 1 }), '12121212-1212-4212-8212-121212121212', deps)).status).toBe(404);
  });

  it.each([
    [{}], [{ aiDailyBudgetUsd: -1 }], [{ aiDailyBudgetUsd: '5' }], [{ aiDailyBudgetUsd: 1e9 }], [{ aiDailyBudgetUsd: 1, other: true }],
  ])('400s on %j', async (body) => {
    const { deps } = makeDeps(ADMIN, { memberOf: ['team-a'], adminOf: ['team-a'] });
    expect((await handleAccountAiBudgetPatch(req(body), ACCT, deps)).status).toBe(400);
  });
});
