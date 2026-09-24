/**
 * Scroll anchoring across a mission refresh (docs/design/mission-feed-mobile-continuity.md,
 * "Freeze rule", slice S7).
 *
 * The page scrolls inside `<main class="overflow-y-auto">`, and iOS Safari's
 * `overflow-anchor` is not trusted inside a scroll container. So before a
 * `router.refresh()` the focused row (else the first visible row) has its
 * `getBoundingClientRect().top` recorded; after the new render commits,
 * `scrollTop` is corrected by the difference. A task inserted above the
 * viewport therefore never pushes what the reader is looking at down — the
 * `N new ↑` pill says it arrived instead.
 */

/** Anything with a task id that the page renders as a row. Slots are markers, not anchors. */
export const ROW_SELECTOR = '[data-task-id]:not([data-testid="mission-task-slot"])';

export interface ScrollAnchor {
  el: Element;
  taskId: string;
  top: number;
}

/** Rendered = laid out. A folded (`hidden`) row or the md:hidden mobile list at desktop width is not. */
export const isRendered = (el: Element): boolean => el.getClientRects().length > 0;

function rows(scroller: Element, rendered: (el: Element) => boolean): Element[] {
  return Array.from(scroller.querySelectorAll(ROW_SELECTOR)).filter(rendered);
}

/** The sticky masthead's bottom edge, or the scroller's top when there is none. */
export function visibleTop(scroller: Element): number {
  const top = scroller.getBoundingClientRect().top;
  const masthead = scroller.querySelector('[data-testid="mission-masthead"]');
  const bottom = masthead ? masthead.getBoundingClientRect().bottom : top;
  return Math.max(top, bottom);
}

/**
 * Record the row the reader is anchored to: the focused row when it is on
 * screen, else the first row whose bottom is below the visible top.
 */
export function captureScrollAnchor(
  scroller: Element,
  rendered: (el: Element) => boolean = isRendered,
): ScrollAnchor | null {
  const all = rows(scroller, rendered);
  if (all.length === 0) return null;
  const top = visibleTop(scroller);
  const bottom = scroller.getBoundingClientRect().bottom;
  const focused = all.find(el => el.getAttribute('data-focused') === 'true');
  if (focused) {
    const r = focused.getBoundingClientRect();
    if (r.bottom > top && r.top < bottom) return { el: focused, taskId: focused.getAttribute('data-task-id')!, top: r.top };
  }
  const first = all.find(el => el.getBoundingClientRect().bottom > top);
  if (!first) return null;
  return { el: first, taskId: first.getAttribute('data-task-id')!, top: first.getBoundingClientRect().top };
}

/**
 * Put the anchor back where it was. React usually keeps the same node; when
 * it remounted (the row changed group), the row with the same task id stands
 * in. Returns the correction applied.
 */
export function restoreScrollAnchor(
  scroller: HTMLElement,
  anchor: ScrollAnchor,
  rendered: (el: Element) => boolean = isRendered,
): number {
  let el: Element | null = anchor.el.isConnected && rendered(anchor.el) ? anchor.el : null;
  if (!el) {
    el = rows(scroller, rendered).find(r => r.getAttribute('data-task-id') === anchor.taskId) ?? null;
  }
  if (!el) return 0;
  const delta = el.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) < 1) return 0;
  scroller.scrollTop += delta;
  return delta;
}

/** Of `taskIds`, those whose rows sit wholly above the visible top. */
export function rowsAbove(
  scroller: Element,
  taskIds: ReadonlySet<string>,
  rendered: (el: Element) => boolean = isRendered,
): string[] {
  if (taskIds.size === 0) return [];
  const top = visibleTop(scroller);
  const out: string[] = [];
  for (const el of rows(scroller, rendered)) {
    const id = el.getAttribute('data-task-id')!;
    if (taskIds.has(id) && !out.includes(id) && el.getBoundingClientRect().bottom <= top) out.push(id);
  }
  return out;
}

/** Ids in `next` that were not in `prev`. */
export function addedIds(prev: ReadonlySet<string>, next: readonly string[]): string[] {
  return next.filter(id => !prev.has(id));
}
