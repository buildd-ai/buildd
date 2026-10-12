import { beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * Who counts as a buildd platform operator outside /api/admin/* (experiments,
 * the raw decision ledger). Synthetic ids and addresses only.
 */
let userRow: { email: string | null } | null = null;
const userLookups: unknown[] = [];

mock.module('@buildd/core/db', () => ({
  db: { query: { users: { findFirst: async (q: unknown) => { userLookups.push(q); return userRow; } } } },
}));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => null }));

process.env.BUILDD_OPERATOR_USER_EMAILS = 'op@example.com';
process.env.BUILDD_PLATFORM_ADMIN_ACCOUNT_IDS = 'platform-acct';

const { isPlatformOperatorAccount, isPlatformOperatorCaller, isPlatformOperatorUserId } = await import('./platform-operator-caller');

beforeEach(() => {
  userRow = null;
  userLookups.length = 0;
});

describe('isPlatformOperatorCaller', () => {
  it('a signed-in person on the operator list is one; anyone else, a team owner included, is not', async () => {
    expect(await isPlatformOperatorCaller({ user: { email: 'OP@example.com' } })).toBe(true);
    expect(await isPlatformOperatorCaller({ user: { email: 'owner@example.com' } })).toBe(false);
    expect(await isPlatformOperatorCaller({ user: null })).toBe(false);
  });

  it('a presented credential wins over the cookie session', async () => {
    expect(await isPlatformOperatorCaller({ user: { email: 'op@example.com' }, account: { id: 'team-acct', level: 'admin' } })).toBe(false);
  });
});

describe('isPlatformOperatorAccount', () => {
  it('an admin-level key of a platform admin account is one', async () => {
    expect(await isPlatformOperatorAccount({ id: 'platform-acct', level: 'admin' })).toBe(true);
  });

  it('a team admin key is not, and a platform admin account below admin level is not', async () => {
    expect(await isPlatformOperatorAccount({ id: 'team-acct', level: 'admin' })).toBe(false);
    expect(await isPlatformOperatorAccount({ id: 'platform-acct', level: 'worker' })).toBe(false);
  });

  it("an OAuth bearer is judged by its person, never by the team's shared session account", async () => {
    userRow = { email: 'owner@example.com' };
    expect(await isPlatformOperatorAccount({ id: 'platform-acct', level: 'admin', oauthUserId: 'u-owner' })).toBe(false);
    userRow = { email: 'op@example.com' };
    expect(await isPlatformOperatorAccount({ id: 'team-acct', level: 'worker', oauthUserId: 'u-op' })).toBe(true);
  });
});

describe('isPlatformOperatorUserId', () => {
  it('no user id or an unknown user is not one, without guessing', async () => {
    expect(await isPlatformOperatorUserId(null)).toBe(false);
    expect(userLookups).toHaveLength(0);
    expect(await isPlatformOperatorUserId('u-gone')).toBe(false);
  });

  it('fails closed when the operator list is unset', async () => {
    const saved = process.env.BUILDD_OPERATOR_USER_EMAILS;
    delete process.env.BUILDD_OPERATOR_USER_EMAILS;
    try {
      userRow = { email: 'op@example.com' };
      expect(await isPlatformOperatorUserId('u-op')).toBe(false);
    } finally {
      process.env.BUILDD_OPERATOR_USER_EMAILS = saved;
    }
  });
});
