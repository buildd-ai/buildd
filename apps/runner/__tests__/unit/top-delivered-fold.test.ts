/**
 * `buildd top` folds a team's delivered missions (spec c7410e76 R-24, AC-10):
 * one dimmed "Delivered this week · N" row at the end of each team group,
 * Enter unfolds it into one row per mission with the day delivered, Enter or
 * Esc folds it again, and `/` finds a delivered mission by name without
 * unfolding. The day sits on the mission's own row, so a full pane can no
 * longer drop it.
 */
import { describe, expect, test } from 'bun:test';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { handleKey, parseKeys, type Key } from '../../src/top/keys';
import { renderFrame, textWidth } from '../../src/top/render';
import { currentMission, missionList, reduce, taskRows, type TopState } from '../../src/top/state';
import { NOW, fixtureState } from './top-fixture';

const plain = createPalette('night', 'none');
const frame = (s: TopState, cols: number, rows: number, palette = plain) => renderFrame(s, { cols, rows, now: NOW, palette });
const text = (lines: string[]) => lines.map(l => stripAnsi(l)).join('\n');

function press(s: TopState, ...keys: string[]): TopState {
  for (const k of keys) for (const key of parseKeys(k) as Key[]) s = handleKey(s, key, NOW).state;
  return s;
}

function expectExactSize(lines: string[], cols: number, rows: number) {
  expect(lines.length).toBe(rows);
  for (const l of lines) expect(textWidth(stripAnsi(l))).toBe(cols);
}

const DAY = 86_400_000;
const mission = (id: string, workspaceId: string, over: Record<string, unknown> = {}) => ({
  id, title: `mission ${id}`, workspaceId, status: 'active', isHeld: false, executor: 'runner', completedAt: null, stage: null, ...over,
});
const delivered = (id: string, workspaceId: string, title: string, daysAgo: number) =>
  mission(id, workspaceId, { title, status: 'completed', completedAt: new Date(NOW - daysAgo * DAY).toISOString(), stage: { step: 'delivered', waitingOn: null } });

/** Two teams: Acme with three open missions and four delivered, Initech with one open and one delivered. */
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
    delivered('m-d1', 'ws-1', 'Retire the old API', 1),
    delivered('m-d2', 'ws-1', 'Billing export', 2),
    delivered('m-d3', 'ws-1', 'Search ranking', 4),
    delivered('m-d4', 'ws-1', 'Onboarding copy', 6),
    delivered('m-old', 'ws-1', 'Long finished', 9),
    mission('m-5', 'ws-2', { title: 'Billing cleanup', stage: { step: 'verifying', waitingOn: null } }),
    delivered('m-d5', 'ws-2', 'Invoice layout', 3),
  ] });
};

/** Selected in the left pane, focused there. */
const onMissions = (s: TopState, key: string): TopState => ({ ...s, focus: 'missions', selectedMission: key });

describe('the missions list folds delivered missions (state)', () => {
  test('one fold row per team, at the end of its group, counting the missions delivered in the last 7 days', () => {
    const rows = missionList(teamed(), NOW);
    expect(rows.map(r => r.title)).toEqual([
      'Pair on the parser', 'Ship the importer', 'Docs refresh', 'Delivered this week',
      'Billing cleanup', 'Delivered this week',
      'Other tasks',
    ]);
    const folds = rows.filter(r => r.fold);
    expect(folds.map(f => [f.team, f.fold!.count, f.fold!.open])).toEqual([['Acme', 4, false], ['Initech', 1, false]]);
  });

  test('a team with nothing delivered this week has no fold row', () => {
    const s = reduce(teamed(), { type: 'missions', missions: [mission('m-1', 'ws-1', { title: 'Ship the importer' })] });
    expect(missionList(s, NOW).some(r => r.fold)).toBe(false);
  });

  test('unfolded: one row per mission under the fold row, newest first; a mission delivered 9 days ago is not among them (AC-10)', () => {
    const s = { ...teamed(), unfolded: ['fold:Acme'] };
    const titles = missionList(s, NOW).map(r => r.title);
    expect(titles.slice(3, 8)).toEqual(['Delivered this week', 'Retire the old API', 'Billing export', 'Search ranking', 'Onboarding copy']);
    expect(titles).not.toContain('Long finished');
    // Initech's fold stays folded.
    expect(titles).not.toContain('Invoice layout');
  });

  test('a delivered mission that is selected shows, with its group open (e.g. `--mission`)', () => {
    const s = { ...teamed(), selectedMission: 'm-d3' };
    expect(missionList(s, NOW).map(r => r.title)).toContain('Search ranking');
    expect(currentMission(s, NOW).title).toBe('Search ranking');
  });

  test('`/` finds a delivered mission by name without unfolding; open missions are filtered the same way', () => {
    const s = { ...teamed(), filter: 'billing' };
    const rows = missionList(s, NOW);
    expect(rows.map(r => r.title)).toEqual(['Billing export', 'Billing cleanup', 'Other tasks']);
    expect(rows.find(r => r.title === 'Billing export')!.deliveredAt).toBe(NOW - 2 * DAY);
    expect(s.unfolded).toEqual([]);
  });

  test('a mission whose title matches lists all its tasks, not only those whose titles match', () => {
    const base = fixtureState();
    const s = { ...base, filter: 'runner tui', selectedMission: 'm-tui-0000-0000' };
    expect(missionList(s, NOW).map(r => r.title)).toContain('Runner TUI');
    expect(taskRows(s, NOW).length).toBe(taskRows({ ...s, filter: '' }, NOW).length);
  });
});

describe('Enter and Esc fold and unfold (keys)', () => {
  test('Enter on the fold row unfolds it, Enter again folds it', () => {
    let s = press(onMissions(teamed(), 'fold:Acme'), '\r');
    expect(s.unfolded).toEqual(['fold:Acme']);
    expect(s.focus).toBe('missions');
    expect(missionList(s, NOW).map(r => r.title)).toContain('Retire the old API');
    s = press(s, '\r');
    expect(s.unfolded).toEqual([]);
    expect(missionList(s, NOW).map(r => r.title)).not.toContain('Retire the old API');
  });

  test('↓ walks into the unfolded missions; Esc folds the group and returns to its fold row', () => {
    let s = press(onMissions(teamed(), 'fold:Acme'), '\r', '\x1b[B');
    expect(currentMission(s, NOW).title).toBe('Retire the old API');
    s = press(s, '\x1b');
    expect(s.unfolded).toEqual([]);
    expect(s.selectedMission).toBe('fold:Acme');
    expect(missionList(s, NOW).map(r => r.title)).not.toContain('Retire the old API');
  });

  test('Enter on an unfolded delivered mission folds its group too', () => {
    const s = press(onMissions(teamed(), 'fold:Acme'), '\r', '\x1b[B', '\r');
    expect(s.unfolded).toEqual([]);
    expect(s.selectedMission).toBe('fold:Acme');
  });

  test('the fold is kept while top runs: switching teams and back leaves it open', () => {
    const s = press(onMissions(teamed(), 'fold:Acme'), '\r', 't', 't', 't');
    expect(s.unfolded).toEqual(['fold:Acme']);
  });

  test('Esc with a filter clears the filter first, and the fold is back', () => {
    let s = press(teamed(), '/', 'billing', '\r');
    expect(missionList(s, NOW).map(r => r.title)).toContain('Billing export');
    s = press(s, '\x1b');
    expect(s.filter).toBe('');
    expect(missionList(s, NOW).map(r => r.title)).not.toContain('Billing export');
  });
});

describe('frames (R-7, R-21, AC-10)', () => {
  const sizes: Array<[number, number]> = [[80, 24], [120, 40]];

  for (const [cols, rows] of sizes) {
    test(`${cols}x${rows} folded: one dimmed row per team instead of every delivered mission`, () => {
      const lines = frame(teamed(), cols, rows);
      expectExactSize(lines, cols, rows);
      const t = text(lines);
      expect(t).not.toContain('Retire the old');
      expect(t).toMatch(/Delivered( this week)? · 4/);
      expect(t).toMatch(/Delivered( this week)? · 1/);
      expect(t).toMatchSnapshot();
    });

    test(`${cols}x${rows} unfolded: each delivered mission on its own row with the day delivered`, () => {
      const s = press(onMissions(teamed(), 'fold:Acme'), '\r');
      const lines = frame(s, cols, rows);
      expectExactSize(lines, cols, rows);
      const t = text(lines);
      for (const title of ['Retire', 'Billing ex', 'Search', 'Onboard']) expect(t).toContain(title);
      const day = (ago: number) => { const d = new Date(NOW - ago * DAY); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()}`; };
      // The day is on the mission's own row, beside its title.
      const retire = lines.map(l => stripAnsi(l)).find(l => l.split('│')[0].includes('Retire'))!;
      expect(retire.split('│')[0]).toContain(day(1));
      expect(t).toContain(day(6));
      expect(t).toMatchSnapshot();
    });

    test(`${cols}x${rows} filtering: a delivered match shows with its day, the fold untouched`, () => {
      const s = press(teamed(), '/', 'billing', '\r');
      const lines = frame(s, cols, rows);
      expectExactSize(lines, cols, rows);
      const t = text(lines);
      expect(t).toContain('Billing ex');
      expect(t).not.toContain('Delivered this week');
      expect(t).toMatchSnapshot();
    });
  }

  test('the unfolded day survives a short pane: it is on the row, not a second line that drops', () => {
    const s = press(onMissions(teamed(), 'fold:Acme'), '\r');
    const lines = frame(s, 80, 12).map(l => stripAnsi(l).split('│')[0]);
    const d = new Date(NOW - DAY);
    expect(lines.find(l => l.includes('Retire'))).toContain(`${d.getDate()}`);
  });

  test('the fold row and the delivered rows are dimmed, not in the primary colour', () => {
    const s = press(onMissions(teamed(), 'fold:Initech'), '\r');
    const lines = frame(s, 80, 24, createPalette('night', 'truecolor'));
    const fold = lines.find(l => stripAnsi(l).includes('Delivered'))!;
    const done = lines.find(l => stripAnsi(l).includes('Invoice'))!;
    const open = lines.find(l => stripAnsi(l).includes('Ship the'))!;
    const before = (l: string, word: string) => l.slice(0, l.indexOf(word));
    expect(before(fold, 'Delivered')).not.toBe(before(open, 'Ship'));
    expect(before(done, 'Invoice')).not.toBe(before(open, 'Ship'));
  });

  test('the right pane on the fold row lists the deliveries themselves, newest first, each with its day', () => {
    const lines = frame(onMissions(teamed(), 'fold:Acme'), 80, 24).map(l => stripAnsi(l));
    const t = lines.join('\n');
    expect(t).toContain('Delivered · 4');
    expect(t).toContain('│ 4 delivered in the last 7 days');
    // No sentence about the keys: the work is shown.
    expect(t).not.toMatch(/⏎ lists them|Delivered in the last 7 days\./);
    const right = lines.map(l => l.split('│')[1] ?? '');
    const retire = right.findIndex(l => l.includes('Retire'));
    expect(retire).toBeGreaterThan(-1);
    expect(right[retire]).toMatch(/^ [A-Z][a-z]{2} \d{1,2} +Retire/);
  });
});
