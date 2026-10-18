/**
 * Mission names in the missions pane (spec c7410e76 R-57, AC-40): the pane
 * grows with a wide terminal, and the selected mission shows its whole name,
 * wrapped under itself, so moving the selection reads each name in turn.
 */
import { describe, expect, test } from 'bun:test';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { renderFrame, textWidth } from '../../src/top/render';
import { reduce, type TopState } from '../../src/top/state';
import { NOW, fixtureState } from './top-fixture';

const plain = createPalette('night', 'none');
const frame = (s: TopState, cols: number, rows: number) => renderFrame(s, { cols, rows, now: NOW, palette: plain });
/** The missions pane alone: everything left of the divider. */
const pane = (lines: string[]) => lines.map(l => stripAnsi(l).split('│')[0]);

const LONG = 'Fast at any size: pages and APIs read only what they show';
const OTHER = 'Failures recover on their own without a person';

const state = (): TopState => {
  let s = reduce(fixtureState(), { type: 'tasks', tasks: [] });
  s = reduce(s, { type: 'workers', workers: [] });
  s = reduce(s, { type: 'workspaces', workspaces: [{ id: 'ws-1', name: 'alpha', teamId: 'team-a', teamName: 'Acme' }] });
  return reduce(s, { type: 'missions', missions: [
    { id: 'm-1', title: OTHER, workspaceId: 'ws-1', status: 'active', isHeld: false, executor: 'runner', completedAt: null, stage: { step: 'verifying', waitingOn: null } },
    { id: 'm-2', title: LONG, workspaceId: 'ws-1', status: 'active', isHeld: false, executor: 'runner', completedAt: null, stage: { step: 'building', waitingOn: null } },
  ] });
};

const words = (s: string) => s.replace(/[▸…]/g, ' ').split(/\s+/).filter(Boolean);

describe('mission names (R-57)', () => {
  test('the selected mission shows every word of its name, at 80 and at 200 columns', () => {
    for (const cols of [80, 200]) {
      const lines = frame({ ...state(), selectedMission: 'm-2' }, cols, 24);
      expect(lines.length).toBe(24);
      for (const l of lines) expect(textWidth(stripAnsi(l))).toBe(cols);
      const shown = words(pane(lines).join(' '));
      for (const w of words(LONG)) expect(shown).toContain(w);
    }
  });

  test('a mission not selected keeps one row', () => {
    const lines = pane(frame({ ...state(), selectedMission: 'm-2' }, 80, 24));
    expect(lines.filter(l => l.includes('Failur')).length).toBe(1);
    expect(lines.join(' ')).not.toContain('person');
  });

  test('moving the selection moves the whole name with it', () => {
    const lines = pane(frame({ ...state(), selectedMission: 'm-1' }, 80, 24));
    const shown = words(lines.join(' '));
    for (const w of words(OTHER)) expect(shown).toContain(w);
    expect(shown).not.toContain('APIs');
  });

  test('a wide terminal gives the pane more room: an unselected name reads past its first word', () => {
    const at200 = pane(frame({ ...state(), selectedMission: 'm-1' }, 200, 24));
    const row = at200.find(l => l.includes('Fast'))!;
    expect(row).toContain('Fast at any size');
    expect(row.length).toBeGreaterThan(40);
  });
});

describe('the pane widens while you move between missions (R-57)', () => {
  const divider = (lines: string[]) => stripAnsi(lines[4]).indexOf('│');
  test('focus on the missions pane gives it more columns than focus on the tasks', () => {
    for (const cols of [80, 120, 200]) {
      const onMissions = frame({ ...state(), selectedMission: 'm-1', focus: 'missions' }, cols, 24);
      const onTasks = frame({ ...state(), selectedMission: 'm-1', focus: 'tasks' }, cols, 24);
      expect(divider(onMissions)).toBeGreaterThan(divider(onTasks));
      for (const l of onMissions) expect(textWidth(stripAnsi(l))).toBe(cols);
    }
  });

  test('with the pane focused at 200 columns, an unselected name reads nearly whole', () => {
    const lines = pane(frame({ ...state(), selectedMission: 'm-1', focus: 'missions' }, 200, 24));
    expect(lines.find(l => l.includes('Fast'))).toContain('Fast at any size: pages and APIs read');
  });
});
