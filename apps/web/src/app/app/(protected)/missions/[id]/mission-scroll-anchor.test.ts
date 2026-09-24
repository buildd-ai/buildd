/**
 * Scroll anchoring across a refresh (slice S7, "Freeze rule"). Fake elements:
 * each row reports a fixed rect, the scroller reports its own and the
 * sticky masthead's.
 */
import { describe, expect, it } from 'bun:test';
import { addedIds, captureScrollAnchor, restoreScrollAnchor, rowsAbove, visibleTop } from './mission-scroll-anchor';

type Fake = {
  id?: string; top: number; height: number; focused?: boolean; rendered?: boolean; connected?: boolean; testid?: string;
};

function el(f: Fake) {
  return {
    isConnected: f.connected ?? true,
    getAttribute: (k: string) => (k === 'data-task-id' ? f.id ?? null : k === 'data-focused' ? (f.focused ? 'true' : null) : k === 'data-testid' ? f.testid ?? null : null),
    getBoundingClientRect: () => ({ top: f.top, bottom: f.top + f.height }),
    getClientRects: () => (f.rendered === false ? [] : [{}]),
    f,
  };
}

function scroller(rows: ReturnType<typeof el>[], opts: { masthead?: number } = {}) {
  const masthead = opts.masthead != null ? el({ top: 0, height: opts.masthead }) : null;
  return {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0, bottom: 700 }),
    querySelectorAll: () => rows,
    querySelector: (sel: string) => (sel.includes('mission-masthead') ? masthead : null),
  };
}

const rendered = (e: Element) => (e as unknown as { getClientRects(): unknown[] }).getClientRects().length > 0;
const S = (x: unknown) => x as unknown as HTMLElement;

describe('captureScrollAnchor', () => {
  it('anchors the first row below the sticky masthead', () => {
    const rows = [el({ id: 'a', top: -40, height: 52 }), el({ id: 'b', top: 30, height: 52 }), el({ id: 'c', top: 90, height: 52 })];
    const a = captureScrollAnchor(S(scroller(rows, { masthead: 84 })), rendered);
    expect(a?.taskId).toBe('c');
    expect(visibleTop(S(scroller(rows, { masthead: 84 })))).toBe(84);
  });

  it('prefers the focused row when it is on screen', () => {
    const rows = [el({ id: 'a', top: 0, height: 52 }), el({ id: 'b', top: 300, height: 52, focused: true })];
    expect(captureScrollAnchor(S(scroller(rows)), rendered)?.taskId).toBe('b');
  });

  it('ignores a focused row scrolled off screen, and unrendered rows', () => {
    const rows = [el({ id: 'x', top: 10, height: 52, rendered: false }), el({ id: 'a', top: 20, height: 52 }), el({ id: 'b', top: 900, height: 52, focused: true })];
    expect(captureScrollAnchor(S(scroller(rows)), rendered)?.taskId).toBe('a');
  });

  it('no rows → no anchor', () => {
    expect(captureScrollAnchor(S(scroller([])), rendered)).toBeNull();
  });
});

describe('restoreScrollAnchor', () => {
  it('corrects scrollTop by how far the anchor moved', () => {
    const row = el({ id: 'a', top: 100, height: 52 });
    const s = scroller([row]);
    const anchor = { el: row as unknown as Element, taskId: 'a', top: 48 };
    expect(restoreScrollAnchor(S(s), anchor, rendered)).toBe(52);
    expect(s.scrollTop).toBe(52);
  });

  it('falls back to the row with the same task id when the node was remounted', () => {
    const gone = el({ id: 'a', top: 0, height: 52, connected: false });
    const again = el({ id: 'a', top: 10, height: 52 });
    const s = scroller([again]);
    expect(restoreScrollAnchor(S(s), { el: gone as unknown as Element, taskId: 'a', top: 0 }, rendered)).toBe(10);
  });

  it('a vanished anchor changes nothing', () => {
    const s = scroller([]);
    expect(restoreScrollAnchor(S(s), { el: el({ id: 'a', top: 0, height: 1, connected: false }) as unknown as Element, taskId: 'a', top: 0 }, rendered)).toBe(0);
    expect(s.scrollTop).toBe(0);
  });
});

describe('rowsAbove / addedIds', () => {
  it('names only the given rows wholly above the visible top', () => {
    const rows = [el({ id: 'n1', top: -100, height: 52 }), el({ id: 'n2', top: 60, height: 52 }), el({ id: 'old', top: -200, height: 52 })];
    expect(rowsAbove(S(scroller(rows, { masthead: 84 })), new Set(['n1', 'n2']), rendered)).toEqual(['n1']);
  });

  it('addedIds is the set difference, in render order', () => {
    expect(addedIds(new Set(['a', 'b']), ['c', 'a', 'd', 'b'])).toEqual(['c', 'd']);
  });
});
