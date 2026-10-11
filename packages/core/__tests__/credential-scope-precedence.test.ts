import { describe, it, expect } from 'bun:test';
import { credentialScopeRank, pickMostSpecificCredential } from '../secrets/team-scope';

// docs/credentials-architecture.md → "Scoping precedence (most specific wins)":
// workspace > account > team-wide. Recency only breaks a tie WITHIN a scope —
// a newer team-wide row must never shadow an older workspace row.

const target = { accountId: 'acct-a', workspaceId: 'ws-w' };
const at = (iso: string) => new Date(iso);

function row(id: string, extra: Partial<{
  accountId: string | null; workspaceId: string | null; userId: string | null;
  healthStatus: string | null; updatedAt: Date | null;
}> = {}) {
  return {
    id, accountId: null, workspaceId: null, userId: null,
    healthStatus: 'healthy', updatedAt: at('2026-09-01T00:00:00Z'), ...extra,
  };
}

describe('credentialScopeRank', () => {
  it('ranks workspace above account above team-wide', () => {
    expect(credentialScopeRank(row('t'), target)).toBe(0);
    expect(credentialScopeRank(row('a', { accountId: 'acct-a' }), target)).toBe(1);
    expect(credentialScopeRank(row('w', { workspaceId: 'ws-w' }), target)).toBe(2);
    expect(credentialScopeRank(row('aw', { accountId: 'acct-a', workspaceId: 'ws-w' }), target)).toBe(3);
  });

  it('marks rows for another scope or another person as not applicable', () => {
    expect(credentialScopeRank(row('x', { workspaceId: 'ws-other' }), target)).toBe(-1);
    expect(credentialScopeRank(row('x', { accountId: 'acct-other' }), target)).toBe(-1);
    expect(credentialScopeRank(row('x', { userId: 'user-1' }), target)).toBe(-1);
    // No target account: an account-scoped row belongs to someone else.
    expect(credentialScopeRank(row('x', { accountId: 'acct-a' }), { workspaceId: 'ws-w' })).toBe(-1);
  });
});

describe('pickMostSpecificCredential', () => {
  it('a newer team-wide row does not beat an older workspace row', () => {
    const picked = pickMostSpecificCredential([
      row('team-new', { updatedAt: at('2026-09-05T00:00:00Z') }),
      row('ws-old', { workspaceId: 'ws-w', updatedAt: at('2026-09-01T00:00:00Z') }),
    ], target);
    expect(picked?.id).toBe('ws-old');
  });

  it('an account row beats a newer team-wide row', () => {
    const picked = pickMostSpecificCredential([
      row('team-new', { updatedAt: at('2026-09-05T00:00:00Z') }),
      row('acct-old', { accountId: 'acct-a', updatedAt: at('2026-09-01T00:00:00Z') }),
    ], target);
    expect(picked?.id).toBe('acct-old');
  });

  it('a workspace row beats a newer account row', () => {
    const picked = pickMostSpecificCredential([
      row('acct-new', { accountId: 'acct-a', updatedAt: at('2026-09-05T00:00:00Z') }),
      row('ws-old', { workspaceId: 'ws-w', updatedAt: at('2026-09-01T00:00:00Z') }),
    ], target);
    expect(picked?.id).toBe('ws-old');
  });

  it('never picks a personal row, even the most specific and newest one', () => {
    const picked = pickMostSpecificCredential([
      row('personal', { userId: 'user-1', workspaceId: 'ws-w', updatedAt: at('2026-09-09T00:00:00Z') }),
      row('team'),
    ], target);
    expect(picked?.id).toBe('team');
    expect(pickMostSpecificCredential([row('personal', { userId: 'user-1' })], target)).toBeUndefined();
  });

  it('never picks a row scoped to another workspace or account', () => {
    expect(pickMostSpecificCredential([
      row('other-ws', { workspaceId: 'ws-other' }),
      row('other-acct', { accountId: 'acct-other' }),
    ], target)).toBeUndefined();
  });

  it('within one scope, the newest row wins', () => {
    const picked = pickMostSpecificCredential([
      row('old', { updatedAt: at('2026-09-01T00:00:00Z') }),
      row('new', { updatedAt: at('2026-09-03T00:00:00Z') }),
    ], target);
    expect(picked?.id).toBe('new');
  });

  // A revoked leftover must not shadow a live credential, whatever its scope:
  // that is the bug that once handed workers a dead token while a fresh one sat
  // unused. A revoked row is still returned when it is the only candidate.
  it('a live row beats a revoked more-specific row; a lone revoked row is still returned', () => {
    const picked = pickMostSpecificCredential([
      row('ws-revoked', { workspaceId: 'ws-w', healthStatus: 'revoked' }),
      row('team-live'),
    ], target);
    expect(picked?.id).toBe('team-live');
    expect(pickMostSpecificCredential([row('only', { healthStatus: 'revoked' })], target)?.id).toBe('only');
  });
});
