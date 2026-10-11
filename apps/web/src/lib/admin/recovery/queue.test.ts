/**
 * The recovery panel over synthetic facts (operator-recovery §3, §5, §7.1,
 * §10; fixtures F-1, F-4, F-11). No database: the loader's batched reads are
 * stood in for by `facts()`. Names are synthetic (team-a, mission-qa-1).
 */
import { describe, it, expect } from 'bun:test';
import type { FailureIncidentRecovery } from '@buildd/shared';
import { buildRecoveryCauseDetail, buildRecoveryPanel, type QueueFacts, type QueueIncident } from './queue';
import { DEFAULT_RECOVERY_POLICY } from './automation';

const NOW = '2026-10-11T12:00:00.000Z';
const H = 3_600_000;
const ago = (h: number) => new Date(Date.parse(NOW) - h * H).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TEAM_A = id(901), TEAM_B = id(902);
const WS_A = id(801), WS_B = id(802), WS_C = id(803);

function recovery(over: Partial<FailureIncidentRecovery> = {}): FailureIncidentRecovery {
  return {
    v: 1, generation: 1, cause: { reasonCode: 'repeated_failure.same_signature', rule: 'repeated_failure', ownership: 'infrastructure' },
    subjects: [], blockers: [], overlappingPaths: [],
    observation: { observedAt: ago(0.1), source: 'sweep', evidenceRevision: 'r' },
    firstSeenAt: ago(5), lastSeenAt: ago(0.1), lastProgressAt: null, owner: 'buildd', state: 'waiting',
    nextAction: { kind: 'wait', label: 'Waiting for the fix to land. Buildd checks again at 12:20.', key: 'k' },
    nextCheckAt: ago(-0.3), verification: { predicate: 'p', params: {} },
    budget: { spent: 0, limit: 3, deadlineAt: ago(-6), spentKeys: [] }, attempts: [],
    ...over,
  };
}

function incident(n: number, over: Partial<QueueIncident> = {}): QueueIncident {
  const ws = over.workspaceId === undefined ? WS_A : over.workspaceId;
  return {
    id: id(n), version: 3, workspaceId: ws, signature: `repeated_failure|ws=${ws}|scrub-immutable`, detectorVersion: 'fps-v2',
    rule: 'repeated_failure', reasonCode: 'repeated_failure.same_signature', title: 'Visual checks fail when the test copy is cleaned',
    severity: 'high', status: 'open', firstSeenAt: ago(5), lastSeenAt: ago(0.5), occurrenceCount: 3, recurrenceCount: 0,
    affectedRefs: { taskIds: [], workerIds: [], prNumbers: [] }, evidenceRefs: [], impact: {},
    lastAlertedAt: null, lastAlertSeverity: null, linkedFixTaskId: null, acknowledgedAt: null, resolvedAt: null,
    recovery: recovery(), ...over,
  };
}

function facts(incidents: QueueIncident[], over: Partial<QueueFacts> = {}): QueueFacts {
  const tasks = new Map<string, any>();
  for (let n = 1; n <= 40; n++) tasks.set(id(n), { id: id(n), title: `task-${n}`, status: 'pending', workspaceId: n <= 20 ? WS_A : n <= 30 ? WS_B : WS_C, missionId: id(700 + (n % 3)) });
  return {
    now: NOW, window: '7d', platformWide: true, incidents,
    workspaces: new Map([[WS_A, { id: WS_A, name: 'repo-a', teamId: TEAM_A }], [WS_B, { id: WS_B, name: 'repo-b', teamId: TEAM_A }], [WS_C, { id: WS_C, name: 'repo-c', teamId: TEAM_B }]]),
    teams: new Map([[TEAM_A, { id: TEAM_A, name: 'team-a' }], [TEAM_B, { id: TEAM_B, name: 'team-b' }]]),
    tasks,
    missions: new Map([0, 1, 2].map(k => [id(700 + k), { id: id(700 + k), title: `mission-qa-${k + 1}`, workspaceId: WS_A }])),
    workers: [], prTasks: new Map(), fixPrs: new Map(), attempts: [],
    lastRun: { startedAt: ago(0.2), finishedAt: ago(0.1), full: true, workspaces: 3, runFailures: 0, incidentsAssessed: 1, recoveryRepairs: 0 },
    personVerdicts: new Set(),
    automation: { paused: { platform: false, rules: [], causes: [] }, readError: false, policy: DEFAULT_RECOVERY_POLICY, model: { spentUsdToday: 0, callsToday: 0, breakerOpenUntil: null } },
    ...over,
  };
}

describe('one cause across workspaces and teams (F-1, R2)', () => {
  const three = [
    incident(101, { workspaceId: WS_A, affectedRefs: { taskIds: [id(1)], workerIds: [], prNumbers: [] }, recovery: recovery({ subjects: [{ kind: 'task', id: id(1) }] }) }),
    incident(102, { workspaceId: WS_B, affectedRefs: { taskIds: [id(21)], workerIds: [], prNumbers: [] }, recovery: recovery({ subjects: [{ kind: 'task', id: id(21) }] }) }),
    incident(103, { workspaceId: WS_C, affectedRefs: { taskIds: [id(31)], workerIds: [], prNumbers: [] }, recovery: recovery({ subjects: [{ kind: 'task', id: id(31) }] }) }),
  ];

  it('is one row naming every team, workspace and mission, not three', () => {
    const panel = buildRecoveryPanel(facts(three));
    expect(panel.causes).toHaveLength(1);
    const row = panel.causes[0];
    expect(row.impact.teams.map(t => t.name)).toEqual(['team-a', 'team-b']);
    expect(row.impact.workspaces.map(w => w.name)).toEqual(['repo-a', 'repo-b', 'repo-c']);
    expect(row.impact.missions.length).toBeGreaterThan(0);
    expect(row.impact.tasks.count).toBe(3);
    expect(row.causeKey).toMatch(/^c1:[0-9a-f]{20}$/);
    expect(panel.totals.causes).toBe(1);
  });

  it('state, owner and sentence are the stored assessment’s (R5)', () => {
    const row = buildRecoveryPanel(facts(three)).causes[0];
    expect(row.state).toBe('waiting');
    expect(row.owner).toBe('buildd');
    expect(row.sentence).toBe('Waiting for the fix to land. Buildd checks again at 12:20.');
    expect(row.actions).toEqual([]);
  });

  it('a team-scoped read never names another team', () => {
    const scoped = three.filter(i => i.workspaceId !== WS_C);
    const panel = buildRecoveryPanel(facts(scoped, { platformWide: false }));
    const json = JSON.stringify(panel);
    expect(json).not.toContain('team-b');
    expect(json).not.toContain(TEAM_B);
    expect(json).not.toContain('repo-c');
  });

  it('a scoped read leaves out platform incidents that belong to no workspace', () => {
    const selfHealth = incident(199, { workspaceId: null, signature: 'repeated_failure|ws=none|sentinel_self_health_degraded', severity: 'critical' });
    expect(buildRecoveryPanel(facts([...three, selfHealth], { platformWide: false })).causes).toHaveLength(1);
    const platform = buildRecoveryPanel(facts([...three, selfHealth]));
    expect(platform.causes).toHaveLength(2);
    expect(platform.causes[0].rank.tier).toBe(0);
  });
});

describe('F-4: evidence unavailable', () => {
  it('is inconclusive, incomplete, never below Active, with what is missing named', () => {
    const inc = incident(201, {
      rule: 'path_overlap_stall', signature: `path_overlap_stall|ws=${WS_A}|blocker=pr:12`, reasonCode: 'path_overlap.no_progress',
      affectedRefs: { taskIds: [id(2)], workerIds: [], prNumbers: [12] },
      recovery: recovery({
        state: 'inconclusive', cause: { reasonCode: 'path_overlap.blocker_open', rule: 'path_overlap_stall', ownership: 'workflow' },
        subjects: [{ kind: 'task', id: id(2) }], blockers: [{ kind: 'pr', id: '12', state: 'open', observedAt: ago(3) }],
        nextAction: { kind: 'recheck', label: "Buildd couldn't confirm this is still happening.", key: 'k' },
      }),
    });
    const panel = buildRecoveryPanel(facts([inc], { workers: null }));
    const row = panel.causes[0];
    expect(row.state).toBe('inconclusive');
    expect(row.telemetry.completeness).toBeLessThan(1);
    expect(row.telemetry.missing).toEqual(expect.arrayContaining(['pr_projection', 'cost_rows']));
    expect(row.rank.tier).toBeLessThanOrEqual(2);
    expect(row.impact.blockedTaskHours24h.atLeast).toBe(true);
    expect(panel.totals.evidenceMissing).toBe(1);
    expect(JSON.stringify(row)).not.toMatch(/\b(fixed|resolved|recovered)\b/i);
  });

  it('a sweep more than an hour behind makes every open cause stale', () => {
    const panel = buildRecoveryPanel(facts([incident(202)], { lastRun: { startedAt: ago(3), finishedAt: ago(2), full: true, workspaces: 1, runFailures: 0, incidentsAssessed: 0, recoveryRepairs: 0 } }));
    expect(panel.causes[0].telemetry.freshness.state).toBe('stale');
    expect(panel.causes[0].telemetry.missing).toContain('sweep_last_run');
    expect(panel.telemetry.telemetryLag.state).toBe('stale');
  });
});

describe('F-11: cascade across causes', () => {
  // Cause A (path overlap behind PR 12) blocks t1..t4; t1 holds PR 13, behind which t5..t7 wait under cause B.
  const prTasks = new Map([[`${WS_A}:12`, id(40)], [`${WS_A}:13`, id(1)]]);
  const overlap = (n: number, pr: number, subjects: number[], startH: number) => incident(n, {
    rule: 'path_overlap_stall', signature: `path_overlap_stall|ws=${WS_A}|blocker=pr:${pr}`, reasonCode: 'path_overlap.no_progress',
    affectedRefs: { taskIds: subjects.map(id), workerIds: [], prNumbers: [pr] },
    recovery: recovery({
      cause: { reasonCode: 'path_overlap.blocker_open', rule: 'path_overlap_stall', ownership: 'workflow' },
      subjects: subjects.map(s => ({ kind: 'task' as const, id: id(s) })), firstSeenAt: ago(startH),
      blockers: [{ kind: 'pr', id: String(pr), state: 'open', observedAt: ago(0.1) }],
    }),
  });
  const a = overlap(301, 12, [1, 2, 3, 4], 6);
  const b = overlap(302, 13, [5, 6, 7], 3);

  it('counts B’s hours once, for A; A unblocks 7; the total equals the sum (OR-4)', () => {
    const panel = buildRecoveryPanel(facts([a, b], { prTasks }));
    const rowA = panel.causes.find(r => r.impact.tasks.count === 4)!;
    const rowB = panel.causes.find(r => r.impact.tasks.count === 3)!;
    expect(rowA.impact.blockedTaskHours24h.value).toBeCloseTo(4 * 6 + 3 * 3, 0);
    expect(rowB.impact.blockedTaskHours24h.value).toBe(0);
    expect(rowB.impact.waitsBehind).toEqual({ causeKey: rowA.causeKey, tasks: 3 });
    expect(rowA.impact.unblocks.tasks).toBe(7);
    const sum = panel.causes.reduce((s, r) => s + (r.impact.blockedTaskHours24h.value ?? 0), 0);
    expect(panel.totals.blockedTaskHours24h.value).toBeCloseTo(sum, 0);
    expect(panel.totals.blockedNow).toBe(7);
    expect(rowA.rank.position).toBe(1);
  });

  it('the drill-down attributes B’s episodes to A', () => {
    const f = facts([a, b], { prTasks });
    const keyB = buildRecoveryPanel(f).causes.find(r => r.impact.tasks.count === 3)!.causeKey;
    const keyA = buildRecoveryPanel(f).causes.find(r => r.impact.tasks.count === 4)!.causeKey;
    const detail = buildRecoveryCauseDetail(f, keyB, { decisions: [], audit: [], notifications: { delivered: 0, suppressed: 0, lastDeliveredAt: null }, verdicts: new Map() })!;
    expect(detail.episodes).toHaveLength(3);
    expect(detail.episodes.every(e => e.attributedTo === keyA)).toBe(true);
    expect(detail.incidents[0].team.name).toBe('team-a');
  });
});

describe('attempts, waste and recovered causes', () => {
  it('tallies attempt events by verify outcome and measures waste from real cost only', () => {
    const inc = incident(401, { affectedRefs: { taskIds: [id(3)], workerIds: [], prNumbers: [] }, recovery: recovery({ subjects: [{ kind: 'task', id: id(3) }], budget: { spent: 3, limit: 3, deadlineAt: ago(-1), spentKeys: [] }, state: 'needs_decision', owner: 'person', decision: { question: 'Choose one.', options: [], recommended: 'dismiss' } }) });
    const detail = (passed: boolean | null, outcome = 'accepted') => ({ occurredAt: ago(1), outcome, detail: {
      actionKey: `k-${passed}-${outcome}`, incidentId: id(401), causeKey: null, capability: 'wake_subject' as const, generation: 1, attempt: 1,
      subject: { kind: 'task' as const, id: id(3) }, actor: 'buildd:sweep', verify: { predicate: 'p', passed, evidenceRevision: 'r' }, costUsd: null } });
    const panel = buildRecoveryPanel(facts([inc], {
      attempts: [detail(false), detail(false), detail(true), detail(null, 'rejected')],
      workers: [
        { taskId: id(3), createdAt: ago(2), status: 'failed', costUsd: 4.1, costBasis: 'real' },
        { taskId: id(3), createdAt: ago(2), status: 'failed', costUsd: 9, costBasis: 'virtual' },
      ],
    }));
    const row = panel.causes[0];
    expect(row.repair.attempts).toEqual({ total: 4, succeeded: 1, failed: 1, noEffect: 2, inFlight: 0 });
    expect(row.repair.budget).toEqual({ spent: 3, limit: 3, exhausted: true });
    expect(row.repair.wasteUsd7d).toEqual({ value: 4.1, basis: 'measured' });
    expect(row.rank.tier).toBe(1);
    expect(panel.telemetry.repairEffectiveness.wake_subject).toEqual({ numerator: 1, denominator: 4, value: 0.25 });
    expect(panel.telemetry.autoRecoveryFailure.numerator).toBe(1);
  });

  it('a recovered cause leaves the queue and is listed under recently recovered on request', () => {
    const done = incident(501, { status: 'resolved', resolvedAt: ago(1), recovery: recovery({ state: 'recovered', firstSeenAt: ago(3), verification: { predicate: 'p', params: { summary: 'Recovered at 11:00.' } } }) });
    const panel = buildRecoveryPanel(facts([done]), { includeRecovered: true });
    expect(panel.causes).toHaveLength(0);
    expect(panel.recentlyRecovered).toHaveLength(1);
    expect(panel.recentlyRecovered![0].detectionToRecoveryMin).toBe(120);
    expect(panel.telemetry.autoRecoverySuccess).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(panel.telemetry.detectionToRecoveryMin.p50).toBe(120);
    expect(buildRecoveryPanel(facts([done])).recentlyRecovered).toBeUndefined();
    expect(buildRecoveryPanel(facts([done]), { filter: 'auto_recovered' }).causes).toHaveLength(1);
  });

  it('every rate carries its numerator and denominator; stale prompts are reported as not measured', () => {
    const t = buildRecoveryPanel(facts([incident(601)])).telemetry;
    expect(t.stalePrompts).toEqual({ numerator: null, denominator: null, value: null });
    expect(t.missing).toContain('stale_prompts');
    expect(t.autoRecoverySuccess).toEqual({ numerator: 0, denominator: 0, value: null });
  });
});
