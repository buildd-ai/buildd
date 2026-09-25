/**
 * VisualReviewStrip, mounted (happy-dom): the lightbox opens from a thumb,
 * ←/→ walk the run and wrap, Escape closes, and an image that fails to load
 * (a 30-day-expired object) becomes an "expired" tile.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 * Illustrative fixtures only.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { toVisualShots } = await import('@/lib/mission-visual-review');
const { default: VisualReviewStrip } = await import('./VisualReviewStrip');

const shot = (id: string, route: string, viewport: string, verdict: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'screenshot',
  createdAt: '2026-03-10T10:00:00.000Z',
  metadata: { qa: { runKey: 'run-a', route, viewport, verdict, finding: `Finding for ${id}.`, ...extra } },
});

const shots = toVisualShots([
  shot('a', '/app/tasks', 'mobile', 'ok', { theme: 'dark' }),
  shot('b', '/app/tasks', 'desktop', 'issue', { fixTaskId: 'fix-1' }),
  shot('c', '/app/missions', 'mobile', 'unsure'),
]);

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<VisualReviewStrip shots={shots} missionId="m1" />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const thumbs = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="visual-review-thumb"]')];
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const route = () => dialog()!.querySelector('[data-testid="visual-review-lightbox-route"]')!.textContent;
const key = (k: string) => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });

describe('VisualReviewStrip lightbox', () => {
  it('opens on the clicked shot with its route, viewport, verdict and finding', () => {
    act(() => thumbs()[1].click());
    const d = dialog()!;
    expect(d).not.toBeNull();
    expect(route()).toBe('/app/tasks');
    expect(d.textContent).toContain('Shot 2 / 3');
    expect(d.textContent).toContain('desktop');
    expect(d.textContent).toContain('issue');
    expect(d.textContent).toContain('Finding for b.');
  });

  it('links the fix task through the task page href, and shows no link without one', () => {
    act(() => thumbs()[1].click());
    const link = dialog()!.querySelector<HTMLAnchorElement>('[data-testid="visual-review-fix-task"]')!;
    expect(link.getAttribute('href')).toContain('fix-1');
    key('ArrowRight');
    expect(dialog()!.querySelector('[data-testid="visual-review-fix-task"]')).toBeNull();
  });

  it('walks the run with the arrow keys and wraps at both ends', () => {
    act(() => thumbs()[0].click());
    expect(dialog()!.textContent).toContain('Shot 1 / 3');
    key('ArrowLeft');
    expect(dialog()!.textContent).toContain('Shot 3 / 3');
    key('ArrowRight');
    expect(dialog()!.textContent).toContain('Shot 1 / 3');
    key('ArrowRight');
    expect(dialog()!.textContent).toContain('Shot 2 / 3');
  });

  it('walks with the Prev / Next buttons too', () => {
    act(() => thumbs()[2].click());
    const next = [...dialog()!.querySelectorAll('button')].find(b => b.textContent?.includes('Next'))!;
    act(() => next.click());
    expect(dialog()!.textContent).toContain('Shot 1 / 3');
  });

  it('closes on Escape', () => {
    act(() => thumbs()[0].click());
    key('Escape');
    expect(dialog()).toBeNull();
  });

  it('swaps a thumb that fails to load for an expired tile, and the lightbox follows', () => {
    const img = thumbs()[0].querySelector('img')!;
    act(() => { img.dispatchEvent(new Event('error')); });
    expect(thumbs()[0].querySelector('img')).toBeNull();
    expect(thumbs()[0].querySelector('[data-testid="visual-review-expired"]')).not.toBeNull();
    act(() => thumbs()[0].click());
    expect(dialog()!.querySelector('img')).toBeNull();
    expect(dialog()!.querySelector('[data-testid="visual-review-expired"]')).not.toBeNull();
  });
});
