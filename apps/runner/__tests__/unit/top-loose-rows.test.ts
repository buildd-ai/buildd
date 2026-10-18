/**
 * Loose tasks (no mission) in `buildd top`: one row per team, shown while the
 * team has loose work running, waiting or finished today, with honest counts.
 * A CI or review fix attempt of a mission task is listed under that mission.
 */
import { describe, expect, test } from 'bun:test';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { renderFrame } from '../../src/top/render';
import { NO_MISSION, currentMission, missionList, missionRows, reduce, taskRows, type TopState, type TopTask, type TopWorker } from '../../src/top/state';
import { handleKey } from '../../src/top/keys';
import { NOW, fixtureState } from './top-fixture';

const min = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const plain = createPalette('night', 'none');
const text = (s: TopState) => renderFrame(s, { cols: 100, rows: 30, now: NOW, palette: plain }).map(l => stripAnsi(l)).join('\n');

const worker = (taskId: string, workspaceId: string, status: TopWorker['status'] = 'working'): TopWorker =>
  ({ id: `w-${taskId}`, taskId, taskTitle: taskId, workspaceId, status, startedAt: NOW - 3 * min, currentAction: 'Edit x.ts' });
const loose = (id: string, workspaceId: string, over: Partial<TopTask> = {}): TopTask =>
  ({ id, title: `loose ${id}`, status: 'in_progress', missionId: null, workspaceId, updatedAt: iso(NOW - min), ...over });

function build(tasks: TopTask[], workers: TopWorker[], teams = true): TopState {
  let s = reduce(fixtureState(), { type: 'tasks', tasks: [] });
  s = reduce(s, { type: 'workers', workers: [] });
  s = reduce(s, { type: 'workspaces', workspaces: teams
    ? [{ id: 'ws-1', name: 'alpha', teamId: 'team-a', teamName: 'Acme' }, { id: 'ws-2', name: 'bravo', teamId: 'team-b', teamName: 'Initech' }]
    : [{ id: 'ws-1', name: 'alpha' }, { id: 'ws-2', name: 'bravo' }] });
  s = reduce(s, { type: 'tasks', tasks });
  return reduce(s, { type: 'workers', workers });
}
const looseRows = (s: TopState) => missionList(s, NOW).filter(r => r.key === NO_MISSION || r.key.startsWith(`${NO_MISSION}:`));

describe('loose rows per team', () => {
  const s = build(
    [loose('a1', 'ws-1'), loose('a2', 'ws-1', { status: 'completed' }), loose('a3', 'ws-1', { status: 'pending' }), loose('b1', 'ws-2')],
    [worker('a1', 'ws-1'), worker('b1', 'ws-2')],
  );

  test('exactly one loose row per team, with no extra global row', () => {
    const rows = looseRows(s);
    expect(rows.map(r => r.team).sort()).toEqual(['Acme', 'Initech']);
    expect(new Set(rows.map(r => r.key)).size).toBe(2);
    expect(rows.some(r => r.key === NO_MISSION)).toBe(false);
  });

  test('counts are done / total and running, per team', () => {
    const acme = looseRows(s).find(r => r.team === 'Acme')!;
    expect([acme.done, acme.total, acme.running]).toEqual([1, 3, 1]);
    const initech = looseRows(s).find(r => r.team === 'Initech')!;
    expect([initech.done, initech.total, initech.running]).toEqual([0, 1, 1]);
  });

  test('each loose row lists only its team\'s tasks, and is reachable by j/k', () => {
    let st = { ...s, focus: 'missions' as const };
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const cur = currentMission(st, NOW);
      if (cur.key.startsWith(NO_MISSION)) seen.push(`${cur.team}:${taskRows(st, NOW).map(r => r.taskId).sort().join(',')}`);
      st = handleKey(st, { name: 'down' } as any, NOW).state;
    }
    expect([...new Set(seen)].sort()).toEqual(['Acme:a1,a2,a3', 'Initech:b1']);
  });

  test('the loose row closes its team, after the delivered fold', () => {
    const keys = missionList(s, NOW).map(r => r.key);
    expect(keys.indexOf(`${NO_MISSION}:Acme`)).toBeLessThan(keys.indexOf(`${NO_MISSION}:Initech`));
    expect(text(s)).toMatch(/Acme[\s\S]*Other tasks[\s\S]*Initech[\s\S]*Other tasks/);
  });

  test('a filter keeps the loose row whose task matches, and drops the other team\'s', () => {
    const f = { ...s, filter: 'loose a1' };
    expect(looseRows(f).map(r => r.team)).toEqual(['Acme']);
    expect(taskRows({ ...f, selectedMission: `${NO_MISSION}:Acme` }, NOW).map(r => r.taskId)).toEqual(['a1']);
  });
});

describe('when loose rows show', () => {
  test('a team with no loose work has no loose row, and the global row is gone', () => {
    const s = build([loose('a1', 'ws-1')], [worker('a1', 'ws-1')]);
    expect(looseRows(s).map(r => r.team)).toEqual(['Acme']);
  });

  test('loose work finished on another day does not make a row', () => {
    const s = build([loose('a1', 'ws-1', { status: 'completed', updatedAt: iso(NOW - 30 * 60 * min) })], []);
    expect(looseRows(s).filter(r => r.total > 0)).toEqual([]);
  });

  test('with no team information the single global row stays, last, always', () => {
    const s = build([], [], false);
    expect(missionRows(s, NOW).at(-1)).toMatchObject({ key: NO_MISSION, total: 0, team: null });
    const t = build([loose('a1', 'ws-1')], [worker('a1', 'ws-1')], false);
    expect(looseRows(t)).toHaveLength(1);
    expect(looseRows(t)[0]).toMatchObject({ key: NO_MISSION, total: 1, running: 1 });
  });

  test('a loose task with no workspace known goes to the global row', () => {
    const s = build([loose('a1', 'ws-1'), loose('x', 'ws-unknown')], [worker('a1', 'ws-1')]);
    expect(looseRows(s).map(r => r.key).sort()).toEqual([NO_MISSION, `${NO_MISSION}:Acme`].sort());
  });
});

describe('fix attempts', () => {
  const MISSION = { id: 'm-1', title: 'Ship it', isHeld: false, executor: 'runner' };
  const tasks: TopTask[] = [
    { id: 'p', title: 'parent', status: 'completed', missionId: 'm-1', mission: MISSION, workspaceId: 'ws-1', updatedAt: iso(NOW - 10 * min) },
    { id: 'ci', title: 'Fix CI for parent', status: 'in_progress', missionId: null, parentTaskId: 'p', workspaceId: 'ws-1', updatedAt: iso(NOW - min) },
    { id: 'rv', title: 'Address review of parent', status: 'pending', missionId: null, parentTaskId: 'ci', workspaceId: 'ws-1' },
  ];
  const s = build(tasks, [worker('ci', 'ws-1')]);

  test('a CI or review fix of a mission task counts under that mission, not as loose', () => {
    expect(looseRows(s)).toEqual([]);
    const m = missionRows(s, NOW).find(r => r.key === 'm-1')!;
    expect([m.total, m.done, m.running]).toEqual([3, 1, 1]);
    expect(taskRows({ ...s, selectedMission: 'm-1' }, NOW).map(r => r.taskId).sort()).toEqual(['ci', 'p', 'rv']);
  });

  test('a fix of a loose task stays loose', () => {
    const t = build([loose('p2', 'ws-1'), loose('f2', 'ws-1', { parentTaskId: 'p2' })], []);
    expect(looseRows(t)[0]).toMatchObject({ total: 2 });
  });
});
