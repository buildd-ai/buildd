/**
 * The app shell scrolls inside `<main data-scroll-root>` (`(protected)/layout.tsx`),
 * not the document, so `document.body.style.overflow = 'hidden'` locks nothing
 * there. Overlays lock whatever this resolves to.
 */
export const SCROLL_ROOT_ATTR = 'data-scroll-root';

type DocLike = { body: HTMLElement; querySelector?: (selector: string) => Element | null };

/** The shell's scroll container when present, else `body` (pages outside the shell). */
export function findScrollRoot(doc: DocLike): HTMLElement {
  const root = typeof doc.querySelector === 'function' ? doc.querySelector(`[${SCROLL_ROOT_ATTR}]`) : null;
  return (root as HTMLElement | null) ?? doc.body;
}
