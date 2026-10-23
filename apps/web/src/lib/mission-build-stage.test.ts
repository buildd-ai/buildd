/**
 * The Build stage as data (Navigation d25d923d R-5, R-14, AC-4, AC-14): the
 * summary line, the list order, the words per state, the merged fold and the
 * waiting groups. Illustrative rows through the real `buildMissionBoard`.
 */
import { describe, expect, it } from 'bun:test';
import { buildMissionBoard, type BoardTaskInput, type BoardWorkerInput, type MissionBoardInput } from './mission-board';
import { buildFoldLine, buildRowState, buildStage, buildSummaryLine, mergedFoldLine, WAITING_GROUP_FROM } from './mission-build-stage';

const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
const min = (n: number) => T0 + n * 60_000;
const NOW = min(120);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function worker(over: Partial<BoardWorkerInput> = {}): BoardWorkerInput {
  return {
    id: `w-${Math.random().toString(36).slice(2, 8)}`, status: 'completed', runner: 'atlas', startedAt: min(1), completedAt: min(8), updatedAt: min(8),
    mergedAt: null, prNumber: null, prUrl: null, prLifecycleStatus: null, currentAction: null, waitingFor: null, milestones: [], linesAdded: null, linesRemoved: null,
    ...over,
  };
}

function task(n: number, title: string, over: Partial<BoardTaskInput> = {}): BoardTaskInput {
  const workers = over.workers ?? [];
  const w = workers[0];
  return {
    id: id(n), title, status: 'pending', taskClass: 'work', createdAt: new Date(T0 + n * 1000), missionPhaseIndex: 1, missionPhaseLabel: 'Build',
    roleSlug: 'builder', outputRequirement: 'pr_required', workers,
    worker: w ? { status: w.status, startedAt: w.startedAt ? new Date(w.startedAt) : null, updatedAt: w.updatedAt ? new Date(w.updatedAt) : null, prNumber: w.prNumber, prUrl: w.prUrl, prLifecycleStatus: w.prLifecycleStatus, mergedAt: w.mergedAt ? new Date(w.mergedAt) : null } : null,
    ...over,
  };
}

const merged = (n: number, title: string) => task(n, title, {
  status: 'completed',
  workers: [worker({ startedAt: min(n), completedAt: min(n + 2), updatedAt: min(n + 2), mergedAt: min(n + 2), prNumber: 400 + n, prUrl: `https://example.test/pull/${400 + n}`, prLifecycleStatus: 'merged' })],
});

const DECISION = 12;
/** AC-4's mission: 11 merged, 1 running, 1 fixing, 1 needing a decision, 1 waiting on it, 1 queued. */
function sixteen(): BoardTaskInput[] {
  return [
    ...Array.from({ length: 11 }, (_, i) => merged(i + 1, `feat(runner): step ${String(i + 1).padStart(2, '0')}`)),
    task(DECISION, 'Mirror the runner image to Docker Hub', {
      status: 'in_progress',
      workers: [worker({ status: 'waiting_input', startedAt: min(100), completedAt: null, updatedAt: min(116), waitingFor: { prompt: 'How should Docker Hub credentials be set up?', options: ['Provide a token', "I'll set them myself"] } })],
    }),
    task(13, 'Redeploy keeps the dispatch token', {
      status: 'in_progress',
      workers: [worker({ status: 'running', startedAt: min(108), completedAt: null, updatedAt: min(119), currentAction: 'Writing the redeploy test', milestones: [{ ts: min(119), label: 'Writing the redeploy test' }] })],
    }),
    task(14, 'Settings shows each deploy step', {
      status: 'pending', startAt: min(120 + 232),
      workers: [worker({ status: 'completed', startedAt: min(60), completedAt: min(70), updatedAt: min(70), prNumber: 450, prUrl: 'https://example.test/pull/450', prLifecycleStatus: 'ci_failed' })],
    }),
    task(15, 'The release publishes an image digest', { dependsOn: [id(DECISION)] }),
    task(16, 'A runner bundle on every release'),
  ];
}

function board(tasks: BoardTaskInput[], over: Partial<MissionBoardInput> = {}) {
  return buildMissionBoard({ tasks, now: NOW, missionCreatedAt: T0, missionStatus: 'active', roles: [{ slug: 'builder', name: 'Builder', color: 'var(--c)' }], ...over });
}

const hrefFor = (taskId: string) => `/app/tasks/${taskId}`;
const clock = (ts: number) => { const d = new Date(ts); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

describe('buildStage over AC-4’s mission', () => {
  const stage = buildStage(board(sixteen()), NOW, { hrefFor, clock });

  it('says the counts in words, merged first', () => {
    expect(stage.summary).toBe('11 of 16 merged · 1 running · 1 fixing · 1 your decision · 2 waiting');
    expect(stage.total).toBe(16);
    expect(stage.merged.count).toBe(11);
  });

  it('leads with what needs a person, then running, fixing, waiting, queued; merged folds away', () => {
    expect(stage.rows.map(r => r.state)).toEqual(['decision', 'running', 'fixing', 'waiting', 'queued']);
    expect(stage.rows.map(r => r.title)).toEqual([
      'Mirror the runner image to Docker Hub', 'Redeploy keeps the dispatch token', 'Settings shows each deploy step',
      'The release publishes an image digest', 'A runner bundle on every release',
    ]);
    expect(stage.rows.some(r => r.state === 'merged')).toBe(false);
  });

  it('words each row as R-14 says, names and never numbers', () => {
    const [decision, running, fixing, waiting, queued] = stage.rows;
    expect(decision.line).toBe('Your decision');
    expect(decision.age).toBe('4m ago');
    expect(running.line).toBe('Running 12m · writing the redeploy test · updated 1m ago');
    expect(fixing.line).toBe('Fixing · CI failed · resumes 17:52');
    expect(waiting.line).toBe('Waiting on Mirror the runner image to Docker Hub');
    expect(queued.line).toBe('Queued 1h');
    // No task numbers: the only digits are times.
    for (const r of stage.rows) expect(r.line.replace(/\d+[hms]\b|\d\d:\d\d/g, '')).not.toMatch(/\d/);
    expect(stage.rows.every(r => r.href === `/app/tasks/${r.id}`)).toBe(true);
  });

  it('no waiting groups under twenty waiting tasks', () => {
    expect(stage.waitingGroups).toBeNull();
  });
});

describe('buildStage words', () => {
  it('an agent fixing a red PR right now reads Fixing with its attempt and clock, not Queued (R-20)', () => {
    const rows = [
      task(1, 'Settings shows each deploy step', {
        status: 'pending',
        workers: [worker({ status: 'completed', startedAt: min(60), completedAt: min(70), updatedAt: min(70), prNumber: 450, prUrl: 'https://example.test/pull/450', prLifecycleStatus: 'ci_failed' })],
      }),
      task(2, '[builder · after CI #1] Settings shows each deploy step', {
        taskClass: 'attempt', parentTaskId: id(1), status: 'in_progress',
        workers: [worker({ status: 'running', startedAt: min(116), completedAt: null, updatedAt: min(119), currentAction: 'Type check failed' })],
      }),
    ];
    const stage = buildStage(board(rows), NOW, { hrefFor, clock });
    expect(stage.rows[0].state).toBe('running');
    expect(stage.rows[0].line).toBe('Fixing · type check failed · running 4m · updated 1m ago');
    expect(stage.summary).toBe('0 of 1 merged · 1 running');
  });

  it('a failure a person must fix reads Failed with its cause', () => {
    const rows = [task(1, 'Mirror the runner image', { status: 'failed', workers: [worker({ status: 'failed', startedAt: min(1), completedAt: min(5), updatedAt: min(5) })] })];
    const stage = buildStage(board(rows), NOW, { hrefFor, clock });
    expect(stage.rows[0].state).toBe('failed');
    expect(stage.rows[0].line).toMatch(/^Failed/);
    expect(stage.summary).toBe('0 of 1 merged · 1 failed');
  });

  it('checks are never rows and never count (R-12)', () => {
    const rows = [
      merged(1, 'feat: build'),
      task(2, '[surface audit] Mission', { roleSlug: 'visual-auditor', status: 'in_progress', workers: [worker({ status: 'running', completedAt: null })] }),
    ];
    const stage = buildStage(board(rows), NOW, { hrefFor, clock });
    expect(stage.total).toBe(1);
    expect(stage.rows).toEqual([]);
    expect(stage.summary).toBe('1 of 1 merged');
  });

  it('a reopened task returns to the open rows, so the fold shrinks (AC-9)', () => {
    const reopened = task(1, 'feat: reopened', {
      status: 'in_progress',
      workers: [
        worker({ status: 'running', startedAt: min(110), completedAt: null, updatedAt: min(119) }),
        worker({ startedAt: min(1), completedAt: min(3), updatedAt: min(3), mergedAt: min(3), prNumber: 401, prLifecycleStatus: 'merged' }),
      ],
    });
    const stage = buildStage(board([reopened, merged(2, 'feat: done')]), NOW, { hrefFor, clock });
    expect(stage.merged.count).toBe(1);
    expect(stage.rows.map(r => r.state)).toEqual(['running']);
  });
});

describe('waiting groups (R-5)', () => {
  it(`from ${WAITING_GROUP_FROM} waiting tasks the rows group by what they wait on`, () => {
    const rows = [
      task(1, 'feat: the gate', { status: 'in_progress', workers: [worker({ status: 'running', completedAt: null })] }),
      task(2, 'feat: the other gate', { status: 'in_progress', workers: [worker({ status: 'running', completedAt: null })] }),
      ...Array.from({ length: WAITING_GROUP_FROM }, (_, i) => task(10 + i, `feat: follower ${i}`, { dependsOn: [id(i < 12 ? 1 : 2)] })),
    ];
    const stage = buildStage(board(rows), NOW, { hrefFor, clock });
    expect(stage.waitingGroups).not.toBeNull();
    expect(stage.waitingGroups!.map(g => g.line)).toEqual(['Waiting on feat: the gate · 12 ›', 'Waiting on feat: the other gate · 8 ›']);
    expect(stage.summary).toBe(`0 of ${WAITING_GROUP_FROM + 2} merged · 2 running · ${WAITING_GROUP_FROM} waiting`);
  });
});

describe('lines', () => {
  it('summary and fold lines', () => {
    expect(buildSummaryLine({ total: 0, merged: 0, running: 0, fixing: 0, failed: 0, decision: 0, approval: 0, waiting: 0 })).toBe('No tasks');
    expect(buildSummaryLine({ total: 10, merged: 6, running: 1, fixing: 0, failed: 0, decision: 0, approval: 1, waiting: 0 })).toBe('6 of 10 merged · 1 running · 1 approval required');
    expect(buildFoldLine(16)).toBe('16 tasks merged ›');
    expect(buildFoldLine(1)).toBe('1 task merged ›');
    expect(mergedFoldLine(11)).toBe('11 merged ›');
  });

  it('buildRowState maps the strip states', () => {
    const m = board(sixteen());
    expect(buildRowState(m, id(1))).toBe('merged');
    expect(buildRowState(m, id(DECISION))).toBe('decision');
    expect(buildRowState(m, id(15))).toBe('waiting');
    expect(buildRowState(m, id(16))).toBe('queued');
  });
});
