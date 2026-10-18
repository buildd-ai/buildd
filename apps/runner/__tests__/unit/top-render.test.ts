/**
 * `buildd top` frames (R-3, R-5, R-7): snapshot at 80x24 and 120x40, every line
 * exactly the terminal's width, columns dropped (cost, then role) rather than
 * rows wrapped, and nothing lost under NO_COLOR.
 */
import { describe, expect, test } from 'bun:test';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { columnsFor, fit, renderFrame, textWidth } from '../../src/top/render';
import { NO_MISSION, initialState, localLiftTime, reduce, type TopState } from '../../src/top/state';
import { NOW, TASKS, fixtureState } from './top-fixture';

const plain = createPalette('night', 'none');
const frame = (s: TopState, cols: number, rows: number, palette = plain) => renderFrame(s, { cols, rows, now: NOW, palette });
const text = (lines: string[]) => lines.map(l => stripAnsi(l)).join('\n');

function expectExactSize(lines: string[], cols: number, rows: number) {
  expect(lines.length).toBe(rows);
  for (const l of lines) expect(textWidth(stripAnsi(l))).toBe(cols);
}

describe('list view', () => {
  test('80x24', () => {
    const lines = frame(fixtureState(), 80, 24);
    expectExactSize(lines, 80, 24);
    expect(text(lines)).toMatchSnapshot();
  });

  test('120x40', () => {
    const lines = frame(fixtureState(), 120, 40);
    expectExactSize(lines, 120, 40);
    expect(text(lines)).toMatchSnapshot();
  });

  test('80x24 in colour (night, truecolor) keeps the same text', () => {
    const lines = frame(fixtureState(), 80, 24, createPalette('night', 'truecolor'));
    expect(text(lines)).toBe(text(frame(fixtureState(), 80, 24)));
    expect(lines.join('\n')).toMatchSnapshot();
  });

  test('NO_COLOR frames carry no escape codes', () => {
    // eslint-disable-next-line no-control-regex
    expect(frame(fixtureState(), 80, 24).join('')).not.toMatch(/\x1b/);
  });

  test('the asking row shows the question, never a status label', () => {
    const t = text(frame(fixtureState(), 120, 40));
    expect(t).toContain('asks: "Print the URL or open the b');
    expect(t).not.toMatch(/needs input|needs you/i);
  });

  test('cost goes first, then role, and rows still never wrap', () => {
    expect(columnsFor(91)).toEqual({ role: true, cost: true, route: false });
    expect(columnsFor(57)).toEqual({ role: true, cost: false, route: false });
    expect(columnsFor(37)).toEqual({ role: false, cost: false, route: false });
    const t80 = text(frame(fixtureState(), 80, 24));
    expect(t80).not.toContain('tok');
    expect(t80).toContain('Builder');
    const lines60 = frame(fixtureState(), 60, 20);
    expectExactSize(lines60, 60, 20);
    expect(text(lines60)).not.toContain('Builder');
  });

  test('the selection is marked without colour', () => {
    const s = { ...fixtureState(), rowCursor: 1 };
    const t = text(frame(s, 80, 24));
    expect(t).toContain('│›? installer hint');
  });

  test('a long list scrolls to keep the selection on screen', () => {
    const s = { ...fixtureState(), rowCursor: 6 };
    const t = text(frame(s, 80, 10));
    expect(t).toContain('›✓ spec draft');
  });

  test('offline shows reconnecting in the header', () => {
    const s = { ...fixtureState(), runner: { ...fixtureState().runner, online: false } };
    expect(stripAnsi(frame(s, 80, 24)[0])).toContain('○ reconnecting');
  });

  test('before the first connection the header says loading, not reconnecting', () => {
    let s = initialState({ hostname: 'laptop-1234' });
    expect(stripAnsi(frame(s, 80, 24)[0])).toContain('○ loading');
    expect(stripAnsi(frame(s, 80, 24)[0])).not.toContain('reconnecting');
    // A first attempt that fails is still loading: nothing was ever up.
    s = reduce(s, { type: 'connection', online: false });
    expect(stripAnsi(frame(s, 80, 24)[0])).toContain('○ loading');
    s = reduce(s, { type: 'init', workers: [], config: { maxConcurrent: 4 } });
    expect(stripAnsi(frame(s, 80, 24)[0])).toContain('0 of 4 slots in use · ● online');
    // Only a connection that was up and dropped reads reconnecting.
    s = reduce(s, { type: 'connection', online: false });
    expect(stripAnsi(frame(s, 80, 24)[0])).toContain('○ reconnecting');
  });
});

describe('detail view (R-5)', () => {
  test('80x24: plan, milestones, tool calls and the PR link', () => {
    const s: TopState = { ...fixtureState(), mode: { kind: 'detail', taskId: 't-name' } };
    const lines = frame(s, 80, 24);
    expectExactSize(lines, 80, 24);
    expect(text(lines)).toMatchSnapshot();
  });

  test('an asking worker shows its question and options', () => {
    const s: TopState = { ...fixtureState(), mode: { kind: 'detail', taskId: 't-hint' } };
    const t = text(frame(s, 80, 24));
    expect(t).toContain('asks: "Print the URL or open the browser?"');
    expect(t).toContain('options: Print the URL / Open the browser');
  });

  test('a task with no agent says so', () => {
    const s: TopState = { ...fixtureState(), mode: { kind: 'detail', taskId: 't-top' } };
    const t = text(frame(s, 80, 24));
    expect(t).toContain('waits on: name override');
    expect(t).toContain('This runner has not started an agent on it.');
  });
});

describe('footer', () => {
  test('80 columns keep navigation and filtering before rare agent actions', () => {
    const footer = stripAnsi(frame(fixtureState(), 80, 24)[23]);
    for (const hint of ['↑↓ move', '⏎ open', '/ filter', 'o web', '? help', 'q quit']) expect(footer).toContain(hint);
    for (const hint of ['p pause', 'x stop']) expect(footer).not.toContain(hint);
  });

  test('answer prompt', () => {
    const s: TopState = { ...fixtureState(), mode: { kind: 'input', purpose: 'answer', text: 'Print it', taskId: 't-hint', workerId: 'w-hint' } };
    expect(stripAnsi(frame(s, 80, 24)[23])).toMatch(/^ answer › Print it▏ +$/);
  });

  test('the answer prompt is framed in the accent, its text in primary', () => {
    const p = createPalette('night', 'truecolor');
    const s: TopState = { ...fixtureState(), mode: { kind: 'input', purpose: 'answer', text: 'yes', taskId: 't-hint', workerId: 'w-hint' } };
    const last = frame(s, 80, 24, p)[23];
    expect(last.startsWith(p.fgCode('accent') + ' answer › ')).toBe(true);
    expect(last).toContain(p.fgCode('text') + 'yes');
  });

  test('stop asks first', () => {
    const s: TopState = { ...fixtureState(), mode: { kind: 'confirm', purpose: 'stop', taskId: 't-name', workerId: 'w-name' } };
    expect(stripAnsi(frame(s, 80, 24)[23])).toContain('Stop the agent on "name override"? y stops it');
  });

  test('a status line replaces the hints', () => {
    const s: TopState = { ...fixtureState(), status: { text: 'Answer refused: worker is not waiting (HTTP 409)', tone: 'error' } };
    expect(stripAnsi(frame(s, 80, 24)[23]).trim()).toBe('Answer refused: worker is not waiting (HTTP 409)');
  });
});

test('fit cuts with an ellipsis and pads to the width', () => {
  expect(fit('abcdef', 4)).toBe('abc…');
  expect(fit('ab', 4)).toBe('ab  ');
  expect(fit('ab', 4, 'right')).toBe('  ab');
  expect(textWidth(fit('日本語のタイトル', 7))).toBe(7);
});

describe('revision 2 (R-17, R-19, R-21, AC-6)', () => {
  const truecolor = createPalette('day', 'truecolor');
  const SGR_FG = /\x1b\[(?:39|38;[0-9;]+)m/g;

  /** The last foreground SGR before `needle` on a line. */
  function fgBefore(line: string, needle: string): string | undefined {
    const at = line.indexOf(needle);
    expect(at).toBeGreaterThan(-1);
    return line.slice(0, at).match(SGR_FG)?.at(-1);
  }

  test('row titles are drawn in the terminal default foreground (AC-6)', () => {
    const s = { ...fixtureState(), focus: 'missions' as const };
    const lines = frame(s, 80, 24, truecolor);
    for (const title of ['name override', 'installer hint', 'single instance', 'buildd top', 'docs page', 'spec draft']) {
      const line = lines.find(l => stripAnsi(l).includes(title))!;
      expect(fgBefore(line, title)).toBe('\x1b[39m');
    }
  });

  test('the selected row pairs the theme text colour with its own background', () => {
    const lines = frame(fixtureState(), 80, 24, truecolor);
    const line = lines.find(l => stripAnsi(l).includes('name override'))!;
    expect(fgBefore(line, 'name override')).toBe(truecolor.fgCode('selectedText'));
  });

  test('a cut title never runs into the role column (R-21)', () => {
    const long = 'Verify the repository access token for every workspace';
    const s = reduce(fixtureState(), {
      type: 'tasks',
      tasks: [...TASKS, { id: 't-long', title: long, status: 'pending', missionId: TASKS[0].missionId, mission: TASKS[0].mission, roleSlug: 'ops' }],
    });
    for (const cols of [80, 120]) {
      const t = text(frame(s, cols, 30));
      const row = t.split('\n').find(l => l.includes('Verify the'))!;
      expect(row).toMatch(/… +Ops/);
    }
    // Every row: something then at least one space before the role.
    for (const l of text(frame(fixtureState(), 80, 24)).split('\n')) {
      expect(l).not.toMatch(/\S(Builder|Writer)\b/);
    }
  });

  test('the header names the workspaces served (R-19)', () => {
    const s = reduce(fixtureState(), { type: 'workspaces', workspaces: [
      { id: 'ws-a', name: 'alpha', teamId: 'team-1', teamName: 'Acme' },
      { id: 'ws-b', name: 'bravo', teamId: 'team-1', teamName: 'Acme' },
    ] });
    for (const cols of [80, 120]) {
      const head = stripAnsi(frame(s, cols, 24)[0]);
      expect(head).toContain('2 workspaces · Acme');
      expect(textWidth(head)).toBe(cols);
    }
  });

  test('the mission row and heading say the stage in words (R-18, AC-7)', () => {
    const stage = { step: 'verifying' as const, waitingOn: '2 checks left' };
    const mission = { ...TASKS[0].mission!, stage };
    const s = reduce(fixtureState(), { type: 'tasks', tasks: TASKS.map(t => (t.missionId === mission.id ? { ...t, mission } : t)) });
    for (const cols of [80, 120]) {
      const lines = text(frame(s, cols, 24)).split('\n');
      const row = lines.find(l => l.includes('▸'))!;
      expect(row).toContain('verifying');
      // R-31: done over total stays beside the stage word.
      expect(row.split('│')[0]).toMatch(/verifying 2\/8 $/);
      // The title, then the live counts; the stage and what it waits on on the line under it.
      expect(lines[3]).toMatch(/│ Runner TUI +\d+ running · \d+ waiting $/);
      expect(lines[4].split('│')[1]).toBe(' Verifying · 2 checks left'.padEnd(cols - (cols >= 110 ? 28 : 22) - 1));
      for (const l of lines) expect(textWidth(l)).toBeLessThanOrEqual(cols);
    }
  });

  test('without a stage the row shows done/total only', () => {
    const lines = text(frame(fixtureState(), 80, 24)).split('\n');
    expect(lines.find(l => l.includes('▸'))!).toContain('2/8');
    expect(lines[3]).not.toMatch(/building|verifying|merging|done|paused|delivering|delivered|on hold/i);
    // Without a stage, the status line counts the tasks in words.
    expect(lines[4]).toContain('│ 2 of 8 tasks done');
  });

  test('a selected workspace is named in the heading', () => {
    const s = reduce(reduce(fixtureState(), { type: 'workspaces', workspaces: [{ id: 'ws-a', name: 'alpha' }, { id: 'ws-b', name: 'bravo' }] }), {
      type: 'tasks', tasks: TASKS.map(t => ({ ...t, workspaceId: 'ws-a' })),
    });
    const t = text(frame({ ...s, selectedWorkspace: 'ws-a' }, 80, 24));
    expect(t.split('\n')[3]).toContain('alpha · Runner TUI');
  });

  test('help says what top cannot see and how to change it (R-20)', () => {
    const lines = frame({ ...fixtureState(), mode: { kind: 'help' } }, 80, 24);
    expectExactSize(lines, 80, 24);
    const t = text(lines);
    expect(t).toContain('w');
    expect(t).toMatch(/only the workspaces this runner serves/i);
    expect(t).toMatch(/o opens this runner's page on buildd/i);
    expect(t).toContain('buildd login --workspaces');
  });
});

describe('a provider limit, said once in the header (R-25, AC-11)', () => {
  const resetMs = NOW + 9 * 3_600_000;
  const walled = () => reduce({ ...fixtureState(), selectedMission: NO_MISSION }, {
    type: 'claim_outcome',
    outcome: { at: NOW - 5_000, reason: 'budget_exhausted', walls: [{ kind: 'account_seat', backend: 'claude', resetsAt: new Date(resetMs).toISOString() }] },
  });

  test('one header line names the limit and the local time it lifts; rows stay short; 80x24 still fits', () => {
    const lines = frame(walled(), 80, 24);
    expectExactSize(lines, 80, 24);
    const t = text(lines).split('\n');
    expect(t[2]).toContain(`Claude work waits for the plan limit: resumes ${localLiftTime(new Date(resetMs).toISOString(), NOW)} (in 9h)`);
    const row = t.find(l => l.includes('fix flaky test'))!;
    expect(row).toContain('plan limit');
    expect(row).not.toContain('resumes');
    expect(text(lines)).not.toContain('ready, next claim');
    // Said once.
    expect(text(lines).match(/waits for the plan limit/g)!.length).toBe(1);
  });

  // Spec "A runner" R-12, AC-5: whose access waits, and that others are free.
  test("this machine's own login limit says it is this machine's, and that other runners are free", () => {
    const own = reduce({ ...fixtureState(), selectedMission: NO_MISSION }, {
      type: 'claim_outcome',
      outcome: { at: NOW - 5_000, reason: 'budget_exhausted', walls: [{ kind: 'runner_seat', backend: 'claude', resetsAt: new Date(resetMs).toISOString() }] },
    });
    const t = text(frame(own, 120, 24)).split('\n');
    expect(t[2]).toContain(`This machine's Claude login waits for its limit: resumes ${localLiftTime(new Date(resetMs).toISOString(), NOW)} (in 9h) · other runners can take Claude work`);
    expect(text(frame(own, 120, 24))).not.toContain('rate limit');
  });

  test('a shared limit is named as shared, not as a rate limit', () => {
    const shared = reduce({ ...fixtureState(), selectedMission: NO_MISSION }, {
      type: 'claim_outcome',
      outcome: { at: NOW - 5_000, reason: 'budget_exhausted', walls: [{ kind: 'provider_pause', backend: 'claude', resetsAt: new Date(resetMs).toISOString() }] },
    });
    const t = text(frame(shared, 120, 24)).split('\n');
    expect(t[2]).toContain('Claude work waits for a limit every runner shares: resumes');
  });

  test('no limit, no extra line', () => {
    const t = text(frame(fixtureState(), 80, 24)).split('\n');
    expect(t[2]).toMatch(/^─+$/);
  });
});

describe('mission progress at a glance (R-29, R-30, R-31, AC-14, AC-15)', () => {
  const cell = (state: string, group: 'done' | 'active' | 'waiting' | 'checks') => ({ state, group });
  const fill = (n: number, state: string, group: 'done' | 'active' | 'waiting' | 'checks') => Array.from({ length: n }, () => cell(state, group));
  // AC-14's mission: 8 done, 2 running, 3 waiting, plus 2 checks. Includes tasks this runner never ran.
  const AC14 = [...fill(8, 'landed', 'done'), ...fill(2, 'running', 'active'), ...fill(3, 'ready', 'waiting'), ...fill(2, 'review', 'checks')];
  const withProgress = (progress: Array<{ state: string; group: 'done' | 'active' | 'waiting' | 'checks' }>) => {
    const mission = { ...TASKS[0].mission!, stage: { step: 'building' as const, waitingOn: '8 of 13 landed', progress } };
    return reduce(fixtureState(), { type: 'tasks', tasks: TASKS.map(t => (t.missionId === mission.id ? { ...t, mission } : t)) });
  };

  test('80x24', () => {
    const lines = frame(withProgress(AC14), 80, 24);
    expectExactSize(lines, 80, 24);
    expect(text(lines)).toMatchSnapshot();
  });

  test('120x40', () => {
    const lines = frame(withProgress(AC14), 120, 40);
    expectExactSize(lines, 120, 40);
    expect(text(lines)).toMatchSnapshot();
  });

  test('AC-14: under the status line, 8 done squares before 2 in progress and 3 waiting, with the same counts', () => {
    const row = text(frame(withProgress(AC14), 120, 40)).split('\n')[5];
    expect(row).toContain('│ ■■■■■■■■ ▶▶ ▢▢▢ ◐◐   8 done · 2 in progress · 3 ready · 2 checks');
  });

  test('AC-15: at 80 columns a 30-task mission keeps its row on one line, the counts whole', () => {
    const thirty = [...fill(20, 'landed', 'done'), ...fill(3, 'running', 'active'), ...fill(5, 'blocked', 'waiting'), ...fill(2, 'review', 'checks')];
    const lines = frame(withProgress(thirty), 80, 24);
    expectExactSize(lines, 80, 24);
    const t = text(lines).split('\n');
    expect(t[5]).toContain('20 done · ▶ 3 in progress · ▢ 5 blocked · ◐ 2 checks');
    expect(t[5].split('│')[1]).not.toContain('…');
    expect(t[6]).toMatch(/│─+$/);
  });

  test('colours: done in success, in progress in the accent, failed ✗ in error; NO_COLOR keeps the glyphs', () => {
    const p = createPalette('night', 'truecolor');
    const cells = [cell('landed', 'done'), cell('running', 'active'), cell('failed', 'active'), cell('ready', 'waiting')];
    const row = frame(withProgress(cells), 120, 40, p)[5];
    expect(row).toContain(p.fgCode('success') + '■');
    expect(row).toContain(p.fgCode('accent') + '▶');
    expect(row).toContain(p.fgCode('error') + '✗');
    const plainRow = text(frame(withProgress(cells), 120, 40)).split('\n')[5];
    expect(plainRow).toContain('■ ▶✗ ▢   1 done · 2 in progress · 1 ready');
    // eslint-disable-next-line no-control-regex
    expect(frame(withProgress(cells), 120, 40).join('')).not.toMatch(/\x1b/);
  });

  test('R-31: with a stage, the missions pane keeps done over total beside it, and has no squares', () => {
    for (const [cols, rows, lw] of [[80, 24, 22], [120, 40, 28]] as const) {
      const left = text(frame(withProgress(AC14), cols, rows)).split('\n').map(l => l.slice(0, lw));
      const sel = left.find(l => l.includes('▸'))!;
      expect(sel).toMatch(/building 2\/8 $/);
      // The title is what gives way, never the counts.
      expect(sel).toMatch(cols === 80 ? /▸ Runn… building 2\/8/ : /▸ Runner TUI +building 2\/8/);
      expect(left.find(l => l.includes('Specs import'))).toMatch(/1\/2 $/);
      expect(left.filter(l => /[■▶▢◐]/.test(l))).toEqual([]);
    }
  });

  test('no progress from the server, no row', () => {
    const t = text(frame(fixtureState(), 80, 24)).split('\n');
    expect(t[4]).toContain('│ 2 of 8 tasks done');
    expect(t[5]).toMatch(/│─+$/);
  });
});
