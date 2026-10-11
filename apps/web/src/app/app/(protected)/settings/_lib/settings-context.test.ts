/**
 * Every settings section reads the active team from loadSettingsContext, and
 * the shell, Home, chat availability and the chat API read it from
 * resolveActiveTeamId / resolveActiveTeamScope. They must agree.
 *
 * Regression: with no `buildd-team` cookie, settings took the first team by
 * join date while the shell took pickDefaultTeam's choice (the first team with
 * workspaces). A person on three teams whose personal team came first saw the
 * header, and chat, on one team while AI features and Model providers switched
 * chat on for another. Fixture names are illustrative.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const TEAMS = [
  { id: 'team-personal', name: 'Personal', slug: 'personal-user-1', role: 'owner', memberCount: 1 },
  { id: 'team-acme', name: 'Acme', slug: 'acme', role: 'owner', memberCount: 3 },
  { id: 'team-beta', name: 'Beta', slug: 'beta', role: 'member', memberCount: 2 },
  { id: 'team-gamma', name: 'Gamma', slug: 'gamma', role: 'admin', memberCount: 4 },
];

let cookie: string | undefined;
let active: string | null = 'team-acme';
const activeCalls: Array<[string, string | null | undefined]> = [];

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => ({ id: 'user-1', email: 'a@example.com' }) }));
mock.module('next/headers', () => ({ cookies: async () => ({ get: (n: string) => (n === 'buildd-team' && cookie ? { value: cookie } : undefined) }) }));
mock.module('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));
let accountRows: any[] = [];
let accountQuery: any = null;
mock.module('@buildd/core/db', () => ({ db: { query: { teams: { findFirst: async () => null }, workspaces: { findMany: async () => [] }, accounts: { findMany: async (q: any) => { accountQuery = q; return accountRows; } } } } }));
mock.module('@/lib/team-access', () => ({
  getUserTeamsWithDetails: async () => TEAMS,
  getUserWorkspaceIds: async () => [],
  resolveActiveTeamId: async (userId: string, c: string | null | undefined) => { activeCalls.push([userId, c]); return active; },
}));

const { loadSettingsContext, loadRunnerAccounts, RUNNER_ACCOUNT_COLUMNS } = await import('./settings-context');

beforeEach(() => {
  cookie = undefined;
  active = 'team-acme';
  activeCalls.length = 0;
});

describe('loadSettingsContext — active team', () => {
  it('uses the shared active-team resolver when the first team is not the active one', async () => {
    const ctx = await loadSettingsContext();
    expect(ctx.currentTeamId).toBe('team-acme');
    expect(ctx.currentTeam?.name).toBe('Acme');
    expect(ctx.perms.manage_team_settings).toBe(true);
    expect(activeCalls).toEqual([['user-1', undefined]]);
  });

  it('passes the cookie through, so a chosen team wins', async () => {
    cookie = 'team-beta';
    active = 'team-beta';
    const ctx = await loadSettingsContext();
    expect(activeCalls).toEqual([['user-1', 'team-beta']]);
    expect(ctx.currentTeamId).toBe('team-beta');
    expect(ctx.perms.manage_team_settings).toBe(false);
  });

  it('has no active team when the user has none', async () => {
    active = null;
    const ctx = await loadSettingsContext();
    expect(ctx.currentTeamId).toBeNull();
    expect(ctx.currentTeam).toBeNull();
    expect(Object.values(ctx.perms).every((v) => v === false)).toBe(true);
  });
});

/**
 * Every settings page draws its controls from `perms` / `permsByTeam`, so the
 * flags must be the server's answer: the person's role in the team
 * (permissions.ts `can`), a personal team counting as owned.
 */
describe('loadSettingsContext — permission flags', () => {
  // The flags each settings page reads, by page.
  const PAGE_FLAGS = [
    'manage_inference_providers', // providers, profile
    'manage_team_settings', // AI features, budgets caps, provider routing
    'manage_chat_retro', // AI features
    'view_team_usage', // budgets
    'manage_connectors', // MCP connectors
    'manage_team_notifications', // notifications
    'create_workspace', // workspaces
    'manage_team_credentials', // runners, Vercel
    'manage_team_model_keys', // Cloudflare
    'manage_team_keys', // runners host-runner toggle
  ] as const;

  it('an admin holds every page flag; a member holds none', async () => {
    const admin = await loadSettingsContext();
    for (const p of PAGE_FLAGS) expect([p, admin.perms[p]]).toEqual([p, true]);
    cookie = 'team-beta';
    active = 'team-beta';
    const member = await loadSettingsContext();
    for (const p of PAGE_FLAGS) expect([p, member.perms[p]]).toEqual([p, false]);
  });

  it('flags for every team, keyed by id', async () => {
    const ctx = await loadSettingsContext();
    expect(Object.keys(ctx.permsByTeam).sort()).toEqual(['team-acme', 'team-beta', 'team-gamma', 'team-personal']);
    expect(ctx.permsByTeam['team-personal'].create_workspace).toBe(true);
    expect(ctx.permsByTeam['team-beta'].create_workspace).toBe(false);
  });
});

describe('loadRunnerAccounts: only the fields the runner tokens section renders', () => {
  // A full accounts row as the DB would return it without a column list.
  const fullRow = {
    id: 'acc-1', type: 'service', level: 'worker', name: 'ci-runner', apiKey: 'hash-value-example', apiKeyPrefix: 'bld_ab12',
    githubId: 'gh-1', authType: 'oauth', maxCostPerDay: '10.00', totalCost: '1.23', oauthToken: 'legacy-token-example', seatId: 'seat-1',
    maxConcurrentSessions: 2, activeSessions: 1, budgetExhaustedAt: null, budgetResetsAt: null, monthlyBudgetUsd: '100',
    monthlyCostUsd: '5', monthlyCostMonth: '2026-01', budgetAlertsSent: [50], aiDailyBudgetUsd: '3', maxConcurrentWorkers: 3,
    totalTasks: 9, createdAt: new Date('2026-01-01'), teamId: 'team-acme', hostRunner: true,
    team: { name: 'Acme' }, accountWorkspaces: [{ workspaceId: 'ws-1' }],
  };

  it('the DTO carries no key hash, legacy token or budget internals', async () => {
    accountRows = [fullRow];
    const [dto] = await loadRunnerAccounts(['team-acme']);
    expect(Object.keys(dto).sort()).toEqual([
      'accountWorkspaces', 'activeSessions', 'apiKeyPrefix', 'authType', 'budgetExhaustedAt', 'budgetResetsAt', 'createdAt',
      // Read so the page can offer Delete on your own key; the page strips it before the client.
      'createdByUserId', 'hostRunner', 'id', 'maxConcurrentSessions', 'maxConcurrentWorkers', 'name', 'team', 'teamId', 'totalCost', 'type',
    ]);
    for (const k of ['apiKey', 'apiKeyHash', 'oauthToken', 'hasOauthToken', 'seatId', 'githubId', 'maxCostPerDay', 'monthlyBudgetUsd', 'monthlyCostUsd', 'budgetAlertsSent', 'aiDailyBudgetUsd']) {
      expect(k in dto).toBe(false);
    }
    const json = JSON.stringify(dto);
    expect(json).not.toContain('hash-value-example');
    expect(json).not.toContain('legacy-token-example');
    expect(dto).toMatchObject({ id: 'acc-1', name: 'ci-runner', apiKeyPrefix: 'bld_ab12', hostRunner: true, teamId: 'team-acme', team: { name: 'Acme' }, accountWorkspaces: [{ workspaceId: 'ws-1' }] });
  });

  it('asks the DB for only those columns', async () => {
    accountRows = [];
    await loadRunnerAccounts(['team-acme']);
    expect(accountQuery.columns).toEqual(RUNNER_ACCOUNT_COLUMNS);
    for (const k of ['apiKey', 'oauthToken', 'seatId', 'monthlyBudgetUsd']) expect(k in accountQuery.columns).toBe(false);
  });

  it('no teams: no query', async () => {
    accountQuery = null;
    expect(await loadRunnerAccounts([])).toEqual([]);
    expect(accountQuery).toBeNull();
  });
});
