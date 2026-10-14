/**
 * `buildd top` state: the reducer folds socket events in, and the derived
 * missions pane and row groups say what the runner holds and why the rest waits.
 */
import { describe, expect, test } from 'bun:test';
import {
  NO_MISSION, currentWorkspace, cycleWorkspace, eventChangesQueue, failureReason, isOrganizerTask, missionRows,
  planOf, reduce, taskRows, waitingReason, workspaceSummary, type TopState, type TopTask,
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

  test('done/total comes from the server count, so work finished outside the list window still counts', () => {
    // The list holds active tasks and a day of finished ones (capped), so a
    // mission whose finished work is older reads as 0/2 locally. The server
    // counts every task of the mission and top shows that.
    const mission = { id: 'm-long-0000-0000', title: 'Long mission', isHeld: false, executor: 'runner', taskCounts: { done: 7, total: 9 } };
    const s = reduce(fixtureState(), { type: 'tasks', tasks: [
      ...TASKS,
      { id: 't-l1', title: 'long a', status: 'pending', missionId: mission.id, mission },
      { id: 't-l2', title: 'long b', status: 'pending', missionId: mission.id, mission },
    ] });
    expect(missionRows(s).find(r => r.key === mission.id)).toMatchObject({ done: 7, total: 9 });
    // A server without the field: the local count stands.
    expect(missionRows(s).find(r => r.title === 'Runner TUI')).toMatchObject({ done: 2, total: 8 });
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

  test('a finished task whose PR merged reads as merged, not as open', () => {
    let s = reduce(fixtureState(), { type: 'worker_update', worker: { ...WORKERS[0], status: 'done', completedAt: NOW - 60_000 } });
    s = reduce(s, { type: 'tasks', tasks: TASKS.map(t => t.id === 't-name' ? { ...t, status: 'completed', prMergedAt: new Date(NOW - 30_000).toISOString() } : t) });
    expect(rowsByTitle(s)['name override']).toMatchObject({ group: 'done', kind: 'done', reason: 'PR merged example/repo/pull/12' });
    // Merged with no local worker left (runner restarted): still merged.
    const gone = reduce(fixtureState(), { type: 'tasks', tasks: TASKS.map(t => t.id === 't-draft' ? { ...t, prMergedAt: new Date(NOW - 30_000).toISOString() } : t) });
    expect(rowsByTitle(gone)['spec draft']).toMatchObject({ kind: 'done', reason: 'PR merged' });
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

// ── revision 2: workspaces (R-19, AC-8), organizer runs and failure reasons (R-22) ──

const WS = [
  { id: 'ws-aaaa-0000', name: 'alpha', teamId: 'team-1', teamName: 'Team One' },
  { id: 'ws-bbbb-0000', name: 'bravo', teamId: 'team-1', teamName: 'Team One' },
  { id: 'ws-cccc-0000', name: 'charlie', teamId: 'team-2', teamName: 'Team Two' },
];
const MA = { id: 'm-a-000000000', title: 'Alpha mission', isHeld: false, executor: 'runner' };
const MB = { id: 'm-b-000000000', title: 'Bravo mission', isHeld: false, executor: 'runner' };
const MC = { id: 'm-c-000000000', title: 'Charlie mission', isHeld: false, executor: 'runner' };
const WS_TASKS: TopTask[] = [
  { id: 'a1', title: 'alpha work', status: 'pending', workspaceId: WS[0].id, missionId: MA.id, mission: MA, roleSlug: 'builder' },
  { id: 'b1', title: 'bravo work', status: 'pending', workspaceId: WS[1].id, missionId: MB.id, mission: MB, roleSlug: 'builder' },
  { id: 'c1', title: 'charlie work', status: 'pending', workspaceId: WS[2].id, missionId: MC.id, mission: MC, roleSlug: 'builder' },
  { id: 'c2', title: 'charlie loose', status: 'pending', workspaceId: WS[2].id, missionId: null },
];
const wsState = (): TopState => {
  let s = reduce(fixtureState(), { type: 'workers', workers: [] });
  s = reduce(s, { type: 'tasks', tasks: WS_TASKS });
  return reduce(s, { type: 'workspaces', workspaces: WS });
};

describe('workspaces (R-19, AC-8)', () => {
  test('the summary counts workspaces, and names the team when there is one', () => {
    expect(workspaceSummary(wsState())).toBe('3 workspaces · 2 teams');
    const one = reduce(wsState(), { type: 'workspaces', workspaces: WS.slice(0, 2) });
    expect(workspaceSummary(one)).toBe('2 workspaces · Team One');
    const single = reduce(wsState(), { type: 'workspaces', workspaces: WS.slice(0, 1) });
    expect(workspaceSummary(single)).toBe('1 workspace · Team One');
    const noName = reduce(wsState(), { type: 'workspaces', workspaces: WS.slice(0, 2).map(({ teamName, ...w }) => w) });
    expect(workspaceSummary(noName)).toBe('2 workspaces');
  });

  test('w steps through each workspace, across teams, and back to all', () => {
    let s = wsState();
    expect(currentWorkspace(s)).toBeNull();
    const seen: Array<string | null> = [];
    for (let i = 0; i < 4; i++) {
      s = cycleWorkspace(s);
      seen.push(currentWorkspace(s)?.name ?? null);
    }
    expect(seen).toEqual(['alpha', 'bravo', 'charlie', null]);
  });

  test('the missions pane shows only the selected workspace', () => {
    let s = wsState();
    expect(missionRows(s).map(r => r.title)).toEqual(['Alpha mission', 'Bravo mission', 'Charlie mission', '(no mission)']);
    s = cycleWorkspace(cycleWorkspace(cycleWorkspace(s))); // charlie
    expect(missionRows(s).map(r => [r.title, r.total])).toEqual([['Charlie mission', 1], ['(no mission)', 1]]);
    s = cycleWorkspace(cycleWorkspace(s)); // all, then alpha
    expect(missionRows(s).map(r => r.title)).toEqual(['Alpha mission', '(no mission)']);
    expect(taskRows(s, NOW).map(r => r.title)).toEqual(['alpha work']);
  });

  test('switching workspace starts at its first mission', () => {
    let s = { ...wsState(), selectedMission: MC.id, rowCursor: 3 };
    s = cycleWorkspace(s);
    expect(s.selectedMission).toBeNull();
    expect(s.rowCursor).toBe(0);
  });

  test('--workspace opens on one, by name or id', () => {
    expect(currentWorkspace({ ...wsState(), selectedWorkspace: 'Bravo' })?.id).toBe(WS[1].id);
    expect(currentWorkspace({ ...wsState(), selectedWorkspace: 'ws-cccc' })?.id).toBe(WS[2].id);
    expect(currentWorkspace({ ...wsState(), selectedWorkspace: 'nope' })).toBeNull();
  });

  test('--workspace that matches nothing: opens on all, and the status line says so', () => {
    let s = reduce(fixtureState(), { type: 'workers', workers: [] });
    s = { ...reduce(s, { type: 'tasks', tasks: WS_TASKS }), selectedWorkspace: 'nope' };
    s = reduce(s, { type: 'workspaces', workspaces: WS });
    expect(s.selectedWorkspace).toBeNull();
    expect(s.status).toEqual({ text: 'No workspace matches "nope", so this shows all 3.', tone: 'error' });
    // A match is left alone, with no status.
    let ok = reduce(fixtureState(), { type: 'workers', workers: [] });
    ok = reduce({ ...ok, selectedWorkspace: 'bravo' }, { type: 'workspaces', workspaces: WS });
    expect(currentWorkspace(ok)?.id).toBe(WS[1].id);
    expect(ok.status).toBeNull();
  });

  test('with no workspace list yet, the tasks name the workspaces', () => {
    const s = reduce(reduce(fixtureState(), { type: 'workers', workers: [] }), {
      type: 'tasks',
      tasks: WS_TASKS.map(t => ({ ...t, workspace: WS.find(w => w.id === t.workspaceId) })),
    });
    expect(workspaceSummary(s)).toBe('3 workspaces');
    expect(currentWorkspace(cycleWorkspace(s))?.name).toBe('alpha');
  });
});

describe('organizer runs are not work (R-22)', () => {
  test('which tasks are the mission\'s own planning', () => {
    expect(isOrganizerTask({ id: 'x', title: 'Mission: Runner TUI', status: 'pending' })).toBe(true);
    expect(isOrganizerTask({ id: 'x', title: 'Aggregate results: Runner TUI', status: 'pending' })).toBe(true);
    expect(isOrganizerTask({ id: 'x', title: 'Evaluate mission completion: x', status: 'pending' })).toBe(true);
    expect(isOrganizerTask({ id: 'x', title: 'plan it', status: 'pending', roleSlug: 'organizer' })).toBe(true);
    // Only organizer runs and the mission's own planning / check-in tasks: a
    // coordination-kind or planning-mode task someone filed is real work.
    expect(isOrganizerTask({ id: 'x', title: 'Reconcile the release queue', status: 'pending', kind: 'coordination' })).toBe(false);
    expect(isOrganizerTask({ id: 'x', title: 'Spec the importer', status: 'pending', mode: 'planning' })).toBe(false);
    expect(isOrganizerTask({ id: 'x', title: 'Mission statement page', status: 'pending', roleSlug: 'builder' })).toBe(false);
  });

  test('they are left out of rows and counts, and a planning mission says so', () => {
    const M = TASKS[0].mission!;
    const organizer: TopTask = { id: 't-org', title: `Mission: ${M.title}`, status: 'in_progress', missionId: M.id, mission: M, roleSlug: 'organizer' };
    const agg: TopTask = { id: 't-agg', title: `Aggregate results: ${M.title}`, status: 'pending', missionId: M.id, mission: M };
    let s = reduce(fixtureState(), { type: 'tasks', tasks: [...TASKS, organizer, agg] });
    s = reduce(s, { type: 'worker_update', worker: { id: 'w-org', taskId: 't-org', taskTitle: organizer.title, status: 'working', startedAt: NOW } });
    const titles = taskRows(s, NOW).map(r => r.title);
    expect(titles).not.toContain(organizer.title);
    expect(titles).not.toContain(agg.title);
    const row = missionRows(s).find(r => r.key === M.id)!;
    expect(row).toMatchObject({ done: 2, total: 8, planning: true });
    expect(missionRows(fixtureState()).find(r => r.key === M.id)!.planning).toBe(false);
  });

  test('a real coordination task stays visible', () => {
    const M = TASKS[0].mission!;
    const coord: TopTask = { id: 't-coord', title: 'Reconcile the release queue', status: 'pending', missionId: M.id, mission: M, roleSlug: 'builder', kind: 'coordination' };
    const s = reduce(fixtureState(), { type: 'tasks', tasks: [...TASKS, coord] });
    expect(taskRows(s, NOW).map(r => r.title)).toContain('Reconcile the release queue');
  });

  test('a worker on an organizer task the list does not carry is left out too', () => {
    const s = reduce(fixtureState(), { type: 'worker_update', worker: { id: 'w-o', taskId: 't-unlisted', taskTitle: 'Mission: Other', status: 'working', startedAt: NOW } });
    expect(taskRows({ ...s, selectedMission: NO_MISSION }, NOW).map(r => r.title)).not.toContain('Mission: Other');
  });
});

describe('failure reasons in plain words (R-22)', () => {
  test('the recorded reason, first line, without an Error: prefix', () => {
    expect(failureReason('Error: git push rejected (non-fast-forward)\n    at push (git.ts:1)')).toBe('git push rejected (non-fast-forward)');
    expect(failureReason('Agent exceeded max turns')).toBe('Agent exceeded max turns');
  });
  test('the generic server line is never shown as if it were a reason', () => {
    expect(failureReason('Task failed on server')).toBeNull();
    expect(failureReason(null)).toBeNull();
  });
  test('with no reason, the row says so plainly', () => {
    const s = reduce(fixtureState(), { type: 'worker_update', worker: { ...WORKERS[1], status: 'error', error: 'Task failed on server', completedAt: NOW - 60_000 } });
    expect(rowsByTitle(s)['single instance'].reason).toBe('failed, no reason recorded');
  });
  test('a failed row shows it', () => {
    const s = reduce(fixtureState(), { type: 'worker_update', worker: { ...WORKERS[1], status: 'error', error: 'Error: bun test exited 1', completedAt: NOW - 60_000 } });
    expect(rowsByTitle(s)['single instance']).toMatchObject({ kind: 'failed', reason: 'failed: bun test exited 1' });
  });
});
