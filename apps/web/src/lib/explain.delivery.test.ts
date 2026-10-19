/**
 * explain reads where work stands from the delivery (docs/specs/workflow-kernel-library.md §7).
 *
 * - AC-25: a mission whose epoch merged and has no other open work is not "stalled".
 * - AC-26: a worker row that says merged while the delivery says in review: explain
 *   shows the delivery's state and flags the disagreement as a because[] link.
 *
 * The database is mocked at the query layer; the kernel reads (delivery views,
 * mission epochs) go through `db.execute`, answered by the statement's marker.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import * as actualDrizzle from 'drizzle-orm';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let missionRow: Row | null = null;
let taskRows: Row[] = [];
let deliveryRows: Row[] = [];
let epochRows: Row[] = [];
let completionDecision: Row = { ok: true, code: 'ok', reason: 'clear' };
const dialect = new PgDialect();

const mockExecute = mock(async (q: unknown) => {
  const text = dialect.sqlToQuery(q as Parameters<PgDialect['sqlToQuery']>[0]).sql;
  if (text.includes('-- workflow:delivery_views')) return { rows: deliveryRows };
  if (text.includes('-- workflow:mission_epochs')) return { rows: epochRows };
  return { rows: [] };
});

mock.module('@buildd/core/db', () => ({
  db: {
    execute: mockExecute,
    query: {
      missions: { findFirst: mock(async () => missionRow ?? undefined), findMany: mock(async () => (missionRow ? [missionRow] : [])) },
      workspaces: { findFirst: mock(async () => ({ id: 'ws-1', teamId: 'team-1', accessMode: 'open', gitConfig: { executor: 'cloud' } })) },
      tasks: {
        findFirst: mock(async (args: Row) => taskRows.find(t => t.id === args?.where?.value) ?? undefined),
        findMany: mock(async (args: Row) => {
          const where = args?.where ?? {};
          if (where.field === 'parentTaskId') return taskRows.filter(t => (where.type === 'inArray' ? (where.value as string[]).includes(t.parentTaskId) : t.parentTaskId === where.value));
          if (where.field === 'id' && where.type === 'inArray') return taskRows.filter(t => (where.value as string[]).includes(t.id));
          if (where.field === 'missionId') return taskRows.filter(t => t.missionId === where.value);
          return taskRows;
        }),
      },
      workers: { findMany: mock(async () => []) },
      gateEvents: { findMany: mock(async () => []) },
    },
  },
}));
mock.module('@buildd/core/dispatch-outbox', () => ({ latestDispatchForTask: mock(async () => null) }));
mock.module('@buildd/core/db/schema', () => ({
  workspaces: { id: 'id' },
  missions: { id: 'id', workspaceId: 'workspaceId', status: 'status' },
  tasks: { id: 'id', missionId: 'missionId', parentTaskId: 'parentTaskId', workspaceId: 'workspaceId', status: 'status' },
  workers: { id: 'id', workspaceId: 'workspaceId', prBaseRef: 'prBaseRef', mergedAt: 'mergedAt', startedAt: 'startedAt' },
  gateEvents: { taskId: 'taskId', occurredAt: 'occurredAt' },
}));
// Captured before the mock replaces the module's bindings: the kernel reads build real SQL.
const realSql = actualDrizzle.sql;
mock.module('drizzle-orm', () => ({
  sql: realSql,
  and: (...c: Row[]) => ({ type: 'and', c }),
  eq: (field: string, value: unknown) => ({ type: 'eq', field, value }),
  gt: (field: string, value: unknown) => ({ type: 'gt', field, value }),
  ne: (field: string, value: unknown) => ({ type: 'ne', field, value }),
  inArray: (field: string, value: unknown) => ({ type: 'inArray', field, value }),
  isNotNull: (field: string) => ({ type: 'isNotNull', field }),
  desc: (field: string) => ({ type: 'desc', field }),
}));
mock.module('@/lib/mission-completion', () => ({ canCompleteMission: mock(async () => completionDecision) }));
mock.module('@/lib/mission-pr', () => ({ evaluateMissionWorkState: mock(async () => null) }));
mock.module('@/lib/runner-heartbeats', () => ({ loadBrowserRunnerHeartbeats: mock(async () => []) }));

// Imported AFTER the mocks (as explain.test.ts does).
import { explainMission, explainPr, explainTask } from './explain';

const MERGED_AT = new Date('2026-10-01T00:00:00.000Z');

function task(over: Partial<Row> = {}): Row {
  return {
    id: 'task-1', title: 'Wire the route', status: 'completed', mode: 'execution', kind: 'engineering', taskClass: 'work',
    parentTaskId: null, workspaceId: 'ws-1', missionId: 'mission-1', creationSource: null, category: null, pathManifest: null,
    context: null, startAt: null, loopConfig: null, loopState: null, result: null, roleSlug: null, subjectPrNumber: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z'), dependsOn: null, workers: [], ...over,
  };
}
function worker(over: Partial<Row> = {}): Row {
  return {
    id: 'worker-1', status: 'completed', prNumber: null, prUrl: null, branch: null, prBaseRef: null, prLifecycleStatus: null,
    mergedAt: null, observedTouches: null, error: null, startedAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'), completedAt: null, supersededByPrNumber: null, supersededByPrUrl: null,
    supersededReason: null, abandonedAt: null, abandonedReason: null, supersessionScan: null, waitingFor: null, ...over,
  };
}
/** A raw `deliveryViewsSql` row. */
function deliveryRow(ownerTaskId: string, prNumber: number, state: string, over: Row = {}): Row {
  return {
    delivery: {
      id: `d-${ownerTaskId}`, workspace_id: 'ws-1', owner_task_id: ownerTaskId, repo_full_name: 'acme/app', pr_number: prNumber,
      base_ref: 'dev', state, version: 4, current_head_sha: 'H1', current_round: 1, max_rounds: 3, approved_heads: [], composition_heads: [],
      merged_at: state === 'MERGED' ? MERGED_AT.toISOString() : null, ...over,
    },
    rounds: [{ id: 'r1', round: 1, head_sha: 'H1', kind: 'full', status: state === 'AWAITING_REVIEW' ? 'queued' : 'decided', verdict: null, effective_verdict: null, failure_count: 0 }],
    attempts: [], findings: [],
    last_transition: { command: 'ReviewRequested', from_state: 'WORKING', to_state: state, evidence: {}, created_at: '2026-10-01T00:00:00.000Z' },
    attempt_tasks: [{ id: ownerTaskId, role: 'owner', status: 'completed', created_at: '2026-01-01T00:00:00.000Z' }],
    remediation: null, lane_wait: null, workspace: null, owner_task: null,
  };
}

beforeEach(() => {
  missionRow = null;
  taskRows = [];
  deliveryRows = [];
  epochRows = [];
  completionDecision = { ok: true, code: 'ok', reason: 'clear' };
});

describe('AC-25: a mission whose epoch merged with no other open work is not stalled', () => {
  beforeEach(() => {
    missionRow = { id: 'mission-1', title: 'Ship auth', workspaceId: 'ws-1', status: 'active', schedule: null, integrationBranchEnabled: true, workingBranch: 'mission/auth' };
    taskRows = [
      task({ id: 'build', workers: [worker({ id: 'wb', prNumber: 11, prUrl: 'https://github.com/acme/app/pull/11', prBaseRef: 'mission/auth', mergedAt: MERGED_AT, prLifecycleStatus: 'merged' })] }),
      // The mission PR owner. Its worker row was never stamped merged; the delivery and its epoch were.
      task({ id: 'ship', title: 'Ship mission: Ship auth', taskClass: 'bookkeeping', kind: 'coordination', status: 'completed',
        workers: [worker({ id: 'ws', prNumber: 50, prUrl: 'https://github.com/acme/app/pull/50', prBaseRef: 'dev', prLifecycleStatus: 'ci_green' })] }),
    ];
    deliveryRows = [deliveryRow('ship', 50, 'MERGED')];
    epochRows = [{ id: 'e1', mission_id: 'mission-1', epoch: 1, branch: 'mission/auth', state: 'merged', version: 3, origin: 'cut', scope_version: 1, repo_full_name: 'acme/app', pr_number: 50, owner_task_id: 'ship', merged_at: MERGED_AT.toISOString() }];
  });

  it('reads neither stalled nor waiting on a merge', async () => {
    const answer = (await explainMission('mission-1'))!.subjects[0]!;
    expect(answer.displayState).not.toBe('stalled');
    expect(answer.state).not.toBe('blocked');
    const said = JSON.stringify([answer.waitingOn, answer.situation, answer.because.map(b => b.claim)]);
    expect(said).not.toMatch(/stalled|No agent is working/i);
    expect(said).not.toMatch(/mission PR has not merged|ready to merge|waiting on you to merge/i);
    expect(answer.state).not.toBe('awaiting_merge');
    expect((answer.waitingOn as { kind?: string } | null)?.kind).not.toBe('merge');
  });

  it('even with a deliverable whose worker row was not stamped, the merged delivery is not unmerged work', async () => {
    taskRows[0] = task({ id: 'build', workers: [worker({ id: 'wb', prNumber: 11, prUrl: 'https://github.com/acme/app/pull/11', prBaseRef: 'mission/auth', prLifecycleStatus: 'ci_green' })] });
    deliveryRows.push(deliveryRow('build', 11, 'MERGED'));
    const answer = (await explainMission('mission-1'))!.subjects[0]!;
    expect(answer.displayState).not.toBe('stalled');
    expect(JSON.stringify(answer.because)).not.toMatch(/#11 has not merged/);
  });
});

describe('AC-26: a worker row that says merged, a delivery that says in review', () => {
  beforeEach(() => {
    taskRows = [task({ id: 'task-1', missionId: null, workers: [worker({ prNumber: 7, prUrl: 'https://github.com/acme/app/pull/7', mergedAt: MERGED_AT, prLifecycleStatus: 'merged' })] })];
    deliveryRows = [deliveryRow('task-1', 7, 'AWAITING_REVIEW')];
  });

  it('explain on the task shows the delivery\'s state and links the disagreement', async () => {
    const answer = (await explainTask('task-1', { userId: 'u' }))!.subjects[0]!;
    expect(answer.delivery).toMatchObject({ state: 'AWAITING_REVIEW' });
    expect(answer.state).not.toBe('completed');
    const link = answer.because.find(b => b.derivedFrom === 'DeliveryView.state vs workers.mergedAt');
    expect(link).toBeDefined();
    expect(link!.claim).toContain('PR #7');
    // Plain words: never the raw state name.
    expect(link!.claim).toBe("PR #7 is in review (Review queued), but the worker's own record says merged. This answer follows the PR's review state.");
    expect(link!.claim).not.toMatch(/AWAITING_REVIEW|delivery/);
    expect(link!.refs).toMatchObject({ taskId: 'task-1', prNumber: 7 });
  });

  it('explain on the mission links it too, and does not count the PR as shipped', async () => {
    missionRow = { id: 'mission-1', title: 'Auth', workspaceId: 'ws-1', status: 'active', schedule: null };
    taskRows = [task({ id: 'task-1', workers: [worker({ prNumber: 7, prUrl: 'https://github.com/acme/app/pull/7', mergedAt: MERGED_AT, prLifecycleStatus: 'merged' })] })];
    completionDecision = { ok: false, code: 'awaiting_merge', reason: 'PR #7 has not merged', awaitingMerge: 1, awaitingMergeDetails: [{ taskId: 'task-1', title: 'Wire the route', prNumber: 7, prUrl: 'https://github.com/acme/app/pull/7' }] };
    const answer = (await explainMission('mission-1'))!.subjects[0]!;
    const link = answer.because.find(b => b.derivedFrom === 'DeliveryView.state vs workers.mergedAt');
    expect(link?.refs).toMatchObject({ taskId: 'task-1', prNumber: 7 });
    expect(answer.displayState).not.toBe('complete');
  });

  it('a worker row and delivery that agree add no link', async () => {
    taskRows[0]!.workers[0] = worker({ prNumber: 7, prUrl: 'https://github.com/acme/app/pull/7', prLifecycleStatus: 'pr_open' });
    const answer = (await explainTask('task-1', { userId: 'u' }))!.subjects[0]!;
    expect(answer.because.some(b => b.derivedFrom === 'DeliveryView.state vs workers.mergedAt')).toBe(false);
  });
});

/**
 * Task fa37ed4b (#4996): a PR resolves to its newest worker, which is the last
 * review-fix attempt's. That attempt owns no delivery, so explain read its
 * worker columns (completed, PR unmerged) as "ready to merge" while the kernel
 * held the PR ESCALATED after a third request for changes.
 */
describe('a fix attempt of a delivery whose latest verdict is request-changes is never ready to merge', () => {
  const PR = 42;
  const prUrl = `https://github.com/acme/app/pull/${PR}`;
  const rc = (round: number, head: string) => ({
    id: `r${round}`, round, head_sha: head, kind: 'full', status: 'decided', verdict: 'request_changes', effective_verdict: 'request_changes', failure_count: 0,
  });

  beforeEach(() => {
    missionRow = { id: 'mission-1', title: 'Kernel', workspaceId: 'ws-1', status: 'active', schedule: null };
    taskRows = [
      task({ id: 'owner', workers: [worker({ id: 'wo', prNumber: PR, prUrl, prLifecycleStatus: 'pr_open' })] }),
      task({ id: 'fix', title: '[builder · after review #2] Wire the route', taskClass: 'attempt', parentTaskId: 'owner',
        workers: [worker({ id: 'wf', prNumber: PR, prUrl, prLifecycleStatus: 'pr_open' })] }),
    ];
    const row = deliveryRow('owner', PR, 'ESCALATED', { state_reason: 'review_exhausted', current_round: 3, current_head_sha: 'H3' });
    row.rounds = [rc(1, 'H1'), rc(2, 'H2'), rc(3, 'H3')];
    row.last_transition = { command: 'ReviewVerdictRecorded', from_state: 'AWAITING_REVIEW', to_state: 'ESCALATED', evidence: {}, created_at: '2026-10-17T13:38:18.043Z' };
    row.attempt_tasks = [
      { id: 'owner', role: 'owner', status: 'completed', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'fix', role: 'fix', status: 'completed', created_at: '2026-01-02T00:00:00.000Z' },
    ];
    deliveryRows = [row];
  });

  const notReady = (answer: { state: string; waitingOn: unknown; situation: unknown; because: Array<{ claim: string }> }) => {
    expect(answer.state).not.toBe('awaiting_merge');
    expect((answer.waitingOn as { kind?: string } | null)?.kind).not.toBe('merge');
    expect(JSON.stringify([answer.waitingOn, answer.situation, answer.because.map(b => b.claim)])).not.toMatch(/ready to merge|has not merged/i);
  };

  it('explain on the attempt reads its PR from the delivery', async () => {
    const answer = (await explainTask('fix', { userId: 'u' }))!.subjects[0]!;
    notReady(answer);
    expect(answer.delivery).toMatchObject({ state: 'ESCALATED', needsYou: true });
  });

  it('explain on the PR answers for the delivery owner, not the attempt its newest worker ran', async () => {
    const answer = (await explainPr({
      id: 'wf', taskId: 'fix', workspaceId: 'ws-1', prNumber: PR, prUrl, branch: null, prBaseRef: 'dev', prLifecycleStatus: 'pr_open',
      conflictDetectedAt: null, prOpenedBaseSha: null, mergedAt: null, observedTouches: null, createdAt: null,
    }, { userId: 'u' }))!.subjects[0]!;
    notReady(answer);
    expect(answer.subject).toMatchObject({ scope: 'pr', id: String(PR), taskId: 'owner', prNumber: PR });
    expect(answer.delivery).toMatchObject({ state: 'ESCALATED', needsYou: true });
  });

  it('the owner itself still reads the escalation', async () => {
    const answer = (await explainTask('owner', { userId: 'u' }))!.subjects[0]!;
    notReady(answer);
    expect(answer.delivery).toMatchObject({ state: 'ESCALATED' });
  });
});
