/**
 * DesignPreview, mounted (happy-dom) in a 390px phone column:
 *
 * - The picker moves the frame to `…#<screen-id>` and rewrites `?screen=` in
 *   the address bar, so the page stays a shareable deep link.
 * - A desktop screen fits the phone column by CSS transform; "100%" shows it
 *   at true size inside a scrolling column; "Fit" shrinks it again.
 * - A phone screen in a phone column is not scaled at all.
 *
 * happy-dom has no layout: clientWidth is stubbed and ResizeObserver is a
 * recording fake. Runs in its own process (scripts/run-unit-tests.ts).
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/components/DesignPreview.dom.test.tsx
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/artifacts/a1?screen=desktop-mission&revision=2', width: 390, height: 844 });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeResizeObserver {
  static live = new Set<FakeResizeObserver>();
  constructor(private cb: () => void) {}
  observe() { FakeResizeObserver.live.add(this); }
  unobserve() {}
  disconnect() { FakeResizeObserver.live.delete(this); }
  static fire() { for (const ro of FakeResizeObserver.live) ro.cb(); }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;

let columnWidth = 358; // 390 minus the page's padding
Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get(this: HTMLElement) {
    return this.dataset.testid === 'design-frame-column' ? columnWidth : 0;
  },
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: DesignPreview } = await import('./DesignPreview');

const signed = 'https://storage.example/b/nav.html?X-Amz-Signature=sig';
const screens = [
  { id: 'phone-mission', name: 'Phone mission', viewport: { width: 390, height: 844 } },
  { id: 'desktop-mission', name: 'Desktop mission', viewport: { width: 1440, height: 900 } },
  { id: 'coverage', name: 'Coverage', viewport: null },
];

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

const q = <T extends HTMLElement>(id: string) => document.querySelector(`[data-testid="${id}"]`) as T | null;
const frame = () => q<HTMLIFrameElement>('design-frame')!;
const box = () => q<HTMLDivElement>('design-frame-box')!;
const picker = () => q<HTMLElement>('design-screen-picker')!;

function mount(initialScreenId: string | null) {
  act(() => {
    root.render(
      <DesignPreview
        artifactId="a1"
        title="Navigation design"
        revision={2}
        frameUrl={signed}
        screens={screens}
        initialScreenId={initialScreenId}
        downloadUrl="/api/artifacts/a1/download"
      />,
    );
  });
}

function choose(id: string) {
  act(() => {
    picker().click();
  });
  const opts = Array.from(document.querySelectorAll('[role="option"]')) as HTMLElement[];
  const name = screens.find((s) => s.id === id)!.name;
  act(() => {
    opts.find((o) => o.textContent?.includes(name))!.click();
  });
}

beforeEach(() => {
  columnWidth = 358;
  window.history.replaceState(null, '', '/app/artifacts/a1?screen=desktop-mission&revision=2');
  FakeResizeObserver.live.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DesignPreview loading state', () => {
  it('shows a themed loading cover until the frame loads, never a white block', () => {
    mount('desktop-mission');
    expect(q('design-frame-loading')?.textContent).toContain('Loading design');
    expect(frame().className).not.toContain('bg-white');
    expect(box().className).toContain('bg-surface-2');
    act(() => {
      frame().dispatchEvent(new Event('load'));
    });
    expect(q('design-frame-loading')).toBeNull();
  });
});

describe('DesignPreview on a 390px phone', () => {
  it('opens the deep-linked desktop screen scaled to fit the column', () => {
    mount('desktop-mission');
    expect(picker().textContent).toContain('Desktop mission');
    expect(frame().getAttribute('src')).toBe(`${signed}#desktop-mission`);
    expect(frame().style.width).toBe('1440px');
    expect(frame().style.height).toBe('900px');
    const scale = Number(/scale\(([\d.]+)\)/.exec(frame().style.transform)![1]);
    expect(scale).toBeCloseTo(358 / 1440, 3);
    expect(box().style.width).toBe(`${Math.round(1440 * scale)}px`);
    expect(box().style.height).toBe(`${Math.round(900 * scale)}px`);
    expect(q('design-zoom-fit')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows a phone screen at true size once the column is at least as wide, never enlarged', () => {
    columnWidth = 390;
    mount('phone-mission');
    expect(frame().style.transform).toBe('scale(1)');
    expect(box().style.width).toBe('390px');
    expect(box().style.height).toBe('844px');
    columnWidth = 1200;
    act(() => FakeResizeObserver.fire());
    expect(frame().style.transform).toBe('scale(1)');
  });

  it('shrinks a phone screen only as much as the page padding takes', () => {
    mount('phone-mission');
    const scale = Number(/scale\(([\d.]+)\)/.exec(frame().style.transform)![1]);
    expect(scale).toBeCloseTo(358 / 390, 3);
    expect(box().style.width).toBe('358px');
  });

  it('the picker moves the frame to the screen and rewrites ?screen= in the address bar', () => {
    mount('desktop-mission');
    choose('phone-mission');
    expect(frame().getAttribute('src')).toBe(`${signed}#phone-mission`);
    const url = new URL(window.location.href);
    expect(url.searchParams.get('screen')).toBe('phone-mission');
    expect(url.searchParams.get('revision')).toBe('2');
    expect(url.pathname).toBe('/app/artifacts/a1');
  });

  it('100% shows the desktop screen unscaled, and Fit shrinks it again', () => {
    mount('desktop-mission');
    act(() => q('design-zoom-full')!.click());
    expect(frame().style.transform).toBe('scale(1)');
    expect(box().style.width).toBe('1440px');
    expect(q('design-zoom-full')!.getAttribute('aria-pressed')).toBe('true');
    act(() => q('design-zoom-fit')!.click());
    expect(frame().style.transform).not.toBe('scale(1)');
    expect(Number.parseInt(box().style.width, 10)).toBeLessThanOrEqual(358);
  });

  it('refits when the column changes width', () => {
    mount('desktop-mission');
    columnWidth = 1200;
    act(() => FakeResizeObserver.fire());
    const scale = Number(/scale\(([\d.]+)\)/.exec(frame().style.transform)![1]);
    expect(scale).toBeCloseTo(1200 / 1440, 3);
  });

  it('a screen with no viewport frames the file at the column width with no zoom control', () => {
    mount('coverage');
    expect(frame().style.width).toBe('100%');
    expect(q('design-zoom-fit')).toBeNull();
    expect(box().style.width).toBe('');
  });

  it('keeps the sandbox after every interaction', () => {
    mount('desktop-mission');
    choose('phone-mission');
    act(() => q('design-zoom-full')!.click());
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame().getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame().hasAttribute('srcdoc')).toBe(false);
  });
});
