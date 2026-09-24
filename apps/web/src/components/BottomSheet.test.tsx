/**
 * BottomSheet: `lockTarget` and `height="tall"`
 * (docs/design/mission-feed-mobile-continuity.md, "Scroll lock"; AC-9).
 *
 * The page scrolls inside `<main class="overflow-y-auto">`, so locking
 * `document.body` does nothing there. The lock itself is a plain function over
 * an element's style so it is testable without a DOM.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import BottomSheet, { lockScroll, resolveLockTarget } from './BottomSheet';

const fakeEl = (overflow = '') => ({ style: { overflow } }) as unknown as HTMLElement;

describe('resolveLockTarget', () => {
  it('defaults to document.body when no lockTarget is given (existing consumers unchanged)', () => {
    const body = fakeEl();
    expect(resolveLockTarget(undefined, body)).toBe(body);
  });

  it('uses the lockTarget element when it resolves', () => {
    const body = fakeEl();
    const main = fakeEl('auto');
    expect(resolveLockTarget(() => main, body)).toBe(main);
  });

  it('falls back to body when lockTarget resolves to null', () => {
    const body = fakeEl();
    expect(resolveLockTarget(() => null, body)).toBe(body);
  });
});

describe('lockScroll (AC-9)', () => {
  it('locks <main> and leaves body untouched when <main> is the target', () => {
    const body = fakeEl('');
    const main = fakeEl('auto');
    const restore = lockScroll(resolveLockTarget(() => main, body));
    expect(main.style.overflow).toBe('hidden');
    expect(body.style.overflow).toBe('');
    restore();
    expect(main.style.overflow).toBe('auto');
  });

  it('locks body by default and restores its previous value', () => {
    const body = fakeEl('scroll');
    const restore = lockScroll(resolveLockTarget(undefined, body));
    expect(body.style.overflow).toBe('hidden');
    restore();
    expect(body.style.overflow).toBe('scroll');
  });
});

describe('BottomSheet render', () => {
  it('renders nothing when closed', () => {
    expect(renderToStaticMarkup(<BottomSheet open={false} onClose={() => {}} title="x">y</BottomSheet>)).toBe('');
  });

  it('close control is a 44px tap target', () => {
    const html = renderToStaticMarkup(<BottomSheet open onClose={() => {}} title="Task">body</BottomSheet>);
    const close = html.match(/<button[^>]*aria-label="Close"[^>]*>/)?.[0] ?? '';
    expect(close).toContain('w-11');
    expect(close).toContain('h-11');
  });

  it('default height caps at 85vh (unchanged)', () => {
    const html = renderToStaticMarkup(<BottomSheet open onClose={() => {}} title="Records">body</BottomSheet>);
    expect(html).toContain('max-h-[85vh]');
    expect(html).not.toContain('h-[88dvh]');
  });

  it('height="tall" is a fixed 88% sheet with a scrolling body', () => {
    const html = renderToStaticMarkup(
      <BottomSheet open onClose={() => {}} title="Task" height="tall" testId="mission-task-sheet">body</BottomSheet>,
    );
    expect(html).toContain('h-[88dvh]');
    expect(html).toContain('data-testid="mission-task-sheet"');
    expect(html).toContain('aria-label="Task"');
  });
});
