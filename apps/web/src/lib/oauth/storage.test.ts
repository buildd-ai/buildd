/**
 * Auth codes and refresh tokens are single-use: consuming one is a single
 * conditional UPDATE ... WHERE <not yet used> RETURNING, so two concurrent
 * exchanges of the same value cannot both succeed (neon-http has no
 * interactive transactions, so a read-then-write would leave a window).
 *
 * The WHERE clause is rendered through PgDialect so the predicate itself is
 * asserted, not just that some update ran.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/oauth/storage.test.ts
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { createHash } from 'crypto';
import { PgDialect } from 'drizzle-orm/pg-core';

type Captured = { table: unknown; set?: Record<string, unknown>; where?: any };
let updates: Captured[] = [];
let selects = 0;
let returningRows: any[] = [];
let membershipRow: any = null;
let workspaceRow: any = null;

const fakeDb = {
  select: () => {
    selects++;
    return { from: () => ({ where: () => ({ limit: async () => [] }) }) };
  },
  update: (table: unknown) => {
    const c: Captured = { table };
    updates.push(c);
    const chain: any = {
      set: (v: Record<string, unknown>) => { c.set = v; return chain; },
      where: (w: unknown) => { c.where = w; return chain; },
      returning: async () => returningRows,
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve([]).then(res, rej),
    };
    return chain;
  },
  query: {
    workspaces: { findFirst: async () => workspaceRow },
    teamMembers: { findFirst: async () => membershipRow },
  },
};

mock.module('@buildd/core/db', () => ({ db: fakeDb }));

import {
  consumeAuthCode,
  consumeRefreshToken,
  userHasWorkspaceMembership,
  revokeRefreshTokensForUserWorkspace,
} from './storage';

const dialect = new PgDialect();
const sqlOf = (w: any) => dialect.sqlToQuery(w).sql;

const VERIFIER = 'verifier-abc';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

beforeEach(() => {
  updates = [];
  selects = 0;
  returningRows = [];
  membershipRow = null;
  workspaceRow = null;
});

describe('consumeAuthCode — single use', () => {
  const args = { code: 'code-1', clientId: 'c_1', redirectUri: 'https://x.example/cb', codeVerifier: VERIFIER };
  const row = {
    userId: 'u-1', workspaceId: 'ws-1', scope: 'mcp', clientId: 'c_1',
    redirectUri: 'https://x.example/cb', codeChallenge: CHALLENGE,
    expiresAt: new Date(Date.now() + 60_000),
  };

  it('claims the code with one conditional UPDATE on consumed_at IS NULL, not a read first', async () => {
    returningRows = [row];
    const result = await consumeAuthCode(args);
    expect(result).toEqual({ userId: 'u-1', workspaceId: 'ws-1', scope: 'mcp' });
    expect(selects).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].set?.consumedAt).toBeInstanceOf(Date);
    const where = sqlOf(updates[0].where);
    expect(where).toContain('"consumed_at" is null');
    expect(where).toContain('"code" = ');
  });

  it('a code the UPDATE did not claim (already used) is invalid_grant', async () => {
    returningRows = [];
    expect(await consumeAuthCode(args)).toEqual({ error: 'invalid_grant' });
  });

  it('rejects a PKCE mismatch even after claiming (the code stays used)', async () => {
    returningRows = [{ ...row, codeChallenge: 'something-else' }];
    expect(await consumeAuthCode(args)).toEqual({ error: 'invalid_grant' });
  });

  it('rejects an expired, wrong-client or wrong-redirect code', async () => {
    returningRows = [{ ...row, expiresAt: new Date(Date.now() - 1000) }];
    expect(await consumeAuthCode(args)).toEqual({ error: 'invalid_grant' });
    returningRows = [{ ...row, clientId: 'c_other' }];
    expect(await consumeAuthCode(args)).toEqual({ error: 'invalid_grant' });
    returningRows = [{ ...row, redirectUri: 'https://y.example/cb' }];
    expect(await consumeAuthCode(args)).toEqual({ error: 'invalid_grant' });
  });
});

describe('consumeRefreshToken — single use', () => {
  const row = { userId: 'u-1', workspaceId: 'ws-1', scope: 'mcp', clientId: 'c_1', expiresAt: new Date(Date.now() + 60_000) };

  it('revokes with one conditional UPDATE on revoked_at IS NULL, not a read first', async () => {
    returningRows = [row];
    const result = await consumeRefreshToken({ token: 't-1', clientId: 'c_1' });
    expect(result).toEqual({ userId: 'u-1', workspaceId: 'ws-1', scope: 'mcp' });
    expect(selects).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].set?.revokedAt).toBeInstanceOf(Date);
    expect(sqlOf(updates[0].where)).toContain('"revoked_at" is null');
  });

  it('a token the UPDATE did not claim is invalid_grant', async () => {
    returningRows = [];
    expect(await consumeRefreshToken({ token: 't-1', clientId: 'c_1' })).toEqual({ error: 'invalid_grant' });
  });

  it('rejects an expired or wrong-client token', async () => {
    returningRows = [{ ...row, expiresAt: new Date(Date.now() - 1000) }];
    expect(await consumeRefreshToken({ token: 't-1', clientId: 'c_1' })).toEqual({ error: 'invalid_grant' });
    returningRows = [{ ...row, clientId: 'c_other' }];
    expect(await consumeRefreshToken({ token: 't-1', clientId: 'c_1' })).toEqual({ error: 'invalid_grant' });
  });
});

describe('workspace membership helpers', () => {
  it('userHasWorkspaceMembership is true only with a team_members row for the workspace team', async () => {
    workspaceRow = { teamId: 'team-1' };
    membershipRow = { role: 'member' };
    expect(await userHasWorkspaceMembership('u-1', 'ws-1')).toBe(true);
    membershipRow = null;
    expect(await userHasWorkspaceMembership('u-1', 'ws-1')).toBe(false);
    workspaceRow = null;
    expect(await userHasWorkspaceMembership('u-1', 'ws-1')).toBe(false);
  });

  it('revokeRefreshTokensForUserWorkspace revokes the outstanding tokens for that user + workspace', async () => {
    await revokeRefreshTokensForUserWorkspace('u-1', 'ws-1');
    expect(updates).toHaveLength(1);
    expect(updates[0].set?.revokedAt).toBeInstanceOf(Date);
    const where = sqlOf(updates[0].where);
    expect(where).toContain('"user_id" = ');
    expect(where).toContain('"workspace_id" = ');
    expect(where).toContain('"revoked_at" is null');
  });
});
