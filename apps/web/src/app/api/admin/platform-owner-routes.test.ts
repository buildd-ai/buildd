/**
 * The platform-owner data routes under /api/admin/*: every one answers 404 to
 * anyone but the platform owner, returns data to the owner, and every write is
 * audited. The loaders are stubbed; their queries are the existing analytics
 * libs, covered where they live.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

let owner = true;
const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });
mock.module('@/lib/admin/owner-gate', () => ({
  notFound,
  requirePlatformOwner: async () => owner ? { account: { id: 'acct-owner', level: 'admin' } } : { response: notFound() },
}));

const audits: any[] = [];
mock.module('@/lib/admin/audit', () => ({
  recordPlatformAdminAudit: async (event: any) => { audits.push(event); },
}));

const TEAM = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const EXP = '33333333-3333-4333-8333-333333333333';

const experimentRow = () => ({
  id: EXP, teamId: TEAM, key: 'route-a', title: 'Route A', hypothesis: null, status: 'running', kind: 'model_routing',
  treatmentFraction: 0.5, policyVersion: 1, config: {}, visibility: 'admins', decision: null,
  startedAt: new Date('2026-01-01T00:00:00Z'), concludedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
});
let flags: any;
const writes: any[] = [];
const scopes: any[] = [];

mock.module('@/lib/admin/growth', () => ({
  loadGrowth: async () => ({ asOf: '2031-03-15', totalUsers: 2, mau: 1, days: [] }),
}));

mock.module('@/lib/admin/data', () => ({
  resolveScopeWorkspaces: async (scope: any) => {
    scopes.push(scope);
    if (scope.teamId === '99999999-9999-4999-8999-999999999999') return null;
    return { workspaceIds: [WS] };
  },
  loadDecisionFeatureCounts: async () => [
    { capability: 'task_role_shadow', count: 4, applied: 3, suggested: 1, fallback: 0, overridden: 1, costUsd: 0.0002, inputTokens: 900 },
    { capability: 'orchestration_claim', count: 2, applied: 0, suggested: 2, fallback: 0, overridden: 0, costUsd: 0.001, inputTokens: 300 },
  ],
  loadDecisionStats: async () => ({ decisions: { total: 7 }, manifestPredictions: { total: 0 } }),
  listExperiments: async () => [experimentRow()],
  loadExperimentHealth: async () => ({ [EXP]: [] }),
  getExperiment: async (id: string) => (id === EXP ? experimentRow() : null),
  findOtherRunning: async () => null,
  applyExperimentUpdate: async (_teamId: string, _id: string, _guard: unknown, set: any) => ({ ...experimentRow(), ...set }),
  readTeamExperimentFlags: async (teamId: string) => (teamId === TEAM ? flags : null),
  writeTeamExperimentFlags: async (teamId: string, next: any) => { writes.push({ teamId, next }); return { deletedLessons: 0 }; },
  listChatRetros: async () => [{ id: 'r1', teamId: TEAM, status: 'judged', turns: 6 }],
  loadUsage: async () => ({ totals: { tasks: 3 }, groups: [] }),
  loadDispatchHealth: async () => ({ verdict: 'healthy' }),
  loadGates: async () => ({ gates: { totals: { events: 5 } } }),
  loadFailures: async () => ({ analytics: { totals: { failed: 2 } } }),
  loadOperatorData: async () => ({ orphanedPrs: [], subagentDelegation: null, errorPatterns: null }),
  loadRecoveryQueue: async (opts: any) => {
    recoveryCalls.push({ kind: 'queue', ...opts });
    if (recoveryThrows) throw new Error('read failed');
    return { v: 1, causes: [{ causeKey: CAUSE, impact: { teams: opts.platformWide ? [{ id: TEAM, name: 'Team A' }, { id: OTHER_TEAM, name: 'Team B' }] : [{ id: TEAM, name: 'Team A' }] } }], truncated: false };
  },
  loadRecoveryCause: async (opts: any) => { recoveryCalls.push({ kind: 'cause', ...opts }); return opts.causeKey === CAUSE ? { cause: { causeKey: CAUSE } } : null; },
  loadInsights: async (opts: any) => { insightCalls.push(opts); return { series: { buckets: [] }, usage: { rows: [] }, truncated: false }; },
  loadInsightsBand: async (opts: any) => { insightCalls.push(opts); return opts.filter.band === 'none' ? null : { label: 'Released', tasks: [{ id: 't1', title: 'Task 1', status: 'completed' }] }; },
  loadAgentAccess: async (opts: any) => { insightCalls.push(opts); return { windowHours: opts.windowHours, granted: 3, refusals: [] }; },
  listTeamsWithWorkspaces: async () => [{ id: TEAM, name: 'Team A', workspaces: [{ id: WS, name: 'repo-a' }] }],
  loadExperimentReadout: async (row: any) => ({ policyVersion: row.policyVersion, readout: { verdict: 'insufficient_n', arms: [] }, health: [] }),
}));
const insightCalls: any[] = [];
const recoveryCalls: any[] = [];
let recoveryThrows = false;
const CAUSE = 'c1:0123456789abcdef0123';
const OTHER_TEAM = '55555555-5555-4555-8555-555555555555';

const routes = {
  decisionFeatures: await import('./decisions/features/route'),
  decisionStats: await import('./decisions/stats/route'),
  experiments: await import('./experiments/route'),
  experiment: await import('./experiments/[id]/route'),
  flags: await import('./teams/[id]/experiment-flags/route'),
  chatRetros: await import('./chat-retros/route'),
  usage: await import('./usage/route'),
  dispatch: await import('./dispatch-health/route'),
  gates: await import('./gates/route'),
  failures: await import('./failures/route'),
  operator: await import('./operator/route'),
  insights: await import('./insights/route'),
  insightsTasks: await import('./insights/tasks/route'),
  agentAccess: await import('./agent-access/route'),
  teams: await import('./teams/route'),
  readout: await import('./experiments/[id]/readout/route'),
  growth: await import('./growth/route'),
};

const req = (path: string, method = 'GET', body?: unknown) => new NextRequest(`http://localhost:3000/api/admin/${path}`, {
  method,
  headers: { 'content-type': 'application/json', authorization: 'Bearer bld_x' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

type Call = { name: string; call: () => Promise<Response> };
const calls: Call[] = [
  { name: 'GET decisions/features', call: () => routes.decisionFeatures.GET(req('decisions/features')) },
  { name: 'GET decisions/stats', call: () => routes.decisionStats.GET(req('decisions/stats')) },
  { name: 'GET experiments', call: () => routes.experiments.GET(req('experiments')) },
  { name: 'PATCH experiments/[id]', call: () => routes.experiment.PATCH(req(`experiments/${EXP}`, 'PATCH', { status: 'paused' }), idCtx(EXP)) },
  { name: 'GET teams/[id]/experiment-flags', call: () => routes.flags.GET(req(`teams/${TEAM}/experiment-flags`), idCtx(TEAM)) },
  { name: 'PATCH teams/[id]/experiment-flags', call: () => routes.flags.PATCH(req(`teams/${TEAM}/experiment-flags`, 'PATCH', { enabledDecisionShadows: [] }), idCtx(TEAM)) },
  { name: 'GET chat-retros', call: () => routes.chatRetros.GET(req('chat-retros')) },
  { name: 'GET usage', call: () => routes.usage.GET(req('usage')) },
  { name: 'GET dispatch-health', call: () => routes.dispatch.GET(req('dispatch-health')) },
  { name: 'GET gates', call: () => routes.gates.GET(req('gates')) },
  { name: 'GET failures', call: () => routes.failures.GET(req('failures')) },
  { name: 'GET operator', call: () => routes.operator.GET(req('operator')) },
  { name: 'GET operator?recovery=1', call: () => routes.operator.GET(req('operator?recovery=1')) },
  { name: 'GET operator?recoveryInclude=recovered', call: () => routes.operator.GET(req('operator?recovery=1&recoveryInclude=recovered')) },
  { name: 'GET operator?recoveryCause', call: () => routes.operator.GET(req(`operator?recoveryCause=${CAUSE}`)) },
  { name: 'GET operator?recoveryFilter', call: () => routes.operator.GET(req('operator?recovery=1&recoveryFilter=queue_age')) },
  { name: 'GET insights', call: () => routes.insights.GET(req('insights')) },
  { name: 'GET insights/tasks', call: () => routes.insightsTasks.GET(req('insights/tasks?band=released&from=1760000000000&to=1760604800000&at=1760300000000')) },
  { name: 'GET agent-access', call: () => routes.agentAccess.GET(req('agent-access')) },
  { name: 'GET teams', call: () => routes.teams.GET(req('teams')) },
  { name: 'GET experiments/[id]/readout', call: () => routes.readout.GET(req(`experiments/${EXP}/readout`), idCtx(EXP)) },
  { name: 'GET growth', call: () => routes.growth.GET(req('growth')) },
];

beforeEach(() => {
  owner = true;
  audits.length = 0;
  writes.length = 0;
  scopes.length = 0;
  insightCalls.length = 0;
  recoveryCalls.length = 0;
  recoveryThrows = false;
  flags = { enabledDecisionShadows: ['task_role_shadow'], chatRetro: { lessons: false, proposals: false }, chatRetroDogfood: false };
});

describe('non-owner gets 404 on every route', () => {
  for (const { name, call } of calls) {
    it(name, async () => {
      owner = false;
      const res = await call();
      expect(res.status).toBe(404);
      expect(writes).toHaveLength(0);
      expect(audits).toHaveLength(0);
    });
  }
});

describe('the owner gets data on every route', () => {
  for (const { name, call } of calls) {
    it(name, async () => {
      const res = await call();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toBeObject();
      expect(body.error).toBeUndefined();
    });
  }
});

describe('scope', () => {
  it('rejects an unknown window', async () => {
    expect((await routes.usage.GET(req('usage?window=90d'))).status).toBe(400);
  });

  it('rejects a non-UUID team or workspace', async () => {
    expect((await routes.gates.GET(req('gates?teamId=nope'))).status).toBe(400);
    expect((await routes.gates.GET(req('gates?workspaceId=nope'))).status).toBe(400);
  });

  it('404s a team that does not exist', async () => {
    expect((await routes.failures.GET(req('failures?teamId=99999999-9999-4999-8999-999999999999'))).status).toBe(404);
  });

  it('passes the window and filters through to the loader', async () => {
    await routes.dispatch.GET(req(`dispatch-health?teamId=${TEAM}&window=30d`));
    expect(scopes[0]).toMatchObject({ teamId: TEAM, workspaceId: null, window: '30d' });
  });
});

describe('GET decisions/features', () => {
  it('groups every capability by kind with its ledger counts and cost', async () => {
    const body = await (await routes.decisionFeatures.GET(req('decisions/features'))).json();
    const kinds = body.groups.map((g: any) => g.kind);
    expect(kinds).toEqual(['interactive', 'built_in', 'opt_in', 'server_feature']);
    const optIn = body.groups.find((g: any) => g.kind === 'opt_in');
    const shadow = optIn.features.find((f: any) => f.id === 'task_role_shadow');
    expect(shadow).toMatchObject({ count: 4, applied: 3, overridden: 1, costUsd: 0.0002 });
    // The alias is reported as such, not as a second feature with its own numbers.
    expect(optIn.features.find((f: any) => f.id === 'task_role_apply')).toMatchObject({ aliasOf: 'task_role_shadow', count: 0 });
    expect(body.totals).toMatchObject({ count: 6, costUsd: 0.0012 });
    // Data only: no labels or descriptions.
    expect(JSON.stringify(body)).not.toContain('description');
  });
});

describe('PATCH experiments/[id]', () => {
  it('applies the change and audits before/after', async () => {
    const res = await routes.experiment.PATCH(req(`experiments/${EXP}`, 'PATCH', { status: 'paused' }), idCtx(EXP));
    expect(res.status).toBe(200);
    expect((await res.json()).experiment.status).toBe('paused');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorAccountId: 'acct-owner', action: 'experiment.update', targetType: 'experiment', targetId: EXP, teamId: TEAM,
      before: { status: 'running' }, after: { status: 'paused' },
    });
  });

  it('404s an unknown experiment and audits nothing', async () => {
    const other = '44444444-4444-4444-8444-444444444444';
    expect((await routes.experiment.PATCH(req(`experiments/${other}`, 'PATCH', { status: 'paused' }), idCtx(other))).status).toBe(404);
    expect(audits).toHaveLength(0);
  });

  it('400s an invalid change and audits nothing', async () => {
    expect((await routes.experiment.PATCH(req(`experiments/${EXP}`, 'PATCH', { treatmentFraction: 7 }), idCtx(EXP))).status).toBe(400);
    expect(audits).toHaveLength(0);
  });
});

describe('PATCH teams/[id]/experiment-flags', () => {
  it('writes the flags and audits before/after', async () => {
    const res = await routes.flags.PATCH(
      req(`teams/${TEAM}/experiment-flags`, 'PATCH', { enabledDecisionShadows: ['task_role_shadow', 'mission_goal_quality'], chatRetro: { lessons: true } }),
      idCtx(TEAM),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags).toMatchObject({ enabledDecisionShadows: ['task_role_shadow', 'mission_goal_quality'], chatRetro: { lessons: true, proposals: false } });
    expect(writes).toEqual([{ teamId: TEAM, next: { enabledDecisionShadows: ['task_role_shadow', 'mission_goal_quality'], chatRetro: { lessons: true, proposals: false }, deleteLessons: false } }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorAccountId: 'acct-owner', action: 'team.experiment_flags.update', targetType: 'team', targetId: TEAM, teamId: TEAM,
      before: { enabledDecisionShadows: ['task_role_shadow'], chatRetro: { lessons: false, proposals: false } },
      after: { enabledDecisionShadows: ['task_role_shadow', 'mission_goal_quality'], chatRetro: { lessons: true, proposals: false } },
    });
  });

  it('rejects an unknown capability and writes nothing', async () => {
    const res = await routes.flags.PATCH(req(`teams/${TEAM}/experiment-flags`, 'PATCH', { enabledDecisionShadows: ['not_a_capability'] }), idCtx(TEAM));
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('rejects unknown fields and an empty body', async () => {
    expect((await routes.flags.PATCH(req(`teams/${TEAM}/experiment-flags`, 'PATCH', { other: 1 }), idCtx(TEAM))).status).toBe(400);
    expect((await routes.flags.PATCH(req(`teams/${TEAM}/experiment-flags`, 'PATCH', {}), idCtx(TEAM))).status).toBe(400);
    expect(audits).toHaveLength(0);
  });

  it('404s an unknown team', async () => {
    const other = '55555555-5555-4555-8555-555555555555';
    expect((await routes.flags.GET(req(`teams/${other}/experiment-flags`), idCtx(other))).status).toBe(404);
    expect((await routes.flags.PATCH(req(`teams/${other}/experiment-flags`, 'PATCH', { enabledDecisionShadows: [] }), idCtx(other))).status).toBe(404);
    expect(audits).toHaveLength(0);
  });
});

describe('GET insights', () => {
  it('reads the flow series for a 7 or 30 day window; 24h reads the 7 day series', async () => {
    await routes.insights.GET(req('insights?window=30d'));
    await routes.insights.GET(req('insights?window=24h'));
    expect(insightCalls.map(c => c.window)).toEqual(['30d', '7d']);
    expect(insightCalls[0].workspaceIds).toEqual([WS]);
  });
});

describe('GET insights/tasks', () => {
  it('400s without a band filter', async () => {
    expect((await routes.insightsTasks.GET(req('insights/tasks'))).status).toBe(400);
    expect(insightCalls).toHaveLength(0);
  });

  it('lists the tasks in the band', async () => {
    const body = await (await routes.insightsTasks.GET(req('insights/tasks?band=released&from=1760000000000&to=1760604800000&at=1760300000000'))).json();
    expect(body.label).toBe('Released');
    expect(body.tasks).toHaveLength(1);
    expect(insightCalls[0]).toMatchObject({ workspaceIds: [WS] });
  });
});

describe('GET agent-access', () => {
  it('passes the window in hours', async () => {
    const body = await (await routes.agentAccess.GET(req('agent-access?window=7d'))).json();
    expect(body.report.windowHours).toBe(168);
  });
});

describe('names and readouts for the admin app', () => {
  it('lists every team with its workspaces by name', async () => {
    const res = await routes.teams.GET(req('teams'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ teams: [{ id: TEAM, name: 'Team A', workspaces: [{ id: WS, name: 'repo-a' }] }] });
  });

  it('reads one experiment\'s readout, and 404s an unknown id', async () => {
    const res = await routes.readout.GET(req(`experiments/${EXP}/readout`), idCtx(EXP));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.experiment.id).toBe(EXP);
    expect(body.readout.verdict).toBe('insufficient_n');
    const missing = await routes.readout.GET(req('experiments/44444444-4444-4444-8444-444444444444/readout'), idCtx('44444444-4444-4444-8444-444444444444'));
    expect(missing.status).toBe(404);
  });
});

describe('GET operator: the recovery queue (operator-recovery §7.1)', () => {
  it('F-9: a non-owner gets 404 on every recovery param and nothing is read', async () => {
    owner = false;
    for (const q of ['recovery=1', `recoveryCause=${CAUSE}`, 'recoveryInclude=recovered', 'recoveryFilter=queue_age', `recovery=1&teamId=${TEAM}`]) {
      const res = await routes.operator.GET(req(`operator?${q}`));
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain('causeKey');
    }
    expect(recoveryCalls).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('without the params the response is unchanged', async () => {
    const body = await (await routes.operator.GET(req('operator'))).json();
    expect(body.recovery).toBeUndefined();
    expect(body.recoveryCause).toBeUndefined();
    expect(recoveryCalls).toHaveLength(0);
  });

  it('adds the panel and the drill-down, passing the window and options through', async () => {
    const body = await (await routes.operator.GET(req(`operator?window=30d&recovery=1&recoveryInclude=recovered&recoveryFilter=reopened&recoveryCause=${CAUSE}`))).json();
    expect(body.recovery.causes[0].causeKey).toBe(CAUSE);
    expect(body.recoveryCause.cause.causeKey).toBe(CAUSE);
    expect(recoveryCalls.find(c => c.kind === 'queue')).toMatchObject({ window: '30d', includeRecovered: true, filter: 'reopened', platformWide: true, workspaceIds: [WS] });
  });

  it('a scoped read is not platform-wide, so it never names another team', async () => {
    const body = await (await routes.operator.GET(req(`operator?recovery=1&teamId=${TEAM}`))).json();
    expect(recoveryCalls[0]).toMatchObject({ platformWide: false, workspaceIds: [WS] });
    expect(JSON.stringify(body.recovery)).not.toContain(OTHER_TEAM);
    expect(JSON.stringify(body.recovery)).not.toContain('Team B');
    await routes.operator.GET(req(`operator?recovery=1&workspaceId=${WS}`));
    expect(recoveryCalls[1].platformWide).toBe(false);
  });

  it('a failed panel read is null, not a 500', async () => {
    recoveryThrows = true;
    const res = await routes.operator.GET(req('operator?recovery=1'));
    expect(res.status).toBe(200);
    expect((await res.json()).recovery).toBeNull();
  });

  it('an unknown cause is null', async () => {
    const body = await (await routes.operator.GET(req('operator?recoveryCause=c1:ffffffffffffffffffff'))).json();
    expect(body.recoveryCause).toBeNull();
  });

  it('rejects a malformed cause key, filter or include', async () => {
    expect((await routes.operator.GET(req('operator?recoveryCause=nope'))).status).toBe(400);
    expect((await routes.operator.GET(req('operator?recovery=1&recoveryFilter=everything'))).status).toBe(400);
    expect((await routes.operator.GET(req('operator?recoveryInclude=all'))).status).toBe(400);
    expect(recoveryCalls).toHaveLength(0);
  });
});
