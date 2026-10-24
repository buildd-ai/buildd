/**
 * The per-team cache (lib/team-cache.ts) and the four reads on it: the team's
 * plan, a workspace's settings row, the runner list and the questions
 * waiting. Each: a hit makes no database query, the write's clear ends the
 * entry, and Redis down goes to the database every time. Illustrative ids.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createFakeRedis } from './caller-cache.fixtures';

const redis = createFakeRedis();
mock.module('./redis', () => redis.module);

const queries: string[] = [];
let planRow: { plan: string } | null = { plan: 'pro' };
let wsRow: Record<string, unknown> | null = null;
let accountRows: Array<Record<string, unknown>> = [];
let waitingRows: Array<Record<string, unknown>> = [];
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teams: { findFirst: async () => { queries.push('teams'); return planRow; } },
      workspaces: { findFirst: async () => { queries.push('workspaces'); return wsRow; } },
      accounts: { findMany: async () => { queries.push('accounts'); return accountRows; } },
    },
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: async () => { queries.push('workers'); return waitingRows; } }),
        }),
      }),
    }),
  },
}));

let teamsOf: Record<string, string[]> = {};
mock.module('./team-access', () => ({
  getUserTeamIds: async (userId: string) => { queries.push('memberships'); return teamsOf[userId] ?? []; },
  userWorkspaceScope: () => undefined,
  getUserWorkspaceIds: async () => [],
  getUserTeamsWithDetails: async () => [],
  resolveActiveTeamId: async () => null,
}));
mock.module('./incident-recovery-load', () => ({ loadSupersededQuestionTaskIds: async () => new Set<string>() }));
mock.module('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
mock.module('next/navigation', () => ({ redirect: () => { throw new Error('redirect'); } }));
mock.module('./auth-helpers', () => ({ getCurrentUser: async () => null }));

const { cachedTeamRead, clearTeamCache, clearWorkspaceSettingsCache, TEAM_CACHE_MAX_TTL_SEC } = await import('./team-cache');
const { clearCallerCache, callerDep } = await import('./caller-cache');
const { teamPlan } = await import('./request-tenant');
const { loadWorkspaceSettings } = await import('./workspace-settings');
const { loadRunnerAccounts } = await import('../app/app/(protected)/settings/_lib/settings-context');
const { loadWaitingInput, clearWaitingInputCache } = await import('./waiting-input');

const TEAM = 'team-1';
const OTHER = 'team-2';
const WS = 'ws-1';

const count = (kind: string) => queries.filter(q => q === kind).length;

beforeEach(() => {
  redis.reset();
  queries.length = 0;
  planRow = { plan: 'pro' };
  wsRow = {
    id: WS, name: 'Web', repo: 'acme/web', teamId: TEAM, gitConfig: { executor: 'any' }, configStatus: 'admin_confirmed',
    accessMode: 'restricted', releaseConfig: null, workTrackerConfig: null,
    webhookConfig: { url: 'https://hooks.example.test/x', token: 'whsec_must_not_be_cached', enabled: true, events: ['task.created'] },
    newStartsPausedUntil: new Date('2030-01-01T00:00:00Z'),
  };
  accountRows = [{
    id: 'acct-1', name: 'laptop', type: 'user', authType: 'api', apiKeyPrefix: 'bld_ab', maxConcurrentWorkers: 2,
    totalCost: '0', activeSessions: 0, maxConcurrentSessions: null, budgetExhaustedAt: null, budgetResetsAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), hostRunner: false, teamId: TEAM, createdByUserId: 'user-a',
    team: { name: 'Acme' }, accountWorkspaces: [{ workspaceId: WS }],
  }];
  waitingRows = [{ taskId: 'task-1', waitingFor: { type: 'question', prompt: 'Which plan?', disposition: 'ask' }, title: 'Pick', status: 'in_progress', workspaceId: WS, missionId: null }];
  teamsOf = { 'user-a': [TEAM], 'user-b': [TEAM] };
  clearWaitingInputCache();
});

describe('cachedTeamRead', () => {
  it('stores for at most 30 s', async () => {
    await cachedTeamRead(TEAM, 'plan', async () => 'pro', { ttlSec: 600 });
    const ttls = [...redis.ttls].filter(([k]) => k.startsWith('buildd:caller:team:')).map(([, t]) => t);
    expect(TEAM_CACHE_MAX_TTL_SEC).toBe(30);
    expect(ttls).toEqual([30]);
  });

  it('a whole-team clear ends every kind; a kind clear ends only that kind', async () => {
    const plan = mock(async () => 'pro');
    const runners = mock(async () => ['r']);
    const read = () => Promise.all([cachedTeamRead(TEAM, 'plan', plan), cachedTeamRead(TEAM, 'runners', runners)]);
    await read();
    await clearTeamCache(TEAM, 'runners');
    await read();
    expect(plan).toHaveBeenCalledTimes(1);
    expect(runners).toHaveBeenCalledTimes(2);
    await clearTeamCache(TEAM);
    await read();
    expect(plan).toHaveBeenCalledTimes(2);
    expect(runners).toHaveBeenCalledTimes(3);
  });

  it('one team\'s clear leaves another team\'s entries alone', async () => {
    const load = mock(async () => 'pro');
    await cachedTeamRead(OTHER, 'plan', load);
    await clearTeamCache(TEAM);
    await cachedTeamRead(OTHER, 'plan', load);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('the team plan (request-tenant teamPlan)', () => {
  it('a hit makes no query', async () => {
    for (let i = 0; i < 20; i++) expect(await teamPlan(TEAM)).toBe('pro');
    expect(count('teams')).toBe(1);
  });

  it('the plan write\'s clear is seen on the next call', async () => {
    expect(await teamPlan(TEAM)).toBe('pro');
    planRow = { plan: 'team' };
    expect(await teamPlan(TEAM)).toBe('pro');
    await clearTeamCache(TEAM, 'plan');
    expect(await teamPlan(TEAM)).toBe('team');
  });

  it('Redis down: every call reads the database', async () => {
    redis.state.down = true;
    await teamPlan(TEAM);
    await teamPlan(TEAM);
    expect(count('teams')).toBe(2);
  });

  it('no Redis at all: held in process for at most the team TTL', async () => {
    redis.state.configured = false;
    const t0 = Date.now();
    const realNow = Date.now;
    try {
      for (let i = 0; i < 5; i++) expect(await teamPlan(OTHER)).toBe('pro');
      expect(count('teams')).toBe(1);
      Date.now = () => t0 + TEAM_CACHE_MAX_TTL_SEC * 1000 + 1_000;
      await teamPlan(OTHER);
      expect(count('teams')).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('workspace settings (lib/workspace-settings.ts)', () => {
  it('a hit makes no query, and the cached row reads the same as the database row', async () => {
    const cold = await loadWorkspaceSettings(TEAM, WS);
    const warm = await loadWorkspaceSettings(TEAM, WS);
    expect(count('workspaces')).toBe(1);
    expect(warm?.name).toBe('Web');
    expect(new Date(warm!.newStartsPausedUntil!).toISOString()).toBe(new Date(cold!.newStartsPausedUntil!).toISOString());
  });

  it('never holds the dispatch webhook token, in memory or in Redis', async () => {
    const row = await loadWorkspaceSettings(TEAM, WS);
    expect(row?.webhookConfig).toEqual({ enabled: true, events: ['task.created'] });
    expect(JSON.stringify([...redis.store.values()])).not.toContain('whsec_must_not_be_cached');
  });

  it('a workspace write\'s clear (by workspace id, no team needed) is seen on the next call', async () => {
    await loadWorkspaceSettings(TEAM, WS);
    wsRow = { ...wsRow!, name: 'Web app' };
    await clearWorkspaceSettingsCache(WS);
    expect((await loadWorkspaceSettings(TEAM, WS))?.name).toBe('Web app');
    expect(count('workspaces')).toBe(2);
  });

  it('a missing row is not cached', async () => {
    wsRow = null;
    expect(await loadWorkspaceSettings(TEAM, WS)).toBeNull();
    expect(await loadWorkspaceSettings(TEAM, WS)).toBeNull();
    expect(count('workspaces')).toBe(2);
  });

  it('Redis down: every call reads the database', async () => {
    redis.state.down = true;
    await loadWorkspaceSettings(TEAM, WS);
    await loadWorkspaceSettings(TEAM, WS);
    expect(count('workspaces')).toBe(2);
  });
});

describe('the runner list (settings-context loadRunnerAccounts)', () => {
  it('a hit makes no query', async () => {
    const cold = await loadRunnerAccounts([TEAM]);
    const warm = await loadRunnerAccounts([TEAM]);
    expect(count('accounts')).toBe(1);
    expect(warm.map(a => a.id)).toEqual(['acct-1']);
    expect(new Date(warm[0].createdAt!).getTime()).toBe(new Date(cold[0].createdAt!).getTime());
  });

  it('a runner write\'s clear is seen on the next call', async () => {
    await loadRunnerAccounts([TEAM]);
    accountRows = [{ ...accountRows[0], hostRunner: true }];
    await clearTeamCache(TEAM, 'runners');
    expect((await loadRunnerAccounts([TEAM]))[0].hostRunner).toBe(true);
  });

  it('a link change (invalidateAccountWorkspaceCache) ends the list too', async () => {
    await loadRunnerAccounts([TEAM]);
    accountRows = [{ ...accountRows[0], accountWorkspaces: [] }];
    await clearCallerCache(callerDep.accountLinks('acct-1'));
    expect((await loadRunnerAccounts([TEAM]))[0].accountWorkspaces).toEqual([]);
    expect(count('accounts')).toBe(2);
  });

  it('Redis down: every call reads the database', async () => {
    redis.state.down = true;
    await loadRunnerAccounts([TEAM]);
    await loadRunnerAccounts([TEAM]);
    expect(count('accounts')).toBe(2);
  });
});

describe('questions waiting (lib/waiting-input.ts loadWaitingInput)', () => {
  it('a hit makes no query, and another member of the team shares the entry', async () => {
    expect((await loadWaitingInput('user-a')).map(v => v.id)).toEqual(['task-1']);
    expect((await loadWaitingInput('user-a')).map(v => v.id)).toEqual(['task-1']);
    expect((await loadWaitingInput('user-b')).map(v => v.id)).toEqual(['task-1']);
    expect(count('workers')).toBe(1);
    // Each user's teams once, then cached with them.
    expect(count('memberships')).toBe(2);
  });

  it('a question write\'s clear is seen on the next call', async () => {
    await loadWaitingInput('user-a');
    waitingRows = [];
    await clearTeamCache(TEAM, 'questions');
    expect(await loadWaitingInput('user-a')).toEqual([]);
    expect(count('workers')).toBe(2);
  });

  it('fresh reads the database again and refills the entry', async () => {
    await loadWaitingInput('user-a');
    waitingRows = [];
    expect(await loadWaitingInput('user-a', { fresh: true })).toEqual([]);
    expect(await loadWaitingInput('user-b')).toEqual([]);
    expect(count('workers')).toBe(2);
  });

  it('a user in no team is not cached: a membership added is seen on the next call', async () => {
    teamsOf = { 'user-c': [] };
    expect(await loadWaitingInput('user-c')).toEqual([]);
    teamsOf = { 'user-c': [TEAM] };
    expect((await loadWaitingInput('user-c')).map(v => v.id)).toEqual(['task-1']);
  });

  it('Redis down: every call reads the database', async () => {
    redis.state.down = true;
    await loadWaitingInput('user-a');
    await loadWaitingInput('user-a');
    expect(count('workers')).toBe(2);
  });
});
