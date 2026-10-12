/**
 * The platform owner sees full detail only for teams they are a member of.
 * Every admin route is read with one own team and one other team in scope:
 * no string the other team wrote (names, titles, signatures, excerpts, PR
 * URLs, repo names) may appear anywhere in the JSON, and the own team's
 * detail still does. The loaders are stubbed to answer per workspace, as the
 * real ones do; the redaction under test is lib/admin/tenant-privacy.ts.
 */
import { describe, it, expect, mock } from 'bun:test';
import { NextRequest, NextResponse } from 'next/server';

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });
mock.module('@/lib/admin/owner-gate', () => ({
  notFound,
  requirePlatformOwner: async () => ({ account: { id: 'acct-owner', level: 'admin', teamId: OWN_TEAM, createdByUserId: 'user-owner' } }),
}));
mock.module('@/lib/admin/audit', () => ({ recordPlatformAdminAudit: async () => {} }));

const OWN_TEAM = '11111111-1111-4111-8111-111111111111';
const OWN_WS = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM = '33333333-3333-4333-8333-333333333333';
const OTHER_WS = '44444444-4444-4444-8444-444444444444';
const OWN_EXP = '55555555-5555-4555-8555-555555555555';
const OTHER_EXP = '66666666-6666-4666-8666-666666666666';

// Every string the other team wrote carries this marker; own-team strings carry 'Mine'.
const SECRET = 'Zebra';
const text = (ws: string, what: string) => `${ws === OWN_WS ? 'Mine' : SECRET} ${what}`;
const teamOf = (ws: string) => (ws === OWN_WS ? OWN_TEAM : OTHER_TEAM);

const experimentRow = (id: string, teamId: string) => {
  const ws = teamId === OWN_TEAM ? OWN_WS : OTHER_WS;
  return {
    id, teamId, key: text(ws, 'experiment key'), title: text(ws, 'experiment title'), hypothesis: text(ws, 'hypothesis'),
    status: 'running', kind: 'model_routing', treatmentFraction: 0.5, policyVersion: 1, config: { note: text(ws, 'config') },
    visibility: 'admins', decision: text(ws, 'decision'), startedAt: new Date('2026-01-01T00:00:00Z'), concludedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
};

const signature = (ws: string) => ({
  signature: text(ws, 'signature'), count: 1, exampleError: text(ws, 'raw error'), exampleTaskId: `task-${ws}`, exampleWorkerIds: [],
});

mock.module('@/lib/admin/data', () => ({
  resolveScopeWorkspaces: async () => ({ workspaces: [{ id: OWN_WS, teamId: OWN_TEAM }, { id: OTHER_WS, teamId: OTHER_TEAM }] }),
  loadOwnTeams: async () => [{ id: OWN_TEAM, name: 'Mine team' }],
  loadDecisionFeatureCounts: async () => [],
  loadDecisionHealthRows: async () => ({ rows: [], outcomes: [], truncated: false }),
  loadDecisionStats: async () => ({ decisions: { total: 2 } }),
  listExperiments: async () => [experimentRow(OWN_EXP, OWN_TEAM), experimentRow(OTHER_EXP, OTHER_TEAM)],
  loadExperimentHealth: async () => ({}),
  getExperiment: async (id: string) => (id === OWN_EXP ? experimentRow(OWN_EXP, OWN_TEAM) : id === OTHER_EXP ? experimentRow(OTHER_EXP, OTHER_TEAM) : null),
  findOtherRunning: async () => null,
  applyExperimentUpdate: async (teamId: string, id: string, _guard: unknown, set: any) => ({ ...experimentRow(id, teamId), ...set }),
  readTeamExperimentFlags: async () => ({ enabledDecisionShadows: [], chatRetro: { lessons: false, proposals: false }, chatRetroDogfood: false }),
  writeTeamExperimentFlags: async () => ({ deletedLessons: 0 }),
  listChatRetros: async () => [OWN_WS, OTHER_WS].map(ws => ({ id: `r-${ws}`, teamId: teamOf(ws), workspaceId: ws, status: 'judged', turns: 4 })),
  loadUsage: async (o: any) => ({
    totals: { tasks: 2, costUsd: 3 }, groups: [],
    topTasks: [OWN_WS, OTHER_WS].filter(ws => o.topTaskWorkspaceIds.includes(ws) || ws === OTHER_WS)
      .map(ws => ({ taskId: `task-${ws}`, workspaceId: ws, costUsd: 1, workers: 1, title: text(ws, 'task title') })),
  }),
  loadDispatchHealth: async (ids: string[]) => ({ verdict: 'healthy', problems: [], workspaces: ids.map(id => ({ id, name: text(id, 'repo'), transport: 'in_app' })) }),
  loadGates: async (o: any) => ({
    gates: {
      totals: { events: o.workspaceIds.length },
      gates: [{ gate: 'pr_landing', count: o.workspaceIds.length, exampleTaskId: `task-${o.workspaceIds.at(-1)}`,
        topReasons: o.workspaceIds.map((ws: string) => ({ reason: text(ws, 'gate reason'), count: 1 })) }],
    },
    ...(o.errorPrefix
      ? { gateFamily: { prefix: o.errorPrefix, topReasons: o.workspaceIds.map((ws: string) => ({ reason: text(ws, 'family reason'), count: 1 })) } }
      : { landing: { landed: 2 } }),
  }),
  loadFailures: async (o: any) => ({
    analytics: {
      totals: { failed: o.workspaceIds.length },
      byExitCause: [{ exitCause: 'timeout', count: o.workspaceIds.length }],
      signatures: o.workspaceIds.map(signature),
      diedEarlySignatures: o.workspaceIds.map(signature),
      byWorkspace: o.workspaceIds.map((ws: string) => ({ workspaceId: ws, workspaceName: text(ws, 'repo'), failed: 1 })),
      repeatFailureTasks: o.workspaceIds.map((ws: string) => ({ taskId: `task-${ws}`, taskTitle: text(ws, 'task title'), workspaceId: ws })),
    },
    family: o.errorPrefix ? { prefix: o.errorPrefix, topSignatures: o.workspaceIds.map((ws: string) => ({ signature: text(ws, 'family'), count: 1 })) } : null,
    stalledIngest: { stalled: o.workspaceIds.length, jobs: o.workspaceIds.map((ws: string) => ({ id: `job-${ws}`, workspaceId: ws, repo: text(ws, 'repo'), lastError: text(ws, 'ingest error') })) },
  }),
  loadRecoveryQueue: async () => null,
  loadRecoveryCause: async () => null,
  loadOperatorData: async (o: any) => ({
    subagentDelegation: null, errorPatterns: null,
    orphanedPrs: o.workspaceIds.map((ws: string) => ({ workspaceId: ws, taskId: `task-${ws}`, prUrl: `https://github.com/x/${text(ws, 'pr').replace(' ', '-')}`, prNumber: 7, reason: text(ws, 'pr reason') })),
  }),
  loadInsights: async (o: any) => ({
    series: {
      buckets: [{ start: 0, end: 1, released: o.workspaceIds.length }],
      tasks: o.workspaceIds.map((ws: string) => ({ key: `task-${ws}`, title: text(ws, 'task title'), workspaceId: ws, missionId: null })),
      workspaceNames: Object.fromEntries(o.workspaceIds.map((ws: string) => [ws, text(ws, 'repo')])),
    },
    usage: { rows: [] }, truncated: false,
  }),
  loadInsightsBand: async (o: any) => ({
    band: 'released', label: 'Released', from: 'a', to: 'b',
    tasks: o.workspaceIds.map((ws: string) => ({ id: `task-${ws}`, title: text(ws, 'task title'), missionTitle: text(ws, 'mission title'), workspaceId: ws })),
  }),
  loadAgentAccess: async (o: any) => ({
    windowHours: o.windowHours, granted: 2, refusals: [],
    grantProblems: o.workspaceIds.map((ws: string) => ({ workspaceId: ws, workspaceName: text(ws, 'repo'), reason: 'no_install', count: 1 })),
  }),
  listTeamsWithWorkspaces: async () => [
    { id: OWN_TEAM, name: 'Mine team', workspaces: [{ id: OWN_WS, name: 'Mine repo' }] },
    { id: OTHER_TEAM, name: `${SECRET} team`, workspaces: [{ id: OTHER_WS, name: `${SECRET} repo` }] },
  ],
  loadExperimentReadout: async (row: any) => ({ policyVersion: row.policyVersion, readout: null, health: [] }),
}));

const route = (p: string) => import(p);
const req = (path: string, method = 'GET', body?: unknown) => new NextRequest(`http://localhost:3000/api/admin/${path}`, {
  method,
  headers: { 'content-type': 'application/json', authorization: 'Bearer bld_x' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Each read route, with what must still be visible of the own team (null: the route has no team detail). */
const cases: { name: string; call: () => Promise<Response>; own: string | null }[] = [
  { name: 'GET usage', call: async () => (await route('./usage/route')).GET(req('usage')), own: 'Mine task title' },
  { name: 'GET insights', call: async () => (await route('./insights/route')).GET(req('insights')), own: 'Mine task title' },
  {
    name: 'GET insights/tasks',
    call: async () => (await route('./insights/tasks/route')).GET(req('insights/tasks?band=released&from=1760000000000&to=1760604800000&at=1760300000000')),
    own: 'Mine mission title',
  },
  { name: 'GET failures', call: async () => (await route('./failures/route')).GET(req('failures')), own: 'Mine raw error' },
  { name: 'GET failures?errorPrefix', call: async () => (await route('./failures/route')).GET(req('failures?errorPrefix=x')), own: 'Mine family' },
  { name: 'GET gates', call: async () => (await route('./gates/route')).GET(req('gates')), own: 'Mine gate reason' },
  { name: 'GET gates?errorPrefix', call: async () => (await route('./gates/route')).GET(req('gates?errorPrefix=x')), own: 'Mine family reason' },
  { name: 'GET dispatch-health', call: async () => (await route('./dispatch-health/route')).GET(req('dispatch-health')), own: 'Mine repo' },
  { name: 'GET operator', call: async () => (await route('./operator/route')).GET(req('operator')), own: 'Mine pr reason' },
  { name: 'GET agent-access', call: async () => (await route('./agent-access/route')).GET(req('agent-access')), own: 'Mine repo' },
  { name: 'GET chat-retros', call: async () => (await route('./chat-retros/route')).GET(req('chat-retros')), own: 'Mine team' },
  { name: 'GET teams', call: async () => (await route('./teams/route')).GET(req('teams')), own: 'Mine repo' },
  { name: 'GET experiments', call: async () => (await route('./experiments/route')).GET(req('experiments')), own: 'Mine hypothesis' },
  {
    name: 'GET experiments/[id]/readout (other team)',
    call: async () => (await route('./experiments/[id]/readout/route')).GET(req(`experiments/${OTHER_EXP}/readout`), idCtx(OTHER_EXP)),
    own: null,
  },
  {
    name: 'GET experiments/[id]/readout (own team)',
    call: async () => (await route('./experiments/[id]/readout/route')).GET(req(`experiments/${OWN_EXP}/readout`), idCtx(OWN_EXP)),
    own: 'Mine experiment title',
  },
  {
    name: 'PATCH experiments/[id] (other team)',
    call: async () => (await route('./experiments/[id]/route')).PATCH(req(`experiments/${OTHER_EXP}`, 'PATCH', { status: 'paused' }), idCtx(OTHER_EXP)),
    own: null,
  },
  { name: 'GET decisions/stats', call: async () => (await route('./decisions/stats/route')).GET(req('decisions/stats')), own: null },
  { name: 'GET decisions/features', call: async () => (await route('./decisions/features/route')).GET(req('decisions/features')), own: null },
  {
    name: 'GET teams/[id]/experiment-flags',
    call: async () => (await route('./teams/[id]/experiment-flags/route')).GET(req(`teams/${OTHER_TEAM}/experiment-flags`), idCtx(OTHER_TEAM)),
    own: null,
  },
];

describe('another team is aggregate-only on every admin route', () => {
  for (const { name, call, own } of cases) {
    it(name, async () => {
      const res = await call();
      expect(res.status).toBe(200);
      const json = JSON.stringify(await res.json());
      expect(json).not.toContain(SECRET);
      if (own) expect(json).toContain(own);
    });
  }
});

describe('what the other team still contributes', () => {
  it('names the other team and its workspace by a stable pseudonym', async () => {
    const teams = (await route('./teams/route')).GET;
    const first = await (await teams(req('teams'))).json();
    const second = await (await teams(req('teams'))).json();
    const other = first.teams.find((t: any) => t.id === OTHER_TEAM);
    expect(other.own).toBe(false);
    expect(other.name).toMatch(/^Team [0-9a-f]{6}$/);
    expect(other.workspaces[0].name).toMatch(/^Workspace [0-9a-f]{6}$/);
    expect(second.teams.find((t: any) => t.id === OTHER_TEAM)).toEqual(other);
    expect(first.teams.find((t: any) => t.id === OWN_TEAM)).toMatchObject({ name: 'Mine team', own: true });
  });

  it('counts its rows in totals but lists only own rows in drilldowns', async () => {
    const failures = await (await (await route('./failures/route')).GET(req('failures'))).json();
    expect(failures.analytics.totals.failed).toBe(2);
    expect(failures.analytics.signatures).toHaveLength(1);
    expect(failures.analytics.byWorkspace).toHaveLength(2);
    expect(failures.detailLimitedToOwnTeams).toBe(true);

    const band = await (await (await route('./insights/tasks/route'))
      .GET(req('insights/tasks?band=released&from=1760000000000&to=1760604800000&at=1760300000000'))).json();
    expect(band.tasks.map((t: any) => t.id)).toEqual([`task-${OWN_WS}`]);
    expect(band.otherTeamTasks).toBe(1);

    const gates = await (await (await route('./gates/route')).GET(req('gates'))).json();
    expect(gates.gates.gates[0].count).toBe(2);
    expect(gates.gates.gates[0].exampleTaskId).toBe(`task-${OWN_WS}`);
  });

  it('pseudonymizes the team on chat retros', async () => {
    const body = await (await (await route('./chat-retros/route')).GET(req('chat-retros'))).json();
    expect(body.retros.map((r: any) => r.team)).toEqual(['Mine team', expect.stringMatching(/^Team [0-9a-f]{6}$/)]);
  });
});
