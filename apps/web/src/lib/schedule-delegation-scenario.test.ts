/**
 * Regression: a weekly reviewer scheduled in one workspace (a private
 * knowledge workspace) judges decisions recorded in another workspace of the
 * same team. Its per-task token used to be refused every read it was created
 * to make (401/404) and could not file its own defect report.
 *
 * Real tokens, real authentication (lib/task-token-auth.ts) and the real
 * route handlers; only the database and the aggregate queries are stubbed.
 * The delegation lives on the schedule row; the test flips it to show each
 * read is opened by it and only by it.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TEAM = 'team-1';
const KB_WS = '00000000-0000-4000-8000-0000000000a1';      // where the schedule lives
const TARGET_WS = '00000000-0000-4000-8000-0000000000b2';  // the workspace under review
const SIBLING_WS = '00000000-0000-4000-8000-0000000000c3'; // same team, not granted
const FOREIGN_WS = '00000000-0000-4000-8000-0000000000d4'; // another team
const SCHEDULE = '00000000-0000-4000-8000-0000000000e5';
const REVIEW_TASK = '00000000-0000-4000-8000-0000000000f6';

const ACCOUNT = { id: 'acct-runner', teamId: TEAM, level: 'worker', apiKey: 'hash-runner', scopes: null, workspaceIds: null, expiresAt: null };
const WORKSPACES = [
  { id: KB_WS, teamId: TEAM }, { id: TARGET_WS, teamId: TEAM }, { id: SIBLING_WS, teamId: TEAM }, { id: FOREIGN_WS, teamId: 'team-2' },
];

let scheduleRow: { workspaceId: string; delegation: unknown } | null = null;
let taskRow: { workspaceId: string; scheduleId: string | null } = { workspaceId: KB_WS, scheduleId: SCHEDULE };

const ledger = mock(async (..._args: any[]) => ({ rows: [] as any[], outcomes: [] as any[], truncated: false }));
const decisionStats = mock(async (..._args: any[]) => ({ decisions: { total: 3 } }));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      accounts: { findFirst: async () => ACCOUNT },
      tasks: { findFirst: async () => taskRow },
      taskSchedules: { findFirst: async () => scheduleRow },
      workspaces: {
        findMany: async (args: { where: unknown }) => {
          // The auth loader narrows by id with a callback; the routes list the team.
          if (typeof args.where === 'function') {
            const ids = (args.where as any)({ id: 'id' }, { inArray: (_c: unknown, v: string[]) => v }) as string[];
            return WORKSPACES.filter(w => ids.includes(w.id));
          }
          return WORKSPACES.filter(w => w.teamId === TEAM);
        },
      },
    },
  },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => null }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: async () => null }));
mock.module('@/lib/team-access', () => ({
  resolveAccountTeamIds: async (_u: unknown, account: { teamId: string } | null) => (account ? [account.teamId] : []),
}));
mock.module('@buildd/core/decision-ledger', () => ({
  DECISION_LEDGER_MAX_ROWS: 500,
  readDecisionLedgerPage: ledger,
  summarizeDecisionLedger: (rows: unknown[]) => ({ total: rows.length }),
}));
mock.module('@/lib/orchestration-decision-stats-query', () => ({ fetchOrchestrationDecisionStats: decisionStats }));
mock.module('@/lib/coordination-stats-query', () => ({ fetchCoordinationStats: async () => ({}), coordinationFilters: () => ({}) }));

const { mintTaskToken } = await import('./task-token');
const { authenticateTaskScopedCaller, taskScopeAllowsDelegated, isDelegatedReach } = await import('./task-token-auth');
const decisions = await import('../app/api/decisions/route');
const coordination = await import('../app/api/stats/coordination/route');

const savedSecret = process.env.AUTH_SECRET;
afterAll(() => {
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
});

const GRANT = {
  grants: [{ workspaceId: TARGET_WS, capabilities: ['analytics:read', 'tasks:create'] }],
  grantedByUserId: 'user-admin', grantedByAccountId: null, grantedAt: '2026-01-01T00:00:00Z',
};

function reviewerToken(): string {
  return mintTaskToken({ accountId: ACCOUNT.id, taskId: REVIEW_TASK, workspaceId: KB_WS, keyHash: ACCOUNT.apiKey })!.token;
}
const get = (path: string, token: string) => new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } });

beforeEach(() => {
  process.env.AUTH_SECRET = 'scenario-secret';
  scheduleRow = { workspaceId: KB_WS, delegation: GRANT };
  taskRow = { workspaceId: KB_WS, scheduleId: SCHEDULE };
  ledger.mockClear();
  ledger.mockImplementation(async () => ({ rows: [], outcomes: [], truncated: false }));
  decisionStats.mockClear();
});

describe('scheduled reviewer with an explicit delegation', () => {
  it('its token carries exactly the granted reach', async () => {
    const account = await authenticateTaskScopedCaller(reviewerToken());
    expect(account?.taskScope?.workspaceId).toBe(KB_WS);
    expect(taskScopeAllowsDelegated(account!, TARGET_WS, 'analytics:read')).toBe(true);
    expect(taskScopeAllowsDelegated(account!, TARGET_WS, 'tasks:create')).toBe(true);
    expect(taskScopeAllowsDelegated(account!, SIBLING_WS, 'analytics:read')).toBe(false);
    expect(taskScopeAllowsDelegated(account!, FOREIGN_WS, 'analytics:read')).toBe(false);
    expect(isDelegatedReach(account!, TARGET_WS)).toBe(true);
    // Admin level and scopes stay exactly as before: a delegation is not admin.
    expect(account?.level).toBe('worker');
    expect(account?.scopes).toBeNull();
  });

  it('reads the decision ledger of the granted workspace, bounded to that workspace and its team', async () => {
    ledger.mockImplementation(async () => ({ rows: [{ id: 'd1', createdAt: new Date() }], outcomes: [], truncated: false }));
    const res = await decisions.GET(get(`/api/decisions?workspaceId=${TARGET_WS}&capability=question_gate`, reviewerToken()));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('OK');
    const [filters] = ledger.mock.calls[0];
    expect(filters).toMatchObject({ teamId: TEAM, workspaceId: TARGET_WS, capability: 'question_gate' });
  });

  it('zero recorded decisions is NO_DATA (200), distinct from a refused read', async () => {
    const ok = await decisions.GET(get(`/api/decisions?workspaceId=${TARGET_WS}&capability=question_gate`, reviewerToken()));
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe('NO_DATA');
    const refused = await decisions.GET(get(`/api/decisions?workspaceId=${SIBLING_WS}&capability=question_gate`, reviewerToken()));
    expect(refused.status).toBe(404);
    expect((await refused.json()).status).toBeUndefined();
  });

  it('reads decision stats of the granted workspace', async () => {
    const res = await coordination.GET(get(`/api/stats/coordination?metric=orchestrationDecisions&workspace=${TARGET_WS}`, reviewerToken()));
    expect(res.status).toBe(200);
    expect(decisionStats.mock.calls[0][0]).toMatchObject({ workspaceIds: [TARGET_WS] });
  });

  it('is still refused every workspace it was not granted, same team or not', async () => {
    for (const ws of [SIBLING_WS, FOREIGN_WS]) {
      expect((await decisions.GET(get(`/api/decisions?workspaceId=${ws}`, reviewerToken()))).status).toBe(404);
      expect((await coordination.GET(get(`/api/stats/coordination?metric=orchestrationDecisions&workspace=${ws}`, reviewerToken()))).status).toBe(404);
    }
    expect(ledger).not.toHaveBeenCalled();
    expect(decisionStats).not.toHaveBeenCalled();
  });
});

describe('the same reviewer without a usable delegation (the blind run)', () => {
  const cases: Array<[string, () => void]> = [
    ['no delegation on the schedule', () => { scheduleRow = { workspaceId: KB_WS, delegation: null }; }],
    ['the task was not spawned by a schedule', () => { taskRow = { workspaceId: KB_WS, scheduleId: null }; }],
    ['a schedule of another workspace carries the grant', () => { scheduleRow = { workspaceId: SIBLING_WS, delegation: GRANT }; }],
    ['the grant names a workspace of another team', () => {
      scheduleRow = { workspaceId: KB_WS, delegation: { ...GRANT, grants: [{ workspaceId: FOREIGN_WS, capabilities: ['analytics:read'] }] } };
    }],
  ];
  for (const [label, arrange] of cases) {
    it(`${label}: refused, and never as an empty result`, async () => {
      arrange();
      const res = await decisions.GET(get(`/api/decisions?workspaceId=${TARGET_WS}&capability=question_gate`, reviewerToken()));
      expect(res.status).toBe(404);
      expect(ledger).not.toHaveBeenCalled();
      const foreign = await decisions.GET(get(`/api/decisions?workspaceId=${FOREIGN_WS}`, reviewerToken()));
      expect(foreign.status).toBe(404);
    });
  }

  it('its own workspace stays readable as before', async () => {
    scheduleRow = { workspaceId: KB_WS, delegation: null };
    const res = await decisions.GET(get(`/api/decisions?workspaceId=${KB_WS}`, reviewerToken()));
    expect(res.status).toBe(200);
  });

  it('a delegation lookup error fails closed', async () => {
    scheduleRow = { get workspaceId(): string { throw new Error('db down'); }, delegation: GRANT } as any;
    const res = await decisions.GET(get(`/api/decisions?workspaceId=${TARGET_WS}`, reviewerToken()));
    expect(res.status).toBe(404);
  });
});
