/**
 * `h` in `buildd top` (spec "Runner on your terminal" R-33, AC-17): holds or
 * resumes with no confirmation, the header reads "paused" in place of
 * "online" with a line saying since when, what still runs and that h resumes,
 * waiting rows and the Queue view say "paused", and the help lists h.
 */
import { describe, expect, test } from 'bun:test';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { renderFrame, textWidth } from '../../src/top/render';
import { handleKey, actionResultText } from '../../src/top/keys';
import { reduce, holdLine, type TopState } from '../../src/top/state';
import { queueSections } from '../../src/top/queue';
import { NOW, fixtureState } from './top-fixture';
import { queueState } from './top-queue-fixture';

const plain = createPalette('night', 'none');
const frame = (s: TopState, cols: number, rows: number) => renderFrame(s, { cols, rows, now: NOW, palette: plain });
const text = (lines: string[]) => lines.map(l => stripAnsi(l)).join('\n');
const at = (h: number, m: number) => new Date(2026, 2, 10, h, m).toISOString();
const held = (s: TopState, until: string | null = null) => reduce(s, { type: 'runner_hold', hold: { since: at(9, 12), until } });

function expectExactSize(lines: string[], cols: number, rows: number) {
  expect(lines.length).toBe(rows);
  for (const l of lines) expect(textWidth(stripAnsi(l))).toBe(cols);
}

describe('the hold in state', () => {
  test('the init frame and runner_hold frames carry it', () => {
    let s = reduce(fixtureState(), { type: 'init', hold: { since: at(9, 12), until: null } } as any);
    expect(s.runner.hold).toEqual({ since: at(9, 12), until: null });
    s = reduce(s, { type: 'runner_hold', hold: null });
    expect(s.runner.hold).toBeNull();
  });

  test('a junk hold is ignored', () => {
    expect(reduce(fixtureState(), { type: 'runner_hold', hold: { since: 'x' } } as any).runner.hold).toBeNull();
  });

  test('the line says since when, what still runs, and that h resumes', () => {
    // The fixture has two agents working (the asking one holds no slot).
    expect(holdLine(held(fixtureState()), NOW)).toBe('Paused since 09:12: nothing new starts, 2 running finish. h resumes.');
    expect(holdLine(held(fixtureState(), at(17, 0)), NOW)).toBe('Paused since 09:12 until 17:00: nothing new starts, 2 running finish. h resumes now.');
    expect(holdLine(fixtureState(), NOW)).toBeNull();
    const paused = reduce(held(fixtureState()), { type: 'worker_update', worker: { id: 'w-p', taskId: 't-loose', taskTitle: 'fix flaky test', status: 'waiting', waitingFor: { type: 'pause', prompt: 'Paused.' } } as any });
    expect(holdLine(paused, NOW)).toBe('Paused since 09:12: nothing new starts, 2 running finish, 1 paused. h resumes.');
  });

  test('a waiting row says the runner is paused', () => {
    const t = text(frame(held(fixtureState()), 120, 40));
    expect(t).toContain('runner is paused');
  });
});

describe('h', () => {
  test('holds without asking, and says so', () => {
    const r = handleKey(fixtureState(), { name: 'char', ch: 'h' }, NOW);
    expect(r.effects).toEqual([{ type: 'hold', on: true }]);
    expect(r.state.mode.kind).toBe('list');
    expect(r.state.status?.text).toBe('Holding: nothing new starts, running agents finish…');
  });

  test('pressed again resumes', () => {
    const r = handleKey(held(fixtureState()), { name: 'char', ch: 'h' }, NOW);
    expect(r.effects).toEqual([{ type: 'hold', on: false }]);
    expect(r.state.status?.text).toBe('Resuming: looking for work now…');
  });

  test('works in the Queue view and the detail view too', () => {
    const q = handleKey({ ...fixtureState(), view: 'queue' }, { name: 'char', ch: 'h' }, NOW);
    expect(q.effects).toEqual([{ type: 'hold', on: true }]);
    const d = handleKey({ ...fixtureState(), mode: { kind: 'detail', taskId: 't-name' } }, { name: 'char', ch: 'h' }, NOW);
    expect(d.effects).toEqual([{ type: 'hold', on: true }]);
  });

  test('typing h into a message is just a letter', () => {
    const s = { ...fixtureState(), mode: { kind: 'input' as const, purpose: 'message' as const, text: '', taskId: 't-name', workerId: 'w-name' } };
    expect(handleKey(s, { name: 'char', ch: 'h' }, NOW).effects).toEqual([]);
  });

  test('the result line', () => {
    expect(actionResultText({ type: 'hold', on: true }, { status: 200, body: { running: 2 } }).text).toBe('Paused: nothing new starts, 2 running finish. h resumes.');
    expect(actionResultText({ type: 'hold', on: false }, { status: 200, body: { running: 2 } }).text).toBe('Resumed: looking for work now.');
    expect(actionResultText({ type: 'hold', on: true }, { status: 404, body: { error: 'Not found' } }).text).toBe('Hold refused: Not found (HTTP 404)');
  });
});

describe('the frame while held', () => {
  test('80x24: "paused" in place of "online", and the line under the header', () => {
    const lines = frame(held(fixtureState()), 80, 24);
    expectExactSize(lines, 80, 24);
    const t = text(lines);
    expect(lines[0]).toContain('● paused');
    expect(lines[0]).not.toContain('online');
    expect(stripAnsi(lines[1])).toBe(' Paused since 09:12: nothing new starts, 2 running finish. h resumes.'.padEnd(80));
    expect(t).toMatchSnapshot();
  });

  test('120x40', () => {
    const lines = frame(held(fixtureState(), at(17, 0)), 120, 40);
    expectExactSize(lines, 120, 40);
    expect(text(lines)).toMatchSnapshot();
  });

  test('the hold line is the accent colour, not the error colour', () => {
    const color = createPalette('night', 'truecolor');
    const lines = renderFrame(held(fixtureState()), { cols: 80, rows: 24, now: NOW, palette: color });
    const open = (t: 'accent' | 'error') => color.fg(t, 'X').split('X')[0];
    expect(open('accent')).not.toBe(open('error'));
    expect(lines[1].startsWith(open('accent'))).toBe(true);
  });

  test('reconnecting stays reconnecting even while held', () => {
    const s = reduce(held(fixtureState()), { type: 'connection', online: false });
    expect(stripAnsi(frame(s, 80, 24)[0])).toContain('○ reconnecting');
  });

  test('the help lists h', () => {
    const t = text(frame({ ...fixtureState(), mode: { kind: 'help' } }, 120, 40));
    expect(t).toMatch(/ {2}h +hold: running agents finish, nothing new starts; h again resumes/);
  });
});

describe('Queue view while held', () => {
  test('the order stays, with "paused" in place of start times', () => {
    const s = held(queueState());
    const before = queueSections(queueState(), NOW);
    const after = queueSections(s, NOW);
    expect(after.map(x => x.rows.map(r => r.taskId))).toEqual(before.map(x => x.rows.map(r => r.taskId)));
    for (const sec of after) for (const r of sec.rows) expect(r.starts).toBe('paused');
  });
});
