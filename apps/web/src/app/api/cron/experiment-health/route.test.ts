// Asserts on the cron_runs row against a mocked db, so opt in to recording
// (withCronRun records nothing under NODE_ENV=test by default).
process.env.BUILDD_CRON_RUN_RECORD_IN_TESTS = '1';

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// The evaluator is covered in packages/core/__tests__/experiment-health*.test.ts;
// here the wiring: auth, the alert, the cap auto-pause, and the cron_runs verdict.
const EXP = '11111111-1111-4111-8111-111111111111';
const TEAM = 'team-a';
let running: any[] = [];
let findingsById: Record<string, any[] | Error> = {};

const mockRunning = mock(() => Promise.resolve(running));
const mockHealth = mock(async (row: any) => {
  const f = findingsById[row.id] ?? [];
  if (f instanceof Error) throw f;
  return f;
});
mock.module('@buildd/core/experiment-health-source', () => ({
  buildRunningExperimentsQuery: mockRunning,
  runExperimentHealth: mockHealth,
}));

const mockPause = mock(async (..._a: any[]) => ({ id: EXP }) as any);
mock.module('@/lib/experiments-store', () => ({ applyExperimentUpdate: mockPause }));

// Experiments belong to a team: the alert goes to that team's own channel.
// `notify` sees each payload; `notifiedTeams` records who received it.
const notify = mock((_o: any) => undefined);
const notifiedTeams: string[] = [];
mock.module('@/lib/notify', () => ({
  notifyTeam: async (teamId: string, _event: string, payload: any) => { notifiedTeams.push(teamId); notify(payload); },
}));

const recorded: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    insert: () => ({ values: (v: any) => { recorded.push(v); return { returning: async () => [{ id: 'cron-run-1' }] }; } }),
    update: () => ({ set: (v: any) => { recorded.push(v); return { where: async () => {} }; } }),
    delete: () => ({ where: () => Promise.resolve() }),
    query: { cronRuns: { findMany: async () => [] } },
  },
}));

const { GET } = await import('./route');

const SECRET = 'test-cron-secret';
const req = (token: string | null = SECRET) => new NextRequest('http://localhost:3000/api/cron/experiment-health', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

const row = (over: Record<string, unknown> = {}) => ({
  id: EXP, teamId: TEAM, key: 'premium-vs-standard', title: 'Premium vs standard', kind: 'model_routing',
  status: 'running', startedAt: new Date('2026-01-01T00:00:00Z'), treatmentFraction: 0.5, policyVersion: 2, config: {},
  ...over,
});

describe('GET /api/cron/experiment-health', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    running = [];
    findingsById = {};
    mockHealth.mockClear();
    mockPause.mockClear();
    notify.mockClear();
    notifiedTeams.length = 0;
    recorded.length = 0;
  });

  it('refuses without the cron secret and checks nothing', async () => {
    expect((await GET(req('wrong'))).status).toBe(401);
    expect(mockHealth).not.toHaveBeenCalled();
  });

  it('a healthy fleet pages nobody and reports zero findings', async () => {
    running = [row()];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(notify).not.toHaveBeenCalled();
    expect(recorded.find(r => r.changed !== undefined)).toMatchObject({ processed: 1, changed: 0, errors: 0 });
  });

  // @notify-fire: experiment-health
  it('sends one alert naming each unhealthy experiment and its findings', async () => {
    running = [row(), row({ id: 'e2', key: 'triage', kind: 'heartbeat_triage' })];
    findingsById = {
      [EXP]: [{ code: 'arm_never_drawn', severity: 'critical', arm: 'treatment', detail: 'arm treatment has a 50% share and 0 of 40 units' }],
      e2: [{ code: 'no_recent_assignments', severity: 'critical', detail: 'running 9d and no unit enrolled yet' }],
    };
    const res = await GET(req());
    const body = await res.json();
    expect(notify).toHaveBeenCalledTimes(1);
    const opts = notify.mock.calls[0][0];
    expect(notifiedTeams).toEqual([TEAM]);
    expect(opts.title).toContain('2 experiments');
    expect(opts.message).toContain('premium-vs-standard: arm_never_drawn');
    expect(opts.message).toContain('triage: no_recent_assignments');
    expect(body.unhealthy).toBe(2);
    expect(recorded.find(r => r.changed !== undefined)).toMatchObject({ processed: 2, changed: 2, errors: 0 });
  });

  it('alerts each team only about its own experiments', async () => {
    running = [row(), row({ id: 'e2', teamId: 'team-b', key: 'triage', kind: 'heartbeat_triage' })];
    findingsById = {
      [EXP]: [{ code: 'arm_never_drawn', severity: 'critical', arm: 'treatment', detail: 'x' }],
      e2: [{ code: 'no_recent_assignments', severity: 'critical', detail: 'y' }],
    };
    await GET(req());
    expect(notifiedTeams).toEqual([TEAM, 'team-b']);
    expect(notify.mock.calls[0][0].message).not.toContain('triage');
    expect(notify.mock.calls[1][0].message).not.toContain('premium-vs-standard');
  });

  it('pauses an experiment past its duration cap, guarded on the state it was read in', async () => {
    running = [row({ config: { maxDurationDays: 7 } })];
    findingsById = { [EXP]: [{ code: 'past_duration_cap', severity: 'critical', detail: 'running past its duration cap' }] };
    const body = await (await GET(req())).json();
    expect(mockPause).toHaveBeenCalledTimes(1);
    const [teamId, id, expected, set, requireNoOther] = mockPause.mock.calls[0];
    expect([teamId, id]).toEqual([TEAM, EXP]);
    expect(expected).toEqual({ status: 'running', policyVersion: 2 });
    expect(set.status).toBe('paused');
    expect(requireNoOther).toBeNull();
    expect(body.paused).toEqual([EXP]);
    expect(notify.mock.calls[0][0].message).toContain('paused');
  });

  it('never pauses a tier pool: its experiment row is not an operator-run experiment', async () => {
    running = [row({ kind: 'tier_pool' })];
    findingsById = { [EXP]: [{ code: 'past_duration_cap', severity: 'critical', detail: 'x' }] };
    await GET(req());
    expect(mockPause).not.toHaveBeenCalled();
  });

  it('one failing check is counted as an error and the rest still run', async () => {
    running = [row({ id: 'bad' }), row()];
    findingsById = { bad: new Error('boom'), [EXP]: [] };
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mockHealth).toHaveBeenCalledTimes(2);
    expect(recorded.find(r => r.changed !== undefined)).toMatchObject({ processed: 2, changed: 0, errors: 1 });
  });
});
