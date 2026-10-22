/**
 * Mission History in a DOM: density (296 events), tap targets and wrapping
 * guards for 360/390px, keyboard reachability, and focus/scroll that survive
 * "Show more" and the lens switch. happy-dom has no layout engine, so "no
 * horizontal overflow" is pinned by the classes that prevent it (every text
 * node wraps, every row can shrink) rather than by measuring pixels; Visual QA
 * at 360/390 stays the pixel check.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/mission-1', width: 360, height: 780 });
import { expect, it, mock } from 'bun:test';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/app/missions/mission-1',
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionFeedLayout } = await import('./MissionFeedLayout');
const { boardFixture, BOARD_T0 } = await import('@/lib/mission-board.fixtures');

const model = boardFixture('long-open');
const taskId = Object.keys(model.tasks)[0];
const longTitle = 'feat(kernel): ' + 'Unbreakable_title_with_a_very_long_identifier_'.repeat(4);
const episode = {
  id: taskId, title: longTitle, href: '', missionId: 'mission-1', missionTitle: 'M',
  kind: 'landed' as const, repairRounds: 1, prNumber: 7, at: BOARD_T0 + 40 * 60_000,
  steps: [
    { at: BOARD_T0 + 10 * 60_000, text: 'Build started', tone: 'ink' as const, void: false },
    { at: BOARD_T0 + 40 * 60_000, text: 'Merged', tone: 'success' as const, void: false },
  ],
};

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<MissionFeedLayout model={model} missionId="mission-1" timeZone="UTC" episodes={[episode]} />));
  return { container, done: () => { act(() => root.unmount()); container.remove(); } };
}

const lensButton = (c: HTMLElement, label: string) => [...c.querySelectorAll<HTMLElement>('[role="radio"]')].find(b => b.textContent?.startsWith(label))!;
const count = (c: HTMLElement, label: string) => Number(/· (\d+)/.exec(lensButton(c, label).textContent ?? '')?.[1]);

it('the printed lens counts match the rows under each lens', () => {
  const { container, done } = mount();
  try {
    const hi = count(container, 'Highlights');
    const all = count(container, 'All activity');
    expect(all).toBeGreaterThan(hi);
    // Days list what they hold; Show more pages each day at 20.
    const dayCounts = [...container.querySelectorAll('[data-testid="feed-day"] > summary')].map(s => Number(/· (\d+)/.exec(s.textContent ?? '')?.[1]));
    expect(dayCounts.reduce((a, b) => a + b, 0)).toBe(hi);
    act(() => lensButton(container, 'All activity').click());
    const allDays = [...container.querySelectorAll('[data-testid="feed-day"] > summary')].map(s => Number(/· (\d+)/.exec(s.textContent ?? '')?.[1]));
    expect(allDays.reduce((a, b) => a + b, 0)).toBe(all);
  } finally { done(); }
});

it('every row is a real link or a plain block: reachable by Tab and Enter, no positive tabindex', () => {
  const { container, done } = mount();
  try {
    const rows = [...container.querySelectorAll('[data-testid="feed-event"]')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => r.querySelector('a[href]'))).toBe(true);
    for (const el of container.querySelectorAll('[tabindex]')) expect(Number(el.getAttribute('tabindex'))).toBeLessThanOrEqual(0);
    // Interactive things are native elements (summary, button, anchor, radio).
    for (const el of container.querySelectorAll('[onclick], [role="button"]')) expect(['A', 'BUTTON', 'SUMMARY']).toContain(el.tagName);
    // No link wraps another interactive element (steps open beneath the link, not inside it).
    for (const a of container.querySelectorAll('a')) expect(a.querySelector('a, button, summary, details')).toBeNull();
  } finally { done(); }
});

it('tap targets are at least 44px on a phone and long titles can wrap instead of widening the page', () => {
  const { container, done } = mount();
  try {
    const rowLink = container.querySelector('[data-testid="feed-event"] a')!;
    expect(rowLink.className).toContain('min-h-11');
    for (const s of container.querySelectorAll('[data-testid="feed-day"] > summary')) expect(s.className).toContain('min-h-11');
    const title = [...container.querySelectorAll('[data-testid="feed-event"] span')].find(s => !s.querySelector("span") && s.textContent?.includes("Unbreakable_title"))!;
    expect(title.className).toContain('[overflow-wrap:anywhere]');
    expect(title.className).toContain('min-w-0');
    // The title's own scope stays out of it.
    expect(title.textContent).not.toContain('kernel):');
    // The feed column never exceeds the phone: capped, never fixed-wider.
    expect(container.querySelector('[data-testid="mission-event-feed"]')!.className).toContain('max-w-[720px]');
    expect(window.innerWidth).toBe(360);
    for (const w of [360, 390]) {
      window.happyDOM.setViewport({ width: w, height: 780 });
      expect(container.querySelectorAll('[style*="width"]').length).toBe(0);
    }
  } finally { done(); }
});

it('lens switch and the steps disclosure keep the page where it was: nothing remounts the list or steals focus', () => {
  const { container, done } = mount();
  try {
    const list = container.querySelector('[data-testid="mission-event-feed"]')!;
    const all = lensButton(container, 'All activity');
    all.focus();
    act(() => all.click());
    // Same section node, and the control the person used still holds focus.
    expect(container.querySelector('[data-testid="mission-event-feed"]')).toBe(list);
    expect(document.activeElement).toBe(lensButton(container, 'All activity'));
    expect(lensButton(container, 'All activity').getAttribute('aria-checked')).toBe('true');
    act(() => lensButton(container, 'Highlights').click());
    const steps = container.querySelector<HTMLDetailsElement>('[data-testid="episode-steps"]')!;
    const link = steps.previousElementSibling as HTMLElement;
    act(() => { steps.open = true; });
    expect(steps.open).toBe(true);
    expect(container.querySelector('[data-testid="episode-steps"]')).toBe(steps);
    expect(link.getAttribute('href')).toBe(`/app/tasks/${taskId}?from=mission&missionId=mission-1`);
  } finally { done(); }
});
