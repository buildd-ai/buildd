/**
 * A pending task's one wait, from the claim route's own query and gates
 * (spec: Overlap scheduling, AC-10; Health › Queue, R-5, AC-9). The pure half
 * of lib/queue-wait-load.ts: a table per reason from the claim facts (gate
 * columns, unmet dependencies, the coordination gates over the route's
 * snapshot, the mission budget, the loop's fresh ledger row) to the wait, and
 * the three shapes observed on 2026-10-22.
 */
import { describe, expect, it, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isNextInLine, queueWaitHeadline } from '@buildd/shared';

mock.module('@buildd/core/db', () => ({ db: { query: {} } }));

const { QUEUE_WAIT_GATES, queueWaitFor, queueWaitGateColumns } = await import('./queue-wait-load');
const { claimCandidateWhere } = await import('./claim-candidate-where');
const { evaluateCoordinationGates } = await import('@/app/api/workers/claim/coordination-gates');

const NOW = new Date('2026-10-22T12:00:00Z');
const at = (h: number) => new Date(NOW.getTime() + h * 3600_000);
type Task = Parameters<typeof queueWaitFor>[0];
type Facts = Parameters<typeof queueWaitFor>[1];

const PASS = Object.fromEntries(QUEUE_WAIT_GATES.map(g => [g, true])) as Task['gates'];
const task = (over: Partial<Task> = {}, refused: Array<keyof Task['gates']> = []): Task => ({
  id: 't1', workspaceId: 'ws', missionId: null, pathManifest: null, dependsOn: null, startAt: null,
  workspace: { gitConfig: null }, workspacePausedUntil: null,
  gates: { ...PASS, ...Object.fromEntries(refused.map(g => [g, false])) },
  ...over,
});
const facts = (over: Partial<Facts> = {}): Facts => ({ unmetDependencies: [], coordination: [], missionBudgetExhausted: false, ledger: null, ...over });
const ledger = (reason: string, minutesAgo = 1, detail: Record<string, unknown> = {}) => ({
  reason, occurredAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(), firstDeferredAt: at(-3).toISOString(), detail,
});

const mission = { status: 'active', maxConcurrentTasks: 1, pacingMode: 'paced' as const, pacingMaxPerHour: 12, lastTaskStartedAt: new Date(NOW.getTime() - 60_000) };
const coordination = (t: Task, over: Record<string, unknown> = {}) => evaluateCoordinationGates(t, {
  openPrTasks: [], activeClaims: null, mission: null, missionActiveCount: 0, orderedBehind: null, liveTaskIds: new Set(), now: NOW, ...over,
});
const laneMember = (taskId: string, o: Record<string, unknown> = {}) => ({
  taskId, claimableSince: at(-10), priority: 0, createdAt: at(-20), heldAt: null, holding: false, ready: true,
  status: 'pending', prNumber: null, prUrl: null, lastActivityAt: null, ...o,
});
const lanes = (members: ReturnType<typeof laneMember>[]) => ({
  views: new Map([['migration', { workspaceId: 'ws', lane: 'migration', members: members as never }]]),
  releasedTaskIds: new Set<string>(),
});

describe('the gate columns are the claim query\'s own predicates', () => {
  const dialect = new PgDialect();
  it('each column renders exactly the claim candidate WHERE gate of the same name', () => {
    const cols = queueWaitGateColumns(NOW);
    const { gates } = claimCandidateWhere({ workspaceIds: [], now: NOW, accountType: 'user', runner: null, availableSkills: [], executor: 'host' });
    for (const g of QUEUE_WAIT_GATES) {
      expect(dialect.sqlToQuery(cols[`g_${g}`]).sql).toContain(dialect.sqlToQuery(gates[g]!).sql);
    }
    // Runner-specific gates (role, cooldown, executor, preference) are the runner's, not the task's.
    expect(Object.keys(cols).sort()).toEqual(QUEUE_WAIT_GATES.map(g => `g_${g}`).sort());
  });
});

interface Row { name: string; task: Task; facts?: Facts; kind: string; extra?: Record<string, unknown>; headline: string }

const declaredTask = task({ dependsOn: ['dep-1'] }, ['deps']);
const laneTask = task({ pathManifest: ['packages/core/db/schema.ts'] });
const missionTask = task({ missionId: 'm1' });

const TABLE: Row[] = [
  {
    name: 'declared dependency (claim WHERE deps gate, named by dependencySatisfied)',
    task: declaredTask, facts: facts({ unmetDependencies: [{ id: 'dep-1', title: 'Add the index', status: 'in_progress' }] }),
    kind: 'declared', extra: { blockerId: 'dep-1', blockerStatus: 'in_progress' }, headline: 'Waiting on “Add the index”',
  },
  {
    name: 'lane position (stored lane order)',
    task: laneTask,
    facts: facts({ coordination: coordination(laneTask, { lanes: lanes([laneMember('h', { holding: true, heldAt: at(-1) }), laneMember('a', { claimableSince: at(-9) }), laneMember('t1', { claimableSince: at(-8) })]) }) }),
    kind: 'lane', extra: { lane: 'migration', position: 2, holderTaskId: 'h' }, headline: 'In the schema lane, 2nd in line',
  },
  {
    name: 'limit: mission cap',
    task: missionTask, facts: facts({ coordination: coordination(missionTask, { mission: { ...mission, pacingMode: 'eager' }, missionActiveCount: 1 }) }),
    kind: 'limit', extra: { limit: 'mission_cap' }, headline: 'Waiting: mission limit',
  },
  {
    name: 'limit: workspace paused, with when it lifts',
    task: task({ workspacePausedUntil: at(2) }, ['workspacePaused']), kind: 'limit', extra: { limit: 'workspace_paused', liftsAt: at(2).toISOString() }, headline: 'Waiting: workspace paused, lifts in 2h 00m',
  },
  {
    name: 'limit: mission budget (claim loop)',
    task: missionTask, facts: facts({ missionBudgetExhausted: true }), kind: 'limit', extra: { limit: 'mission_budget' }, headline: 'Waiting: mission budget',
  },
  {
    name: 'limit: daily budget from the loop\'s fresh row, with its reset',
    task: task(), facts: facts({ ledger: ledger('budget_paused', 2, { resetsAt: at(3).toISOString() }) }),
    kind: 'limit', extra: { limit: 'budget', liftsAt: at(3).toISOString(), forceable: false }, headline: 'Waiting: daily budget, lifts in 3h 00m',
  },
  {
    name: 'limit: plan (managed runner hours)',
    task: task(), facts: facts({ ledger: ledger('managed_runner_hours') }), kind: 'limit', extra: { limit: 'plan' }, headline: 'Waiting: plan limit',
  },
  {
    name: 'limit: seats (one Codex task per workspace)',
    task: task(), facts: facts({ ledger: ledger('codex_single_flight') }), kind: 'limit', extra: { limit: 'seats' }, headline: 'Waiting: seats in use',
  },
  {
    name: 'limit: a person paused it (claim WHERE)',
    task: task({}, ['taskHeld']), kind: 'limit', extra: { limit: 'task_paused', forceable: false }, headline: 'Waiting: paused',
  },
  {
    name: 'start time (claim WHERE)',
    task: task({ startAt: at(26) }, ['startAt']), kind: 'start_time', extra: { startAt: at(26).toISOString() }, headline: 'Starts Oct 23',
  },
  {
    name: 'free slot: no gate refuses it',
    task: task(), kind: 'slot', extra: { noRunnerReason: null }, headline: 'Ready: next in line for a runner',
  },
  {
    name: 'free slot, a stale ledger row is not an observation',
    task: task(), facts: facts({ ledger: ledger('budget_paused', 30) }), kind: 'slot', headline: 'Ready: next in line for a runner',
  },
  {
    name: 'free slot, but the loop found no runner that can take it',
    task: task(), facts: facts({ ledger: ledger('runner_capability') }), kind: 'slot', extra: { noRunnerReason: 'no online runner has what it needs' },
    headline: 'Ready, but no runner can take it: no online runner has what it needs',
  },
];

describe('queueWaitFor: a table per reason, from the claim facts', () => {
  for (const row of TABLE) {
    it(row.name, () => {
      const { wait, reasons } = queueWaitFor(row.task, row.facts ?? facts(), NOW);
      expect(wait.kind).toBe(row.kind as never);
      if (row.extra) expect(wait).toMatchObject(row.extra);
      expect(queueWaitHeadline(wait, NOW.getTime())).toBe(row.headline);
      expect(isNextInLine(wait)).toBe(row.kind === 'slot' && !wait.noRunnerReason);
      if (row.kind !== 'slot') expect(reasons.length).toBeGreaterThan(0);
    });
  }

  it('a refused gate is never ready, whatever else holds', () => {
    for (const g of QUEUE_WAIT_GATES) {
      const { wait } = queueWaitFor(task({ startAt: at(1), workspacePausedUntil: at(1) }, [g]), facts(), NOW);
      expect(isNextInLine(wait)).toBe(false);
    }
  });
});

/** The three shapes observed on 2026-10-22, read from the claim facts. */
describe('2026-10-22 regressions', () => {
  it('path_overlap about 150 times in 4.5h on a schema task: its lane and place, not next in line', () => {
    const t = task({ pathManifest: ['packages/core/drizzle/20261022_x/migration.sql'] });
    const members = ['p1', 'p2', 'p3', 'p4'].map((id, i) => laneMember(id, { claimableSince: at(-20 + i) }));
    const read = lanes([laneMember('h', { holding: true, heldAt: at(-4), prNumber: 5400 }), ...members, laneMember('t1', { claimableSince: at(-5) })]);
    const { wait } = queueWaitFor(t, facts({ coordination: coordination(t, { lanes: read }) }), NOW);
    expect(wait).toMatchObject({ kind: 'lane', lane: 'migration', position: 5, holderTaskId: 'h' });
    expect(queueWaitHeadline(wait, NOW.getTime())).toBe('In the schema lane, 5th in line');
  });

  it('a declared dependency on a running task: waiting on it, by name', () => {
    const { wait } = queueWaitFor(declaredTask, facts({ unmetDependencies: [{ id: 'dep-1', title: 'Rework claim order', status: 'in_progress' }] }), NOW);
    expect(wait).toMatchObject({ kind: 'declared', blockerStatus: 'in_progress' });
    expect(isNextInLine(wait)).toBe(false);
  });

  it('a migration overlap on unmerged work (an open PR not yet in the lane rows): the lane, held by that PR\'s task', () => {
    const t = task({ pathManifest: ['packages/core/db/schema.ts', 'apps/web/src/lib/x.ts'] });
    const openPrTasks = [{ taskId: 'unmerged', pathManifest: ['packages/core/db/schema.ts'], prNumber: 5390, prUrl: null, workerStatus: 'completed', prLifecycle: 'open', branch: 'b', prBaseRef: 'dev' }];
    const { wait } = queueWaitFor(t, facts({ coordination: coordination(t, { openPrTasks }) }), NOW);
    expect(wait).toMatchObject({ kind: 'lane', lane: 'migration', holderTaskId: 'unmerged' });
    expect(isNextInLine(wait)).toBe(false);
  });
});
