import { describe, it, expect, mock } from 'bun:test';

// Mock DB dependencies BEFORE dynamic-importing the module under test.
// Static `import` is hoisted so we must use dynamic import for the module
// that transitively depends on @buildd/core/db.
mock.module('@buildd/core/db', () => ({ db: {} }));
mock.module('@buildd/core/db/schema', () => ({
  accounts: Symbol('accounts'),
  accountWorkspaces: Symbol('accountWorkspaces'),
  workerHeartbeats: Symbol('workerHeartbeats'),
  workers: Symbol('workers'),
}));
mock.module('drizzle-orm', () => ({
  and: (...a: any[]) => a,
  desc: (c: any) => c,
  eq: (a: any, b: any) => ({ a, b }),
  gt: (a: any, b: any) => ({ a, b }),
  inArray: (a: any, b: any) => ({ a, b }),
}));

const { isRunnerOnline, isPushOnlyRunner, selectRelevantRunnerAccounts } = await import('./runner-heartbeats');

describe('selectRelevantRunnerAccounts', () => {
  const TEAM = 'team-a';
  const OTHER_TEAM = 'team-b';

  function relevance(
    candidates: { accountId: string; accountTeamId: string | null }[],
    opts: Partial<{ linkedAccountIds: Set<string>; workedAccountIds: Set<string> }> = {},
  ) {
    return selectRelevantRunnerAccounts(candidates, {
      teamId: TEAM,
      linkedAccountIds: opts.linkedAccountIds ?? new Set<string>(),
      workedAccountIds: opts.workedAccountIds ?? new Set<string>(),
    });
  }

  it('includes accounts that belong to the team', () => {
    const result = relevance([{ accountId: 'acc-1', accountTeamId: TEAM }]);
    expect(result.has('acc-1')).toBe(true);
  });

  it('includes accounts from another team that are linked to a scoped workspace', () => {
    const result = relevance(
      [{ accountId: 'acc-1', accountTeamId: OTHER_TEAM }],
      { linkedAccountIds: new Set(['acc-1']) },
    );
    expect(result.has('acc-1')).toBe(true);
  });

  it('includes accounts from another team that have worked in a scoped workspace', () => {
    // The real-world case: a runner account created under a personal team,
    // claiming via open-access workspaces — no team match, no explicit link.
    const result = relevance(
      [{ accountId: 'acc-1', accountTeamId: OTHER_TEAM }],
      { workedAccountIds: new Set(['acc-1']) },
    );
    expect(result.has('acc-1')).toBe(true);
  });

  it('excludes unrelated accounts even though open workspaces are claimable by anyone', () => {
    // A stranger's runner could claim in an open workspace, but has never
    // worked here and isn't linked — it must not appear on this team's Health.
    const result = relevance([{ accountId: 'stranger', accountTeamId: OTHER_TEAM }]);
    expect(result.size).toBe(0);
  });

  it('excludes accounts with no team when they have no link or work history', () => {
    const result = relevance([{ accountId: 'acc-1', accountTeamId: null }]);
    expect(result.size).toBe(0);
  });

  it('handles a mixed candidate list', () => {
    const result = relevance(
      [
        { accountId: 'team-member', accountTeamId: TEAM },
        { accountId: 'linked', accountTeamId: OTHER_TEAM },
        { accountId: 'worked', accountTeamId: null },
        { accountId: 'stranger', accountTeamId: OTHER_TEAM },
      ],
      { linkedAccountIds: new Set(['linked']), workedAccountIds: new Set(['worked']) },
    );
    expect([...result].sort()).toEqual(['linked', 'team-member', 'worked']);
  });
});

describe('isPushOnlyRunner', () => {
  it('returns true for headless:// sentinel URLs', () => {
    expect(isPushOnlyRunner('headless://my-coder-workspace')).toBe(true);
    expect(isPushOnlyRunner('headless://hostname.local')).toBe(true);
  });

  it('returns false for http:// URLs (debug mode with HTTP server)', () => {
    expect(isPushOnlyRunner('http://localhost:8766')).toBe(false);
    expect(isPushOnlyRunner('http://100.64.0.1:8766')).toBe(false);
  });

  it('returns false for https:// URLs (Tailscale or custom)', () => {
    expect(isPushOnlyRunner('https://runner.example.com')).toBe(false);
  });

  it('returns false for empty string (degenerate case)', () => {
    expect(isPushOnlyRunner('')).toBe(false);
  });
});

describe('isRunnerOnline', () => {
  it('returns true when last heartbeat was under 2 minutes ago', () => {
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    expect(isRunnerOnline(recent)).toBe(true);
  });

  it('returns true at just under 2 minutes', () => {
    const boundary = new Date(Date.now() - 119 * 1000).toISOString();
    expect(isRunnerOnline(boundary)).toBe(true);
  });

  it('returns false when last heartbeat was over 2 minutes ago', () => {
    const stale = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    expect(isRunnerOnline(stale)).toBe(false);
  });

  it('returns false for an old heartbeat', () => {
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(isRunnerOnline(old)).toBe(false);
  });

  it('accepts a Date object as well as an ISO string', () => {
    expect(isRunnerOnline(new Date(Date.now() - 30 * 1000))).toBe(true);
    expect(isRunnerOnline(new Date(Date.now() - 5 * 60 * 1000))).toBe(false);
  });
});
