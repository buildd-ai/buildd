/**
 * Whose work each Queue row is (spec c7410e76 R-58, AC-42): "you" for your
 * own, a teammate's first name for theirs, "-" when buildd cannot tell or an
 * older server sent nothing, on every section, without changing claim order.
 */
import { describe, expect, test } from 'bun:test';
import type { RunnerQueueResponse } from '@buildd/shared';
import { createPalette, stripAnsi } from '../../src/terminal-palette';
import { renderFrame, textWidth } from '../../src/top/render';
import { queueSections } from '../../src/top/queue';
import { reduce } from '../../src/top/state';
import { NOW } from './top-fixture';
import { QUEUE, queueState } from './top-queue-fixture';

const plain = createPalette('night', 'none');

function withOwners(): RunnerQueueResponse {
  const [one, two] = QUEUE.teams;
  return {
    ...QUEUE,
    teams: [
      {
        ...one,
        queue: one.queue.map((t, i) => (i === 0 ? { ...t, owner: 'you' as const } : i === 1 ? { ...t, owner: 'teammate' as const, ownerName: 'Sam' } : i === 2 ? { ...t, owner: 'unattributed' as const } : t)),
        notForRunner: one.notForRunner.map((t, i) => (i === 0 ? { ...t, owner: 'you' as const } : t)),
      },
      two,
    ],
  };
}

const state = () => reduce(queueState(), { type: 'queue', queue: withOwners() });

describe('the by column (R-58, AC-42)', () => {
  test('your task reads "you", a teammate\'s their first name, an unowned one "-", in claim order', () => {
    const rows = queueSections(state(), NOW)[0].rows.filter(r => r.status !== 'running');
    expect(rows.slice(0, 3).map(r => [r.position, r.by])).toEqual([[1, 'you'], [2, 'Sam'], [3, '-']]);
    // An older server without the field: "-".
    expect(rows[3].by).toBe('-');
  });

  test('every section has it, the Not for this runner rows too', () => {
    const notFor = queueSections(state(), NOW)[0].notFor;
    expect(notFor[0].by).toBe('you');
    expect(notFor[1].by).toBe('-');
  });

  test('the frame shows a by column after the title, at 120 and at 80 columns, never wrapping', () => {
    for (const cols of [120, 80]) {
      const lines = renderFrame(state(), { cols, rows: 30, now: NOW, palette: plain });
      for (const l of lines) expect(textWidth(stripAnsi(l))).toBe(cols);
      const t = lines.map(l => stripAnsi(l)).join('\n');
      expect(t).toMatch(/Team One · next for this r\S*\s+by\s/);
      expect(t).toMatch(/1 fix\(kernel\): review co\S*\s+you\s/);
      expect(t).toMatch(/2 feat\(intake\): one inta.*?\s+Sam\s/);
    }
  });
});
