/**
 * `buildd top` across teams (spec c7410e76 R-23, R-24, AC-9, AC-10): opens on
 * every workspace the runner serves, `t` and `w` narrow it, the filter line
 * says what is shown, and the missions pane lists every open mission and the
 * ones delivered in the last 7 days, grouped by team.
 */
import { describe, expect, test } from 'bun:test';
import {
  currentTeam, currentWorkspace, currentMission, cycleTeam, cycleWorkspace, filterLine, initialState, missionMeta, missionRowStage, missionRows, reduce, taskRows, teamList,
  type TopState, type TopTask,
} from '../../src/top/state';
import { NOW } from './top-fixture';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const WS = [
  { id: 'ws-1', name: 'one', teamId: 'team-a', teamName: 'Team A' },
  { id: 'ws-2', name: 'two', teamId: 'team-b', teamName: 'Team B' },
  { id: 'ws-3', name: 'three', teamId: 'team-a', teamName: 'Team A' },
];

const mission = (id: string, workspaceId: string, over: Record<string, unknown> = {}) => ({
  id, title: `mission ${id}`, workspaceId, status: 'active', isHeld: false, executor: 'runner', completedAt: null, stage: null, ...over,
});

const RECENT = [
  mission('m-hold', 'ws-1', { title: 'On hold one', isHeld: true, stage: { step: 'on_hold', waitingOn: null } }),
  mission('m-build', 'ws-1', { title: 'Building one', stage: { step: 'building', waitingOn: null } }),
  mission('m-verify', 'ws-3', { title: 'Verifying one', stage: { step: 'verifying', waitingOn: null } }),
  mission('m-local', 'ws-1', { title: 'Local one', executor: 'local' }),
  mission('m-done', 'ws-1', { title: 'Delivered one', status: 'completed', completedAt: iso(NOW - 2 * DAY) }),
  mission('m-done2', 'ws-3', { title: 'Delivered newer', status: 'completed', completedAt: iso(NOW - 1 * DAY) }),
  mission('m-old', 'ws-1', { title: 'Delivered long ago', status: 'completed', completedAt: iso(NOW - 8 * DAY) }),
  mission('m-b', 'ws-2', { title: 'Other team mission', stage: { step: 'building', waitingOn: null } }),
];

function state(over: Partial<TopState> = {}, recent: unknown[] | null = RECENT, tasks: TopTask[] = []): TopState {
  let s = initialState({ hostname: 'h' });
  s = reduce(s, { type: 'workspaces', workspaces: WS });
  s = reduce(s, { type: 'tasks', tasks });
  if (recent) s = reduce(s, { type: 'missions', missions: recent });
  return { ...s, ...over };
}

describe('teams (R-23)', () => {
  test('opens on every workspace of every team, and the filter line says so (AC-9)', () => {
    const s = state();
    expect(currentTeam(s)).toBeNull();
    expect(currentWorkspace(s)).toBeNull();
    expect(filterLine(s)).toBe('t team: all · w workspace: all');
  });

  test('t steps through the teams by name, in first-listed order, and back to all', () => {
    let s = state();
    const seen: Array<string | null> = [];
    for (let i = 0; i < 3; i++) {
      s = cycleTeam(s);
      seen.push(currentTeam(s)?.name ?? null);
    }
    expect(seen).toEqual(['Team A', 'Team B', null]);
    expect(teamList(s).map(t => t.name)).toEqual(['Team A', 'Team B']);
  });

  test('w then steps only that team\'s workspaces, and the line names both (AC-9)', () => {
    let s = cycleTeam(state());
    const seen: Array<string | null> = [];
    for (let i = 0; i < 3; i++) {
      s = cycleWorkspace(s);
      seen.push(currentWorkspace(s)?.name ?? null);
    }
    expect(seen).toEqual(['one', 'three', null]);
    s = cycleWorkspace(s);
    expect(filterLine(s)).toBe('t team: Team A · w workspace: one');
  });

  test('with team all, w steps every workspace grouped by team', () => {
    let s = state();
    const seen: Array<string | null> = [];
    for (let i = 0; i < 4; i++) {
      s = cycleWorkspace(s);
      seen.push(currentWorkspace(s)?.name ?? null);
    }
    expect(seen).toEqual(['one', 'three', 'two', null]);
  });

  test('changing team clears a workspace picked in another team, and the selected mission', () => {
    let s = cycleWorkspace(cycleWorkspace(cycleWorkspace(state()))); // two (team B)
    s = { ...s, selectedMission: 'm-b', rowCursor: 2 };
    s = cycleTeam(s);
    expect(currentWorkspace(s)).toBeNull();
    expect(s.selectedMission).toBeNull();
    expect(s.rowCursor).toBe(0);
  });

  test('--team opens on one team, by name or id, any case', () => {
    expect(currentTeam(state({ selectedTeam: 'team b' }))?.name).toBe('Team B');
    expect(currentTeam(state({ selectedTeam: 'team-a' }))?.name).toBe('Team A');
    expect(filterLine(state({ selectedTeam: 'TEAM B' }))).toBe('t team: Team B · w workspace: all');
  });

  test('--team naming no team: opens on all and says so', () => {
    const s = state({ selectedTeam: 'nope' });
    // The workspace list arrives after the flag is read.
    const fresh = reduce({ ...initialState({ hostname: 'h', team: 'nope' }) }, { type: 'workspaces', workspaces: WS });
    expect(s.selectedTeam).toBe('nope');
    expect(fresh.selectedTeam).toBeNull();
    expect(fresh.status).toEqual({ text: 'No team matches "nope", so this shows all 2 teams.', tone: 'error' });
  });

  test('a team narrows the missions pane and the task rows to its workspaces', () => {
    const tasks: TopTask[] = [
      { id: 'a1', title: 'a work', status: 'pending', workspaceId: 'ws-1', missionId: 'm-build', mission: { id: 'm-build', title: 'Building one' } },
      { id: 'b1', title: 'b work', status: 'pending', workspaceId: 'ws-2', missionId: 'm-b', mission: { id: 'm-b', title: 'Other team mission' } },
    ];
    const all = state({}, RECENT, tasks);
    expect(taskRows(all, NOW).map(r => r.title)).toEqual(['a work']);
    const b = state({ selectedTeam: 'Team B' }, RECENT, tasks);
    expect(taskRows(b, NOW).map(r => r.title)).toEqual(['b work']);
    expect(missionRows(b, NOW).map(r => r.title)).toEqual(['Other team mission', 'Other tasks']);
  });

  test('one team, or none named: t has nothing to switch to', () => {
    const one = reduce(state(), { type: 'workspaces', workspaces: WS.filter(w => w.teamId === 'team-a') });
    expect(teamList(one)).toHaveLength(1);
    expect(cycleTeam(one)).toBe(one);
    const bare = reduce(state(), { type: 'workspaces', workspaces: WS.map(({ teamId, teamName, ...w }) => w) });
    expect(teamList(bare)).toHaveLength(0);
    expect(filterLine(bare)).toBe('t team: all · w workspace: all');
  });
});

describe('missions pane (R-24)', () => {
  test('grouped by team in first-listed order; open ones building and verifying first, then on hold; delivered last, newest first (AC-10)', () => {
    const rows = missionRows(state(), NOW);
    expect(rows.map(r => [r.team, r.title])).toEqual([
      ['Team A', 'Building one'],
      ['Team A', 'Local one'],
      ['Team A', 'Verifying one'],
      ['Team A', 'On hold one'],
      ['Team A', 'Delivered newer'],
      ['Team A', 'Delivered one'],
      ['Team B', 'Other team mission'],
      [null, 'Other tasks'],
    ]);
  });

  test('missions delivered more than 7 days ago are not listed', () => {
    expect(missionRows(state(), NOW).map(r => r.title)).not.toContain('Delivered long ago');
    // The same list a week later: the 2-day-old one has aged out too.
    const later = missionRows(state(), NOW + 6.5 * DAY).map(r => r.title);
    expect(later).not.toContain('Delivered one');
    expect(later).not.toContain('Delivered newer');
  });

  test('a delivered mission carries its day; one managed from a local session says so in its stage words, not on a line of its own', () => {
    const rows = missionRows(state(), NOW);
    const done = rows.find(r => r.key === 'm-done')!;
    expect(done.deliveredAt).toBe(NOW - 2 * DAY);
    expect(missionMeta(done)).toMatch(/^done [A-Z][a-z]{2} \d{1,2}$/);
    const local = rows.find(r => r.key === 'm-local')!;
    expect(local.local).toBe(true);
    expect(missionMeta(local)).toBeNull();
    expect(missionRowStage(local)).toMatch(/locally$|^local$/);
    expect(missionMeta(rows.find(r => r.key === 'm-build')!)).toBeNull();
  });

  test('a mission whose tasks the list holds is one row, with the server\'s facts added', () => {
    const tasks: TopTask[] = [
      { id: 'a1', title: 'a work', status: 'pending', workspaceId: 'ws-1', missionId: 'm-build', mission: { id: 'm-build', title: 'Building one', taskCounts: { done: 1, total: 4 } } },
    ];
    const rows = missionRows(state({}, RECENT, tasks), NOW).filter(r => r.key === 'm-build');
    expect(rows).toHaveLength(1);
    expect(rows[0].stage?.step).toBe('building');
    expect([rows[0].done, rows[0].total]).toEqual([1, 4]);
  });

  test('without the missions list yet, the pane is what the tasks name, as before', () => {
    const tasks: TopTask[] = [
      { id: 'a1', title: 'a work', status: 'pending', workspaceId: 'ws-1', missionId: 'm-x', mission: { id: 'm-x', title: 'From tasks' } },
    ];
    expect(missionRows(state({}, null, tasks), NOW).map(r => r.title)).toEqual(['From tasks', 'Other tasks']);
  });

  test('the selection moves with the order and picks a mission with no tasks', () => {
    const s = state({ selectedMission: 'm-done' });
    expect(currentMission(s, NOW).title).toBe('Delivered one');
  });

  test('a malformed missions reply leaves the list alone', () => {
    const s = state();
    expect(reduce(s, { type: 'missions', missions: 'nope' })).toBe(s);
  });
});
