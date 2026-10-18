/**
 * The progress row's glyphs and fitting (spec c7410e76 R-29, R-30, AC-15).
 * Order and groups come from the server; these tests only check how top draws them.
 */
import { describe, expect, test } from 'bun:test';
import { textWidth } from '../../src/top/render';
import { progressCounts, progressMark, progressPieces, type ProgressCell } from '../../src/top/progress';

const cells = (n: number, group: ProgressCell['group'], state = group === 'done' ? 'landed' : group === 'active' ? 'running' : group === 'waiting' ? 'ready' : 'review') =>
  Array.from({ length: n }, () => ({ state, group }));
const text = (pieces: ReturnType<typeof progressPieces>) => (pieces ?? []).map(p => p.text).join('');

const AC14 = [...cells(8, 'done'), ...cells(2, 'active'), ...cells(3, 'waiting'), ...cells(2, 'checks')];

describe('progressMark', () => {
  test('done, in progress, waiting and checks each have their own shape and colour', () => {
    expect(progressMark({ state: 'landed', group: 'done' })).toMatchObject({ ch: '■', token: 'success' });
    expect(progressMark({ state: 'running', group: 'active' })).toMatchObject({ ch: '▶', token: 'accent' });
    expect(progressMark({ state: 'blocked', group: 'waiting' })).toMatchObject({ ch: '▢', token: 'queue' });
    expect(progressMark({ state: 'review', group: 'checks' })).toMatchObject({ ch: '◐', token: 'info' });
  });

  test('a failed task is ✗ in the error colour, wherever it sits', () => {
    for (const state of ['failed', 'ci_failed', 'not_landed']) {
      expect(progressMark({ state, group: state === 'not_landed' ? 'waiting' : 'active' })).toMatchObject({ ch: '✗', token: 'error' });
    }
  });
});

describe('progressCounts', () => {
  test('counts in words, groups with no task left out', () => {
    expect(progressCounts(AC14)).toBe('8 done · 2 in progress · 3 ready · 2 checks');
    expect(progressCounts([...cells(1, 'done'), ...cells(1, 'checks')])).toBe('1 done · 1 check');
  });

  test('waiting says for what: ready, blocked, closed unmerged; never a bare "waiting"', () => {
    const waiting = [...cells(2, 'waiting', 'ready'), ...cells(1, 'waiting', 'blocked'), ...cells(1, 'waiting', 'not_landed')];
    expect(progressCounts([...cells(1, 'done'), ...waiting])).toBe('1 done · 2 ready, 1 blocked, 1 closed unmerged');
    expect(progressCounts(cells(1, 'waiting', 'blocked'))).toBe('1 blocked');
    expect(progressCounts(waiting)).not.toMatch(/waiting/);
  });
});

describe('progressPieces', () => {
  test('AC-14: done squares first, then in progress, then waiting, then checks', () => {
    expect(text(progressPieces(AC14, 90, textWidth))).toBe('■■■■■■■■ ▶▶ ▢▢▢ ◐◐   8 done · 2 in progress · 3 ready · 2 checks');
  });

  test('settled runs collapse first, the way the small strip does', () => {
    const many = [...cells(14, 'done'), ...cells(2, 'active'), ...cells(3, 'waiting')];
    expect(text(progressPieces(many, 50, textWidth))).toBe('■×14 ▶▶ ▢×3   14 done · 2 in progress · 3 ready');
  });

  test('AC-15: 30 tasks fit one line of an 80-column right pane with the counts whole', () => {
    const thirty = [...cells(20, 'done'), ...cells(3, 'active'), ...cells(5, 'waiting'), ...cells(2, 'checks')];
    const room = 56; // 80 columns: 22-column missions pane, divider, one-space indent.
    const t = text(progressPieces(thirty, room, textWidth));
    expect(textWidth(t)).toBeLessThanOrEqual(room);
    for (const words of ['20 done', '3 in progress', '5 ready', '2 checks']) expect(t).toContain(words);
    expect(t).toBe('■ 20 done · ▶ 3 in progress · ▢ 5 ready · ◐ 2 checks');
  });

  test('a failure stays visible when a group shrinks to one glyph', () => {
    const mixed = [...cells(20, 'done'), ...cells(2, 'active'), { state: 'failed', group: 'active' as const }, ...cells(5, 'waiting'), ...cells(2, 'checks')];
    expect(text(progressPieces(mixed, 56, textWidth))).toContain('▶✗ 3 in progress');
  });

  test('no cells, no row (an older server)', () => {
    expect(progressPieces(undefined, 80, textWidth)).toBeNull();
    expect(progressPieces([], 80, textWidth)).toBeNull();
  });
});
