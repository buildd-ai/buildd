/**
 * `buildd top` frames (R-3, R-5, R-7): snapshot at 80x24 and 120x40, every line
 * exactly the terminal's width, columns dropped (cost, then role) rather than
 * rows wrapped, and nothing lost under NO_COLOR.
 */
import { describe, expect, test } from 'bun:test';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { columnsFor, fit, renderFrame, textWidth } from '../../src/top/render';
import { reduce, type TopState } from '../../src/top/state';
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
    expect(columnsFor(91)).toEqual({ role: true, cost: true });
    expect(columnsFor(57)).toEqual({ role: true, cost: false });
    expect(columnsFor(37)).toEqual({ role: false, cost: false });
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

  test('a selected workspace is named in the heading', () => {
    const s = reduce(reduce(fixtureState(), { type: 'workspaces', workspaces: [{ id: 'ws-a', name: 'alpha' }, { id: 'ws-b', name: 'bravo' }] }), {
      type: 'tasks', tasks: TASKS.map(t => ({ ...t, workspaceId: 'ws-a' })),
    });
    const t = text(frame({ ...s, selectedWorkspace: 'ws-a' }, 80, 24));
    expect(t.split('\n')[2]).toContain('alpha · Runner TUI');
  });

  test('help says what top cannot see and how to change it (R-20)', () => {
    const lines = frame({ ...fixtureState(), mode: { kind: 'help' } }, 80, 24);
    expectExactSize(lines, 80, 24);
    const t = text(lines);
    expect(t).toContain('w');
    expect(t).toMatch(/only the workspaces this runner serves/i);
    expect(t).toMatch(/o opens this runner's page on buildd/i);
  });
});
