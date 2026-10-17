/**
 * `buildd top` frames across teams (spec c7410e76 R-23, R-24, AC-9, AC-10):
 * the filter line, team headings, open missions, delivered ones dimmed with
 * their day, and 80x24 keeping all of it without wrapping.
 */
import { describe, expect, test } from 'bun:test';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { renderFrame, textWidth } from '../../src/top/render';
import { reduce, type TopState } from '../../src/top/state';
import { NOW, fixtureState } from './top-fixture';

const plain = createPalette('night', 'none');
const frame = (s: TopState, cols: number, rows: number, palette = plain) => renderFrame(s, { cols, rows, now: NOW, palette });
const text = (lines: string[]) => lines.map(l => stripAnsi(l)).join('\n');

function expectExactSize(lines: string[], cols: number, rows: number) {
  expect(lines.length).toBe(rows);
  for (const l of lines) expect(textWidth(stripAnsi(l))).toBe(cols);
}

const DAY = 86_400_000;
const mission = (id: string, workspaceId: string, over: Record<string, unknown> = {}) => ({
  id, title: `mission ${id}`, workspaceId, status: 'active', isHeld: false, executor: 'runner', completedAt: null, stage: null, ...over,
});

const teamed = (): TopState => {
  let s = reduce(fixtureState(), { type: 'tasks', tasks: [] });
  s = reduce(s, { type: 'workers', workers: [] });
  s = reduce(s, { type: 'workspaces', workspaces: [
    { id: 'ws-1', name: 'alpha', teamId: 'team-a', teamName: 'Acme' },
    { id: 'ws-2', name: 'bravo', teamId: 'team-b', teamName: 'Initech' },
  ] });
  return reduce(s, { type: 'missions', missions: [
    mission('m-1', 'ws-1', { title: 'Ship the importer', stage: { step: 'building', waitingOn: null } }),
    mission('m-2', 'ws-1', { title: 'Docs refresh', isHeld: true, stage: { step: 'on_hold', waitingOn: null } }),
    mission('m-3', 'ws-1', { title: 'Pair on the parser', executor: 'local' }),
    mission('m-4', 'ws-1', { title: 'Retire the old API', status: 'completed', completedAt: new Date(NOW - 2 * DAY).toISOString() }),
    mission('m-5', 'ws-2', { title: 'Billing cleanup', stage: { step: 'verifying', waitingOn: null } }),
  ] });
};

describe('teams and missions (R-23, R-24)', () => {
  test('80x24: the filter line, team headings, open missions, then the delivered ones folded into one row', () => {
    const lines = frame(teamed(), 80, 24);
    expectExactSize(lines, 80, 24);
    const t = text(lines);
    expect(stripAnsi(lines[1]).trim()).toBe('[ Missions ]  Queue   t team: all · w workspace: all');
    expect(t).toMatch(/^ Acme/m);
    expect(t).toMatch(/^ Initech/m);
    // The left pane is 22 columns, so a long title is cut; the order is what matters.
    const at = (s: string) => t.indexOf(s);
    expect(at('Ship the')).toBeLessThan(at('Docs ref'));
    expect(at('Docs ref')).toBeLessThan(at('Delivered · 1'));
    expect(at('Delivered · 1')).toBeLessThan(at('Billing'));
    expect(t).not.toContain('Retire the old API');
    expect(t).toContain('local session');
    expect(t).toContain('2 workspaces · 2 teams');
    expect(t).toMatchSnapshot();
  });

  test('the delivered mission is drawn dimmed, not in the primary colour', () => {
    const lines = frame({ ...teamed(), unfolded: ['fold:Acme'] }, 80, 24, createPalette('night', 'truecolor'));
    const done = lines.find(l => stripAnsi(l).includes('Retire the'))!;
    const open = lines.find(l => stripAnsi(l).includes('Ship the'))!;
    // Same position, different colour: the title's escape sequence differs.
    expect(done.slice(0, done.indexOf('Retire'))).not.toBe(open.slice(0, open.indexOf('Ship')));
  });

  test('the filter line names the team and workspace in view', () => {
    const s = { ...teamed(), selectedTeam: 'Initech', selectedWorkspace: 'bravo' };
    const lines = frame(s, 80, 24);
    expect(stripAnsi(lines[1]).trim()).toBe('[ Missions ]  Queue   t team: Initech · w workspace: bravo');
    expect(text(lines)).not.toContain('Ship the');
    expect(text(lines)).toContain('Billing cleanup');
  });

  test('a long name is cut, never wrapped, at 80 and at 60 columns', () => {
    const base = teamed();
    const s = { ...base, selectedTeam: 'Initech', selectedWorkspace: 'ws-2', workspaces: base.workspaces.map(w => ({ ...w, name: 'a-very-long-workspace-name-for-the-filter-line' })) };
    for (const cols of [80, 60]) expectExactSize(frame(s, cols, 24), cols, 24);
  });

  test('a short screen drops the meta lines before it drops missions', () => {
    const lines = frame(teamed(), 80, 14);
    expectExactSize(lines, 80, 14);
    const t = text(lines);
    expect(t).toContain('Pair on the parser');
    expect(t).toContain('Delivered · 1');
    expect(t).toContain('Billing');
    expect(t).not.toContain('delivered');
  });

  test('the selected mission scrolls into view in the left pane', () => {
    const s = { ...teamed(), selectedMission: 'm-5' };
    expect(text(frame(s, 80, 12))).toContain('Billing cleanup');
  });

  test('the right pane says so for a delivered mission and a person-run one', () => {
    const delivered = text(frame({ ...teamed(), selectedMission: 'm-4' }, 80, 24));
    expect(delivered).toMatch(/Retire the old API · delivered [A-Z][a-z]{2} \d{1,2}/);
    const local = text(frame({ ...teamed(), selectedMission: 'm-3' }, 80, 24));
    expect(local).toContain('A person runs this mission');
  });

  test('the footer offers t', () => {
    expect(stripAnsi(frame(teamed(), 120, 24)[23])).toContain('t team');
    expect(stripAnsi(frame(teamed(), 80, 24)[23])).toContain('t team');
  });
});

describe('teams and loose tasks (R-2, R-3)', () => {
  test('80x24: loose tasks show a "(no mission)" row in each team group', () => {
    let s = reduce(fixtureState(), { type: 'tasks', tasks: [] });
    s = reduce(s, { type: 'workers', workers: [] });
    s = reduce(s, { type: 'workspaces', workspaces: [
      { id: 'ws-1', name: 'alpha', teamId: 'team-a', teamName: 'Acme' },
      { id: 'ws-2', name: 'bravo', teamId: 'team-b', teamName: 'Initech' },
    ] });
    // Add loose tasks in each workspace (belonging to different teams)
    s = reduce(s, { type: 'tasks', tasks: [
      { id: 't-loose-1', title: 'CI fix attempt', status: 'in_progress', missionId: null, workspaceId: 'ws-1' },
      { id: 't-loose-2', title: 'friction task 1', status: 'pending', missionId: null, workspaceId: 'ws-1' },
      { id: 't-loose-3', title: 'friction task 2', status: 'completed', missionId: null, workspaceId: 'ws-2' },
    ] });
    s = reduce(s, { type: 'workers', workers: [] });
    s = reduce(s, { type: 'missions', missions: [] });
    const lines = frame(s, 80, 24);
    expectExactSize(lines, 80, 24);
    const t = text(lines);
    // Each team should show a "(no mission)" row
    expect(t).toMatch(/^ Acme/m);
    expect(t).toMatch(/^ Initech/m);
    expect(t).toContain('(no mission)');
    // The "(no mission)" row should show per-team done/total counts
    // Acme: 2 tasks (1 in_progress, 1 pending), 0 done
    // Initech: 1 task (completed), 1 done
    expect(t).toContain('(no mission)   0/2');  // Acme
    expect(t).toContain('(no mission)   1/1');  // Initech
    expect(t).toMatchSnapshot();
  });
});
