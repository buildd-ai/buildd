/**
 * MobilePageHeader, mounted (happy-dom): the measured parts of the fixed stack.
 * happy-dom has no layout, so offsetHeight is stubbed per element and
 * ResizeObserver is a recording fake whose callbacks the test fires.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals and
 * module mocks stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions', width: 390, height: 844 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pathname = '/app/missions';
mock.module('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/** Recording ResizeObserver: tracks live observers so tests can fire and count them. */
class FakeResizeObserver {
  static live = new Set<FakeResizeObserver>();
  targets: Element[] = [];
  constructor(private cb: () => void) {}
  observe(el: Element) {
    this.targets.push(el);
    FakeResizeObserver.live.add(this);
  }
  unobserve() {}
  disconnect() {
    this.targets = [];
    FakeResizeObserver.live.delete(this);
  }
  static fire() {
    for (const ro of FakeResizeObserver.live) ro.cb();
  }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;

// Heights by data-testid / marker, read by the offsetHeight stub below.
const heights = new Map<string, number>();
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement) {
    if (this.dataset.testid === 'mobile-page-header') return heights.get('header') ?? 0;
    if (this.dataset.bannerSlot !== undefined || this.querySelector?.('[data-testid="banner-stub"]'))
      return heights.get('banners') ?? 0;
    return 0;
  },
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MobilePageHeader } = await import('./MobilePageHeader');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

function Header({ banner = true }: { banner?: boolean }) {
  return (
    <MobilePageHeader
      teams={[{ id: 't1', name: 'Example', slug: 'example' }]}
      currentTeamId="t1"
      banners={banner ? <div data-testid="banner-stub">A task needs your input</div> : null}
    />
  );
}

const spacerHeight = () =>
  (document.querySelector('[data-testid="mobile-banner-spacer"]') as HTMLElement | null)?.style.height ?? null;
const headerVar = () => document.documentElement.style.getPropertyValue('--mobile-header-h');

beforeEach(() => {
  pathname = '/app/missions';
  heights.set('header', 53);
  heights.set('banners', 77);
  FakeResizeObserver.live.clear();
  document.documentElement.style.removeProperty('--mobile-header-h');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MobilePageHeader measured stack', () => {
  it('sizes the spacer to the banners and publishes the header height as --mobile-header-h', () => {
    act(() => root.render(<Header />));
    expect(spacerHeight()).toBe('77px');
    expect(headerVar()).toBe('53px');
  });

  it('follows a banner resize (e.g. the title wrapping to another line)', () => {
    act(() => root.render(<Header />));
    heights.set('banners', 101);
    act(() => FakeResizeObserver.fire());
    expect(spacerHeight()).toBe('101px');
  });

  it('spacer is 0 with no banners showing', () => {
    heights.set('banners', 0);
    act(() => root.render(<Header banner={false} />));
    expect(spacerHeight()).toBe('0px');
  });

  it('zeroes --mobile-header-h on a detail page with no header, and restores it on return', () => {
    act(() => root.render(<Header />));
    expect(headerVar()).toBe('53px');
    pathname = '/app/missions/example';
    act(() => root.render(<Header />));
    expect(headerVar()).toBe('0px');
    expect(document.querySelector('[data-testid="mobile-banner-spacer"]')).toBeNull();
    pathname = '/app/missions';
    act(() => root.render(<Header />));
    expect(headerVar()).toBe('53px');
  });

  it('disconnects its ResizeObservers on unmount and on leaving a header page', () => {
    act(() => root.render(<Header />));
    expect(FakeResizeObserver.live.size).toBe(2); // header row + banners
    pathname = '/app/missions/example';
    act(() => root.render(<Header />));
    expect(FakeResizeObserver.live.size).toBe(0);
    pathname = '/app/missions';
    act(() => root.render(<Header />));
    expect(FakeResizeObserver.live.size).toBe(2);
    act(() => root.unmount());
    expect(FakeResizeObserver.live.size).toBe(0);
    root = createRoot(container); // afterEach unmounts again
  });
});
