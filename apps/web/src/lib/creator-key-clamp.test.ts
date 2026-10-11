/**
 * clampCreatorKeys — when it writes at all, and what it does with the result.
 * The UPDATE's WHERE and SET are proven against real Postgres in
 * apps/web/tests/db/creator-key-clamp.test.ts; a mocked db cannot see them.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

let statements = 0;
let returned: Array<{ id: string; apiKey: string }> = [];
const invalidated: string[] = [];

mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => { statements++; return returned; },
        }),
      }),
    }),
  },
}));
mock.module('./api-auth', () => ({ invalidateAccountCacheByHash: (h: string) => { invalidated.push(h); } }));

import { ADMIN_GRANT_SCOPES, clampCreatorKeys, keyCeilingFor } from './creator-key-clamp';
import { TOKEN_SCOPES, requiresTeamAdminToGrant } from '@buildd/core/token-scopes';

beforeEach(() => {
  statements = 0;
  returned = [];
  invalidated.length = 0;
});

describe('keyCeilingFor', () => {
  it('owner and admin keep admin keys; a member stops at worker', () => {
    expect(keyCeilingFor('owner')).toBe('admin');
    expect(keyCeilingFor('admin')).toBe('admin');
    expect(keyCeilingFor('member')).toBe('worker');
  });

  it('someone no longer in the team gets the member ceiling', () => {
    expect(keyCeilingFor(null)).toBe('worker');
  });
});

describe('ADMIN_GRANT_SCOPES', () => {
  it('is exactly the scopes a member may not grant', () => {
    expect([...ADMIN_GRANT_SCOPES].sort()).toEqual(TOKEN_SCOPES.filter(requiresTeamAdminToGrant).sort());
    expect(ADMIN_GRANT_SCOPES).toContain('admin');
    expect(ADMIN_GRANT_SCOPES).not.toContain('tasks:read');
  });
});

describe('clampCreatorKeys', () => {
  it('writes nothing when the new role may still mint admin keys', async () => {
    expect(await clampCreatorKeys({ teamId: 't', userId: 'u', role: 'admin' })).toBe(0);
    expect(await clampCreatorKeys({ teamId: 't', userId: 'u', role: 'owner' })).toBe(0);
    expect(statements).toBe(0);
  });

  it('demotion to member runs the clamp, counts rows, and drops their cached auth', async () => {
    returned = [{ id: 'a', apiKey: 'hash-a' }, { id: 'b', apiKey: 'hash-b' }];
    expect(await clampCreatorKeys({ teamId: 't', userId: 'u', role: 'member' })).toBe(2);
    expect(statements).toBe(1);
    expect(invalidated).toEqual(['hash-a', 'hash-b']);
  });

  it('removal always runs the clamp', async () => {
    expect(await clampCreatorKeys({ teamId: 't', userId: 'u', role: null })).toBe(0);
    expect(statements).toBe(1);
  });
});
