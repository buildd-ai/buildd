/**
 * MissionShippedHeader mounted (happy-dom): the lede in the header, hero shots
 * opening the review deck, and the no-screenshots and mechanical-only variants.
 * Illustrative fixtures only.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const openDeck = mock((_key: string | null) => {});
let reviewValue: unknown = null;
mock.module('./MissionVisualReview', () => ({ useMissionVisualReview: () => reviewValue }));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionShippedHeader } = await import('./MissionShippedHeader');
const { buildShippedHeaderView } = await import('@/lib/mission-shipped-header');

const COMPLETED_AT = '2026-01-02T00:00:00.000Z';
const baseRecord = {
  version: 1 as const,
  lede: 'On a phone, the home screen now opens on what needs you.',
  changeType: 'frontend' as const,
  heroShots: [
    { artifactId: 'a-mobile', route: '/app/home', viewport: 'mobile' as const, verdict: 'ok' as const },
    { artifactId: 'a-gone', route: '/app/tasks', viewport: 'desktop' as const, verdict: 'ok' as const },
  ],
  offPlan: [] as string[],
  authorTaskId: 't1',
  origin: 'author' as const,
  completedAt: COMPLETED_AT,
};

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  openDeck.mockClear();
  reviewValue = {
    openDeck,
    model: { cells: [{ key: 'home|mobile', history: [{ shot: { id: 'a-mobile', src: '/api/artifacts/a-mobile/download' } }] }] },
  };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mount = (over: Record<string, unknown> = {}) => {
  const view = buildShippedHeaderView({ ...baseRecord, ...over }, COMPLETED_AT)!;
  act(() => root.render(<MissionShippedHeader missionId="m1" view={view} />));
};
const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('record present', () => {
  it('is the #what-shipped anchor, with the lede and the change-type chip', () => {
    mount();
    expect(container.querySelector('#what-shipped')).not.toBeNull();
    expect(q('shipped-lede')!.textContent).toContain('home screen now opens');
    expect(q('shipped-change-type')!.textContent).toBe('Frontend');
    expect(q('mission-shipped-header')!.dataset.variant).toBe('lede');
  });

  it('a hero shot with a deck cell opens the review deck at that cell', () => {
    mount();
    const shots = [...container.querySelectorAll<HTMLElement>('[data-testid="shipped-hero-shot"]')];
    expect(shots).toHaveLength(2);
    act(() => shots[0].click());
    expect(openDeck).toHaveBeenCalledWith('home|mobile');
  });

  it('a hero shot with no deck cell falls back to the full-size image', () => {
    mount();
    const shots = [...container.querySelectorAll<HTMLElement>('[data-testid="shipped-hero-shot"]')];
    expect(shots[1].tagName).toBe('A');
    expect(shots[1].getAttribute('href')).toBe('/api/artifacts/a-gone/download');
  });

  it('without a visual review provider every shot is a full-size link', () => {
    reviewValue = null;
    mount();
    const shots = [...container.querySelectorAll<HTMLElement>('[data-testid="shipped-hero-shot"]')];
    expect(shots.every(s => s.tagName === 'A')).toBe(true);
  });

  it('shows off-plan lines only when present', () => {
    mount();
    expect(q('shipped-off-plan')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    mount({ offPlan: ['One planned cleanup was dropped.'] });
    expect(q('shipped-off-plan')!.textContent).toContain('Off plan');
    expect(q('shipped-off-plan')!.textContent).toContain('One planned cleanup was dropped.');
  });
});

describe('no shots', () => {
  it('a frontend change says no screenshots were captured and renders no thumbnails', () => {
    mount({ heroShots: [] });
    expect(q('shipped-no-screenshots')!.textContent).toBe('No screenshots were captured for this change.');
    expect(q('shipped-hero-shots')).toBeNull();
    expect(q('shipped-lede')).not.toBeNull();
  });

  it('a backend change does not mention screenshots', () => {
    mount({ heroShots: [], changeType: 'backend' });
    expect(q('shipped-no-screenshots')).toBeNull();
  });
});

describe('mechanical-only', () => {
  it('no lede: chip and facts only, never invented prose', () => {
    mount({ lede: null, origin: 'no_author', heroShots: [] });
    expect(q('shipped-lede')).toBeNull();
    expect(q('mission-shipped-header')!.dataset.variant).toBe('mechanical');
    expect(q('shipped-change-type')!.textContent).toBe('Frontend');
    expect(q('shipped-no-screenshots')).not.toBeNull();
  });

  it('labels a hand-completed mission', () => {
    mount({ lede: null, origin: 'manual', changeType: null, heroShots: [] });
    expect(q('shipped-by-hand')!.textContent).toBe('Completed by hand');
    expect(q('shipped-change-type')).toBeNull();
  });
});
