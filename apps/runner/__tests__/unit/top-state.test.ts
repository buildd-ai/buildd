/**
 * `buildd top` state: the reducer folds socket events in, and the derived
 * missions pane and row groups say what the runner holds and why the rest waits.
 */
import { describe, expect, test } from 'bun:test';
import {
  NO_MISSION, eventChangesQueue, missionRows, planOf, reduce, taskRows, waitingReason, type TopState,
} from '../../src/top/state';
import { NOW, TASKS, WORKERS, fixtureState } from './top-fixture';

const rowsByTitle = (s: TopState) => Object.fromEntries(taskRows(s, NOW).map(r => [r.title, r]));

describe('reducer', () => {
  test('init merges active workers and marks the runner online', () => {
    let s = fixtureState();
    s = reduce(s, { type: 'connection', online: false });
    s = reduce(s, { type: 'init', workers: [{ ...WORKERS[1], currentAction: 'Read a.ts' }], config: { maxConcurrent: 4 } });
    expect(s.runner.online).toBe(true);
    expect(s.runner.maxConcurrent).toBe(4);
    expect(s.workers['w-single'].currentAction).toBe('Read a.ts');
    expect(s.workers['w-name']).toBeDefined();
  });

  test('a claimed task appears under running from one worker_update, no refetch needed (AC-2)', () => {
    let s: TopState = { ...fixtureState(), selectedMission: NO_MISSION };
    expect(rowsByTitle(s)['fix flaky test'].group).toBe('waiting');
    const ev = { type: 'worker_update', worker: { id: 'w-new', taskId: 't-loose', taskTitle: 'fix flaky test', status: 'working' as const, startedAt: NOW, currentAction: 'Read flaky.test.ts' } };
    expect(eventChangesQueue(s, ev)).toBe(true);
    s = reduce(s, ev);
    const row = rowsByTitle(s)['fix flaky test'];
    expect(row.group).toBe('running');
    expect(row.action).toBe('Read flaky.test.ts');
  });

  test('a refused claim is kept as the reason, and cleared once a worker starts', () => {
    let s = reduce(fixtureState(), { type: 'claim_rejected', taskId: 't-loose', status: 409, reason: 'path overlap with another task' });
    s = { ...s, selectedMission: NO_MISSION };
    expect(rowsByTitle(s)['fix flaky test'].reason).toBe('refused: path overlap with another task');
    s = reduce(s, { type: 'worker_update', worker: { id: 'w2', taskId: 't-loose', taskTitle: 'fix flaky test', status: 'working', startedAt: NOW } });
    expect(s.claimRefusals['t-loose']).toBeUndefined();
  });

  test('which events refetch the task list', () => {
    const s = fixtureState();
    expect(eventChangesQueue(s, { type: 'task_assigned' })).toBe(true);
    expect(eventChangesQueue(s, { type: 'claim_rejected', taskId: 'x' })).toBe(true);
    expect(eventChangesQueue(s, { type: 'worker_update', worker: { ...WORKERS[0], currentAction: 'other' } })).toBe(false);
    expect(eventChangesQueue(s, { type: 'worker_update', worker: { ...WORKERS[0], status: 'done' } })).toBe(true);
    expect(eventChangesQueue(s, { type: 'output', workerId: 'w-name', line: 'x' })).toBe(false);
  });

  test('unknown frames leave state alone', () => {
    const s = fixtureState();
    expect(reduce(s, { type: 'version_info', latestCommit: 'abc' })).toBe(s);
  });
});

describe('missions pane (R-2)', () => {
  test('missions with work, done/total, (no mission) last; a person-run mission is left out', () => {
    const rows = missionRows(fixtureState());
    expect(rows.map(r => [r.title, `${r.done}/${r.total}`])).toEqual([
      ['Runner TUI', '2/8'],
      ['Specs import', '1/2'],
      ['(no mission)', '0/1'],
    ]);
  });

  test('(no mission) is there even with no loose tasks', () => {
    const s = reduce(fixtureState(), { type: 'tasks', tasks: TASKS.filter(t => t.missionId) });
    expect(missionRows(s).at(-1)).toMatchObject({ key: NO_MISSION, total: 0 });
  });

  test('--mission selects by id or id prefix', () => {
    const s = { ...fixtureState(), selectedMission: 'm-spec' };
    expect(taskRows(s, NOW).map(r => r.title)).toEqual(['import repo specs', 'area cards']);
  });
});

describe('rows (R-3)', () => {
  test('groups: running (incl. asking), waiting, done today; yesterday drops out', () => {
    const rows = taskRows(fixtureState(), NOW);
    expect(rows.map(r => [r.group, r.kind, r.title])).toEqual([
      ['running', 'running', 'name override'],
      ['running', 'asking', 'installer hint'],
      ['running', 'running', 'single instance'],
      ['waiting', 'waiting', 'buildd top'],
      ['waiting', 'waiting', 'docs page'],
      ['waiting', 'waiting', 'heartbeat name'],
      ['done', 'done', 'spec draft'],
    ]);
  });

  test('an asking row carries the question itself, not a label', () => {
    const r = rowsByTitle(fixtureState())['installer hint'];
    expect(r.question).toBe('Print the URL or open the browser?');
  });

  test('running rows: role, elapsed, current action, tokens', () => {
    expect(rowsByTitle(fixtureState())['name override']).toMatchObject({
      role: 'Builder', elapsedMs: 12 * 60_000, action: 'Edit config.ts', tokens: 41_200, workerId: 'w-name',
    });
  });

  test('waiting reasons in words', () => {
    const r = rowsByTitle(fixtureState());
    expect(r['buildd top'].reason).toBe('waits on: name override');
    expect(r['docs page'].reason).toBe('starts in 2h');
    expect(r['heartbeat name'].reason).toBe('another runner has it');
    const spec = { ...fixtureState(), selectedMission: 'm-spec-0000-0000' };
    expect(rowsByTitle(spec)['import repo specs'].reason).toBe('mission is on hold');
  });

  test('a full runner, and room to start', () => {
    const s = fixtureState();
    const loose = TASKS.find(t => t.id === 't-loose')!;
    expect(waitingReason(loose, s, NOW)).toBe('ready, next claim picks it up');
    const full = reduce(s, { type: 'config', maxConcurrent: 2 });
    expect(waitingReason(loose, full, NOW)).toBe('runner is full (2 of 2 busy)');
  });

  test('a dependency that is done no longer holds the task', () => {
    const s = reduce(fixtureState(), { type: 'tasks', tasks: TASKS.map(t => t.id === 't-name' ? { ...t, status: 'completed' } : t) });
    expect(waitingReason(TASKS.find(t => t.id === 't-top')!, s, NOW)).not.toMatch(/waits on/);
  });

  test('a paused worker reads as paused, and a worker with a PR reads as in review once done', () => {
    let s = reduce(fixtureState(), { type: 'worker_update', worker: { ...WORKERS[1], status: 'waiting', waitingFor: { type: 'pause', prompt: 'Paused' } } });
    expect(rowsByTitle(s)['single instance']).toMatchObject({ kind: 'paused', reason: 'paused, a resumes it' });
    s = reduce(s, { type: 'worker_update', worker: { ...WORKERS[0], status: 'done', completedAt: NOW - 60_000 } });
    expect(rowsByTitle(s)['name override']).toMatchObject({ group: 'done', kind: 'review', reason: 'PR open example/repo/pull/12' });
  });

  test('the filter narrows rows by title', () => {
    const s = { ...fixtureState(), filter: 'DOCS' };
    expect(taskRows(s, NOW).map(r => r.title)).toEqual(['docs page']);
  });
});

test('plan comes from the latest TodoWrite', () => {
  expect(planOf(fixtureState().workers['w-name']).map(p => p.status)).toEqual(['completed', 'in_progress', 'pending']);
  expect(planOf(undefined)).toEqual([]);
});
