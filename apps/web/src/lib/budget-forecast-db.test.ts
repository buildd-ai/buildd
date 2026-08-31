/**
 * Tests for getBudgetForecast mission filtering behaviour.
 * Verifies the two bugs fixed in this PR:
 *   Bug 1 — completed/archived missions are excluded (ACTIVE_MISSION_STATUSES filter)
 *   Bug 2 — team-level missions (workspaceId IS NULL) are included when teamId matches
 *
 * All DB access is mocked. The application-level guards in the mission loop
 * are what these tests exercise; the SQL WHERE clause is the primary filter in
 * production, but the guards keep behaviour correct regardless of query shape.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ── Mock helpers ──────────────────────────────────────────────────────────────

const mockTeamsFindFirst = mock(() => Promise.resolve(null));
const mockAccountsFindMany = mock(() => Promise.resolve([]));
const mockMissionsFindMany = mock(() => Promise.resolve([]));
const mockTenantBudgetsFindFirst = mock(() => Promise.resolve(null));

// Builder chain for db.select().from().where() and db.select().from().innerJoin().where()
const mockInnerJoinChain = {
  where: mock(() => Promise.resolve([{ spend: '0' }])),
};
const mockFromChain = {
  where: mock(() => Promise.resolve([])),
  innerJoin: mock(() => mockInnerJoinChain),
};
const mockDbSelect = mock(() => ({ from: mock(() => mockFromChain) }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      teams: { findFirst: mockTeamsFindFirst },
      accounts: { findMany: mockAccountsFindMany },
      missions: { findMany: mockMissionsFindMany },
      tenantBudgets: { findFirst: mockTenantBudgetsFindFirst },
    },
    select: mockDbSelect,
  },
}));

mock.module('drizzle-orm', () => ({
  and: (...args: any[]) => ({ type: 'and', args }),
  or: (...args: any[]) => ({ type: 'or', args }),
  eq: (f: any, v: any) => ({ type: 'eq', f, v }),
  gte: (f: any, v: any) => ({ type: 'gte', f, v }),
  inArray: (f: any, v: any) => ({ type: 'inArray', f, v }),
  isNotNull: (f: any) => ({ type: 'isNotNull', f }),
  isNull: (f: any) => ({ type: 'isNull', f }),
  desc: (f: any) => ({ type: 'desc', f }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: any[]) => ({ type: 'sql', strings: [...strings], vals }),
    {},
  ),
}));

mock.module('@buildd/core/db/schema', () => ({
  missions: {
    id: 'missions.id', title: 'missions.title',
    workspaceId: 'missions.workspaceId', teamId: 'missions.teamId',
    status: 'missions.status', costBudgetUsd: 'missions.costBudgetUsd',
  },
  workers: {
    costUsd: 'workers.costUsd', workspaceId: 'workers.workspaceId',
    createdAt: 'workers.createdAt', taskId: 'workers.taskId',
  },
  tasks: { id: 'tasks.id', missionId: 'tasks.missionId' },
  teams: {
    id: 'teams.id', monthlyBudgetUsd: 'teams.monthlyBudgetUsd',
    monthlyCostUsd: 'teams.monthlyCostUsd', monthlyCostMonth: 'teams.monthlyCostMonth',
  },
  accounts: {
    teamId: 'accounts.teamId', authType: 'accounts.authType',
    id: 'accounts.id', name: 'accounts.name', seatId: 'accounts.seatId',
    budgetResetsAt: 'accounts.budgetResetsAt',
  },
  tenantBudgets: {
    teamId: 'tenantBudgets.teamId', updatedAt: 'tenantBudgets.updatedAt',
    budgetExhaustedAt: 'tenantBudgets.budgetExhaustedAt', budgetResetsAt: 'tenantBudgets.budgetResetsAt',
  },
  oauthBudgetEpisodes: {},
}));

mock.module('@buildd/core/oauth-budget', () => ({
  learnOauthCapacity: mock(() => ({ confidence: 'none', samples: 0 })),
  oauthBudgetPressure: mock(() => ({ pct: 0, limiter: null })),
  windowEndsAt: mock(() => new Date('2026-09-01T00:00:00Z')),
  readPacingConfig: mock(() => ({ quantile: 0.9 })),
}));

mock.module('@/lib/oauth-budget-window', () => ({
  loadOauthEpisodes: mock(() => Promise.resolve([])),
  measureOauthWindow: mock(() => Promise.resolve({ windowStartedAt: new Date(), usage: 0 })),
}));

// Import AFTER all mocks
import { getBudgetForecast } from './budget-forecast';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEAM_ID = 'team-abc';
const WS_ID = 'ws-xyz';

function makeMission(overrides: Partial<{
  id: string;
  title: string;
  costBudgetUsd: string;
  status: string;
  teamId: string;
  workspaceId: string | null;
}>) {
  return {
    id: 'mission-1',
    title: 'Test Mission',
    costBudgetUsd: '100.00',
    status: 'active',
    teamId: TEAM_ID,
    workspaceId: WS_ID,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getBudgetForecast — mission status filtering', () => {
  beforeEach(() => {
    mockMissionsFindMany.mockReset();
    mockInnerJoinChain.where.mockReset();
    mockInnerJoinChain.where.mockImplementation(() => Promise.resolve([{ spend: '5.00' }]));
  });

  it('excludes a mission with status completed', async () => {
    mockMissionsFindMany.mockImplementation(() =>
      Promise.resolve([makeMission({ status: 'completed' })]),
    );
    const forecast = await getBudgetForecast(TEAM_ID, [WS_ID]);
    expect(forecast.missions).toHaveLength(0);
  });

  it('excludes a mission with status archived', async () => {
    mockMissionsFindMany.mockImplementation(() =>
      Promise.resolve([makeMission({ status: 'archived' })]),
    );
    const forecast = await getBudgetForecast(TEAM_ID, [WS_ID]);
    expect(forecast.missions).toHaveLength(0);
  });

  it('includes a mission with status active', async () => {
    mockMissionsFindMany.mockImplementation(() =>
      Promise.resolve([makeMission({ status: 'active' })]),
    );
    const forecast = await getBudgetForecast(TEAM_ID, [WS_ID]);
    expect(forecast.missions).toHaveLength(1);
    expect(forecast.missions[0].missionId).toBe('mission-1');
  });

  it('includes a mission with status paused', async () => {
    mockMissionsFindMany.mockImplementation(() =>
      Promise.resolve([makeMission({ status: 'paused' })]),
    );
    const forecast = await getBudgetForecast(TEAM_ID, [WS_ID]);
    expect(forecast.missions).toHaveLength(1);
  });

  it('includes a mission with status budget_exhausted', async () => {
    mockMissionsFindMany.mockImplementation(() =>
      Promise.resolve([makeMission({ status: 'budget_exhausted' })]),
    );
    const forecast = await getBudgetForecast(TEAM_ID, [WS_ID]);
    expect(forecast.missions).toHaveLength(1);
  });
});

describe('getBudgetForecast — team-level (null workspaceId) mission filtering', () => {
  beforeEach(() => {
    mockMissionsFindMany.mockReset();
    mockInnerJoinChain.where.mockReset();
    mockInnerJoinChain.where.mockImplementation(() => Promise.resolve([{ spend: '0' }]));
  });

  it('includes a mission with workspaceId IS NULL on the caller team', async () => {
    mockMissionsFindMany.mockImplementation(() =>
      Promise.resolve([makeMission({ workspaceId: null, teamId: TEAM_ID })]),
    );
    const forecast = await getBudgetForecast(TEAM_ID, [WS_ID]);
    expect(forecast.missions).toHaveLength(1);
    expect(forecast.missions[0].missionId).toBe('mission-1');
  });

  it('excludes a mission with workspaceId IS NULL on a different team', async () => {
    mockMissionsFindMany.mockImplementation(() =>
      Promise.resolve([makeMission({ workspaceId: null, teamId: 'team-other' })]),
    );
    const forecast = await getBudgetForecast(TEAM_ID, [WS_ID]);
    expect(forecast.missions).toHaveLength(0);
  });

  it('includes workspace-scoped missions unchanged', async () => {
    mockMissionsFindMany.mockImplementation(() =>
      Promise.resolve([makeMission({ workspaceId: WS_ID, teamId: TEAM_ID })]),
    );
    const forecast = await getBudgetForecast(TEAM_ID, [WS_ID]);
    expect(forecast.missions).toHaveLength(1);
  });
});
