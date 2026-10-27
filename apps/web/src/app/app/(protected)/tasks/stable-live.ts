'use client';

/**
 * What a live update must leave alone on Activity (spec 9430a28f R-7): what is
 * open, what has focus and where the reader is scrolled. A live update renders
 * the view again with new rows; rows are keyed by task id, so most of it is
 * reconciled in place. These cover the rest:
 *
 *  - `useExpandedSet`: open/closed lives in the view, keyed by what it opens
 *    (a row's evidence, its attempts, a verification, a day's earlier steps),
 *    so a row that moves to another group, or behind "+N more waiting", is
 *    still open when it comes back.
 *  - `useKeepFocus`: an element marked `data-focus-key` that had focus and was
 *    replaced (a row that became expandable is a button, not a link) gives it
 *    back to its replacement. Focus a person moved elsewhere is never taken back.
 *  - `useScrollAnchor`: the first `data-scroll-anchor` element on screen stays
 *    where it was when rows above it are added or removed.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface ExpandedApi {
  isOpen(key: string): boolean;
  setOpen(key: string, open: boolean): void;
}

export const ExpandedContext = createContext<ExpandedApi | null>(null);

export function useExpandedSet(initial: readonly string[]): ExpandedApi {
  const [open, setOpenSet] = useState<ReadonlySet<string>>(() => new Set(initial));
  const setOpen = useCallback((key: string, value: boolean) => {
    setOpenSet(prev => {
      if (prev.has(key) === value) return prev;
      const next = new Set(prev);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  return { isOpen: (key: string) => open.has(key), setOpen };
}

/** One open/closed state, kept by the view when there is one (else local, as in a fixture of one row). */
export function useExpanded(key: string, defaultOpen = false): [boolean, (open: boolean) => void] {
  const api = useContext(ExpandedContext);
  const [local, setLocal] = useState(defaultOpen);
  if (!api) return [local, setLocal];
  return [api.isOpen(key), (open: boolean) => api.setOpen(key, open)];
}

const FOCUS_KEY = 'data-focus-key';
const FOCUSABLE = 'a[href],button:not([disabled])';

function focusTarget(root: HTMLElement, key: string): HTMLElement | null {
  const marked = [...root.querySelectorAll<HTMLElement>(`[${FOCUS_KEY}]`)].find(el => el.getAttribute(FOCUS_KEY) === key);
  if (!marked) return null;
  return marked.matches(FOCUSABLE) ? marked : marked.querySelector<HTMLElement>(FOCUSABLE);
}

export function useKeepFocus(rootRef: RefObject<HTMLElement | null>) {
  const key = useRef<string | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onIn = (e: FocusEvent) => {
      key.current = (e.target as Element | null)?.closest?.(`[${FOCUS_KEY}]`)?.getAttribute(FOCUS_KEY) ?? null;
    };
    const onOut = (e: FocusEvent) => {
      const el = e.target as Element | null;
      // Still on the page and nothing else took focus: the person left it. A
      // replaced element is gone from the page, and its key is kept.
      queueMicrotask(() => {
        if (el?.isConnected && !root.contains(document.activeElement)) key.current = null;
      });
    };
    root.addEventListener('focusin', onIn);
    root.addEventListener('focusout', onOut);
    return () => {
      root.removeEventListener('focusin', onIn);
      root.removeEventListener('focusout', onOut);
    };
  }, [rootRef]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const k = key.current;
    if (!root || !k) return;
    const active = document.activeElement;
    // Only give focus back when it fell to nothing (its element was replaced).
    if (active && active !== document.body) return;
    focusTarget(root, k)?.focus({ preventScroll: true });
  });
}

const ANCHOR = 'data-scroll-anchor';

/** The nearest ancestor that scrolls, else the document's scroller. */
function scrollerOf(el: HTMLElement): HTMLElement {
  for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
    if (cur.scrollHeight > cur.clientHeight && /(auto|scroll)/.test(getComputedStyle(cur).overflowY)) return cur;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** How far the anchor moved, so the scroller can follow it; 0 when it is gone. */
export function anchorShift(before: { key: string; top: number } | null, find: (key: string) => number | null): number {
  if (!before) return 0;
  const after = find(before.key);
  return after == null ? 0 : after - before.top;
}

export function useScrollAnchor(rootRef: RefObject<HTMLElement | null>) {
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const capture = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const scroller = scrollerOf(root);
    const viewTop = scroller === document.documentElement || scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    // Nothing to hold while at the top: new rows there should be seen.
    if (scroller.scrollTop <= 0) { anchor.current = null; return; }
    for (const el of root.querySelectorAll<HTMLElement>(`[${ANCHOR}]`)) {
      const r = el.getBoundingClientRect();
      // A layout that is not displayed (Now's phone or desktop arrangement) has no box to hold.
      if (r.height === 0 && r.width === 0) continue;
      if (r.bottom > viewTop) { anchor.current = { key: el.getAttribute(ANCHOR)!, top: r.top }; return; }
    }
    anchor.current = null;
  }, [rootRef]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t === document || (t instanceof Node && t.contains(root))) capture();
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, [rootRef, capture]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const shift = anchorShift(anchor.current, key => {
      const el = [...root.querySelectorAll<HTMLElement>(`[${ANCHOR}]`)].find(e => e.getAttribute(ANCHOR) === key);
      return el ? el.getBoundingClientRect().top : null;
    });
    if (shift !== 0) scrollerOf(root).scrollTop += shift;
    capture();
  });
}
