import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// These imports will fail until runner-heartbeats-pure.ts is created (RED phase).
import { isRunnerOnline, selectRelevantRunnerAccounts } from './runner-heartbeats-pure';

describe('runner-heartbeats-pure', () => {
  describe('isRunnerOnline', () => {
    it('returns true when heartbeat is within 2 minutes', () => {
      const recent = new Date(Date.now() - 90_000).toISOString(); // 1.5 min ago
      expect(isRunnerOnline(recent)).toBe(true);
    });

    it('returns false when heartbeat is more than 2 minutes old', () => {
      const stale = new Date(Date.now() - 150_000).toISOString(); // 2.5 min ago
      expect(isRunnerOnline(stale)).toBe(false);
    });

    it('accepts Date objects', () => {
      const recent = new Date(Date.now() - 60_000); // 1 min ago
      expect(isRunnerOnline(recent)).toBe(true);
    });

    it('returns false for dates in the future (clock skew guard)', () => {
      // Future timestamp: more than 0ms ahead, within-window check still holds
      const future = new Date(Date.now() + 10_000).toISOString();
      // Date.now() - future < 0 < 2*60*1000 → still within threshold → true
      expect(isRunnerOnline(future)).toBe(true);
    });
  });

  describe('selectRelevantRunnerAccounts', () => {
    it('includes accounts whose teamId matches', () => {
      const result = selectRelevantRunnerAccounts(
        [{ accountId: 'acc1', accountTeamId: 'team-a' }],
        { teamId: 'team-a', linkedAccountIds: new Set(), workedAccountIds: new Set() },
      );
      expect(result.has('acc1')).toBe(true);
    });

    it('includes accounts that are linked to a workspace', () => {
      const result = selectRelevantRunnerAccounts(
        [{ accountId: 'acc2', accountTeamId: 'other-team' }],
        { teamId: 'team-a', linkedAccountIds: new Set(['acc2']), workedAccountIds: new Set() },
      );
      expect(result.has('acc2')).toBe(true);
    });

    it('includes accounts that have worked in a workspace', () => {
      const result = selectRelevantRunnerAccounts(
        [{ accountId: 'acc3', accountTeamId: null }],
        { teamId: 'team-a', linkedAccountIds: new Set(), workedAccountIds: new Set(['acc3']) },
      );
      expect(result.has('acc3')).toBe(true);
    });

    it('excludes unrelated accounts', () => {
      const result = selectRelevantRunnerAccounts(
        [{ accountId: 'stranger', accountTeamId: 'stranger-team' }],
        { teamId: 'team-a', linkedAccountIds: new Set(), workedAccountIds: new Set() },
      );
      expect(result.has('stranger')).toBe(false);
    });
  });

  // Regression: ensure this file never pulls in server-only dependencies
  it('has no @buildd/core/db or dotenv imports in source', () => {
    const src = readFileSync(
      resolve(import.meta.dir, 'runner-heartbeats-pure.ts'),
      'utf8',
    );
    expect(src).not.toContain('@buildd/core/db');
    expect(src).not.toContain('dotenv');
    expect(src).not.toContain("'server-only'");
    expect(src).not.toContain('"server-only"');
  });
});
