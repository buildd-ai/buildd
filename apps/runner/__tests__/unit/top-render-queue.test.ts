/**
 * `buildd top`'s Queue view frames (spec c7410e76 R-26): the tab line, per
 * team the order this runner takes work with its start, "Not for this
 * runner" below, and 80x24 dropping est. then workspace, never wrapping.
 */
import { describe, expect, test } from 'bun:test';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { queueColumnsFor, renderFrame, textWidth } from '../../src/top/render';
import type { TopState } from '../../src/top/state';
import { NOW, fixtureState } from './top-fixture';
import { queueState } from './top-queue-fixture';

const plain = createPalette('night', 'none');
const frame = (s: TopState, cols: number, rows: number, palette = plain) => renderFrame(s, { cols, rows, now: NOW, palette });
const text = (lines: string[]) => lines.map(l => stripAnsi(l)).join('\n');

function expectExactSize(lines: string[], cols: number, rows: number) {
  expect(lines.length).toBe(rows);
  for (const l of lines) expect(textWidth(stripAnsi(l))).toBe(cols);
}

describe('Queue view (R-26)', () => {
  test('80x24: the tab line, both teams in claim order, est. dropped first, never wrapped', () => {
    const lines = frame(queueState(), 80, 24);
    expectExactSize(lines, 80, 24);
    const t = text(lines);
    expect(stripAnsi(lines[1]).trim()).toMatch(/^Missions  \[ Queue \]   t team: all · w workspace: all\s+3 slots · 1 free$/);
    expect(t).toContain('Team One · next for this runner');
    expect(t).toContain('Not for this runner');
    expect(t).toContain('Blocked · until Thu 00:00');
    expect(t).toContain('Running');
    expect(t).toContain('Queued');
    expect(t).not.toMatch(/\bnow\b/);
    expect(t).toContain('Blocked · after its depen');
    expect(t).not.toMatch(/\bnext\s*$/m);
    expect(t).toContain('Blocked · runs from your');
    expect(t).toContain('another runner');
    expect(t).not.toContain('est.');
    expect(t).toContain('workspace');
    expect(t).not.toContain('Mission: plan the kernel');
    expect(t).toMatchSnapshot();
  });

  test('120x40: est. shows for the team that has estimates on, and not for the one that does not', () => {
    const lines = frame(queueState(), 120, 40);
    expectExactSize(lines, 120, 40);
    const t = text(lines);
    const one = lines.findIndex(l => stripAnsi(l).includes('Team One · next for this runner'));
    const two = lines.findIndex(l => stripAnsi(l).includes('Team Two · next for this runner'));
    expect(stripAnsi(lines[one])).toContain('est.');
    expect(stripAnsi(lines[two])).not.toContain('est.');
    expect(t).toMatch(/1 fix\(kernel\): review compo\S*\s+-\s+alpha\s+Workflow kern\S*\s+40m\s+Blocked · until Thu 00:00/);
    expect(t).toMatchSnapshot();
  });

  test('60 columns: workspace goes too; the title, mission and start stay', () => {
    const lines = frame(queueState(), 60, 24);
    expectExactSize(lines, 60, 24);
    const t = text(lines);
    expect(t).not.toContain('workspace  ');
    expect(t).toContain('Blocked');
    expect(t).toContain('Queued');
    expect(queueColumnsFor(60, true)).toMatchObject({ est: false, workspace: false });
    // 80 columns keeps "Blocked · until Thu 00:00" whole and drops workspace.
    expect(queueColumnsFor(80, true)).toMatchObject({ est: false, workspace: false, starts: 26 });
    expect(queueColumnsFor(100, true)).toMatchObject({ workspace: true });
    expect(queueColumnsFor(120, true)).toMatchObject({ est: true, workspace: true });
  });

  test('the selected row that starts alongside an open PR says so on the line under it (AC-39)', () => {
    const base = queueState();
    const q = base.queue!;
    const queue = { ...q, teams: [{ ...q.teams[0], queue: q.teams[0].queue.map(t => t.id === 'q-intake' ? { ...t, alongside: { prNumber: 41, holderTaskId: null } } : t) }, q.teams[1]] };
    const off = text(frame({ ...base, queue }, 80, 24));
    expect(off).not.toContain('starts alongside');
    const lines = frame({ ...base, queue, queueCursor: 3 }, 80, 24);
    expectExactSize(lines, 80, 24);
    const at = lines.findIndex(l => stripAnsi(l).includes('feat(intake): one intake door'));
    expect(stripAnsi(lines[at + 1]).trim()).toBe('starts alongside #41 (same files, merges at the end)');
  });

  test('every width from 40 to 160 keeps every line exactly as wide as the terminal', () => {
    for (let cols = 40; cols <= 160; cols += 7) expectExactSize(frame(queueState(), cols, 24), cols, 24);
  });

  test('the selected row is marked even without colour', () => {
    const lines = frame(queueState({ queueCursor: 3 }), 80, 24);
    expect(lines.find(l => l.includes('feat(intake)'))!.startsWith('›')).toBe(true);
  });

  test('a long queue scrolls to keep the selection in view', () => {
    const s = queueState();
    const lines = frame({ ...s, queueCursor: 11 }, 80, 12);
    expectExactSize(lines, 80, 12);
    expect(text(lines)).toContain('fix(billing): round half up');
  });

  test('before the first read, and with nothing waiting, it says so in words', () => {
    expect(text(frame({ ...fixtureState(), view: 'queue' }, 80, 24))).toContain('Reading the queue…');
    expect(text(frame(queueState({ queue: { teams: [], truncated: false } }), 80, 24))).toContain('Nothing is waiting for this runner.');
  });

  test('the footer names Tab back to Missions', () => {
    expect(stripAnsi(frame(queueState(), 120, 24)[23])).toContain('tab missions');
    expect(stripAnsi(frame(fixtureState(), 120, 24)[23])).toContain('tab queue');
  });

  test('colour does not change the text', () => {
    const colour = frame(queueState(), 80, 24, createPalette('night', 'truecolor'));
    expect(text(colour)).toBe(text(frame(queueState(), 80, 24)));
  });
});
