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
let inserts: Array<{ table: unknown; values: any }> = [];

const fakeDb = {
  insert: (table: unknown) => ({
    values: async (values: unknown) => { inserts.push({ table, values }); },
  }),
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
  createRefreshToken,
  hashRefreshToken,
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
  inserts = [];
});

import { REFRESH_TOKEN_ABSOLUTE_LIFETIME_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from './config';
const DAY = 24 * 60 * 60 * 1000;


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

describe('createRefreshToken — stored as a hash, in a family', () => {
  it('stores the SHA-256 of the token, never the token', async () => {
    const token = await createRefreshToken({ clientId: 'c_1', userId: 'u-1', workspaceId: 'ws-1', scope: 'mcp' });
    expect(inserts).toHaveLength(1);
    const v = inserts[0].values;
    expect(v.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(v.tokenHash).toBe(hashRefreshToken(token));
    expect(JSON.stringify(v)).not.toContain(token);
  });

  it('a sign-in starts a new family issued now', async () => {
    const before = Date.now();
    await createRefreshToken({ clientId: 'c_1', userId: 'u-1', workspaceId: 'ws-1', scope: 'mcp' });
    await createRefreshToken({ clientId: 'c_1', userId: 'u-1', workspaceId: 'ws-1', scope: 'mcp' });
    const [a, b] = inserts.map((i) => i.values);
    expect(typeof a.familyId).toBe('string');
    expect(a.familyId).not.toBe(b.familyId);
    expect(a.familyIssuedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(a.createdAt.getTime()).toBe(a.familyIssuedAt.getTime());
  });

  it('a rotated token keeps its family and sign-in time, and expires no later than the absolute cap', async () => {
    const issuedAt = new Date(Date.now() - 80 * DAY);
    await createRefreshToken({
      clientId: 'c_1', userId: 'u-1', grantId: 'g-1', scope: 'mcp',
      family: { familyId: 'fam-1', familyIssuedAt: issuedAt },
    });
    const v = inserts[0].values;
    expect(v.familyId).toBe('fam-1');
    expect(v.familyIssuedAt).toEqual(issuedAt);
    expect(v.expiresAt.getTime()).toBe(issuedAt.getTime() + REFRESH_TOKEN_ABSOLUTE_LIFETIME_SECONDS * 1000);
  });

  it('expiry is the sooner of the sliding per-token TTL and the family cap', async () => {
    const issuedAt = new Date(Date.now() - DAY);
    const before = Date.now();
    await createRefreshToken({
      clientId: 'c_1', userId: 'u-1', workspaceId: 'ws-1', scope: 'mcp',
      family: { familyId: 'fam-1', familyIssuedAt: issuedAt },
    });
    const after = Date.now();
    const exp = inserts[0].values.expiresAt.getTime();
    const cap = issuedAt.getTime() + REFRESH_TOKEN_ABSOLUTE_LIFETIME_SECONDS * 1000;
    expect(exp).toBeGreaterThanOrEqual(Math.min(cap, before + REFRESH_TOKEN_TTL_SECONDS * 1000));
    expect(exp).toBeLessThanOrEqual(Math.min(cap, after + REFRESH_TOKEN_TTL_SECONDS * 1000));
  });
});

describe('consumeRefreshToken — single use, family rotation', () => {
  const familyIssuedAt = new Date(Date.now() - DAY);
  const row = {
    userId: 'u-1', workspaceId: 'ws-1', grantId: null, scope: 'mcp', clientId: 'c_1',
    expiresAt: new Date(Date.now() + 60_000), familyId: 'fam-1', familyIssuedAt,
  };

  it('spends the token with one conditional UPDATE keyed on hash + client + not revoked, not a read first', async () => {
    returningRows = [row];
    const result = await consumeRefreshToken({ token: 't-1', clientId: 'c_1' });
    expect(result).toEqual({
      userId: 'u-1', workspaceId: 'ws-1', scope: 'mcp',
      family: { familyId: 'fam-1', familyIssuedAt },
    });
    expect(selects).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].set?.revokedAt).toBeInstanceOf(Date);
    const q = dialect.sqlToQuery(updates[0].where);
    expect(q.sql).toContain('"revoked_at" is null');
    expect(q.sql).toContain('"token" = ');
    expect(q.sql).toContain('"client_id" = ');
    expect(q.params).toContain(hashRefreshToken('t-1'));
    expect(q.params).not.toContain('t-1');
    expect(q.params).toContain('c_1');
  });

  it('a token that was not spent (already rotated, unknown or another client) is invalid_grant and revokes only its own family', async () => {
    returningRows = [];
    expect(await consumeRefreshToken({ token: 't-1', clientId: 'c_1' })).toEqual({ error: 'invalid_grant' });
    expect(updates).toHaveLength(2);
    expect(updates[1].set?.revokedAt).toBeInstanceOf(Date);
    const q = dialect.sqlToQuery(updates[1].where);
    // Every live token of the family the presented, already-revoked token
    // belongs to, for the same client only.
    expect(q.sql).toContain('"family_id" in (select');
    expect(q.sql).toContain('revoked_at is not null');
    expect(q.sql).toContain('client_id = ');
    expect(q.sql).toContain('"revoked_at" is null');
    expect(q.params).toContain(hashRefreshToken('t-1'));
    expect(q.params).toContain('c_1');
  });

  it('rejects an expired token', async () => {
    returningRows = [{ ...row, expiresAt: new Date(Date.now() - 1000) }];
    expect(await consumeRefreshToken({ token: 't-1', clientId: 'c_1' })).toEqual({ error: 'invalid_grant' });
  });

  it('rejects a family past its absolute lifetime even when the token itself has not expired', async () => {
    returningRows = [{
      ...row,
      familyIssuedAt: new Date(Date.now() - REFRESH_TOKEN_ABSOLUTE_LIFETIME_SECONDS * 1000 - 1000),
      expiresAt: new Date(Date.now() + DAY),
    }];
    expect(await consumeRefreshToken({ token: 't-1', clientId: 'c_1' })).toEqual({ error: 'invalid_grant' });
  });

  it('still refuses a returned row for another client (defence in depth)', async () => {
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
