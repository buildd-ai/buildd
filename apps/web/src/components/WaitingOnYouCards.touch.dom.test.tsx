/**
 * Home's merge and review cards on a touch phone: every action is a 44px
 * target (`min-h-11`, released to desktop density at `md:`), and the confirm
 * strip wraps its sentence above the buttons instead of crowding them.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/home' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ActionQueueItem } from '@/lib/action-queue';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {} }),
  usePathname: () => '/app/home',
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WaitingOnYouMergeCard } = await import('./WaitingOnYouMergeCard');
const { WaitingOnYouReviewCard } = await import('./WaitingOnYouReviewCard');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const base = (chip: 'MERGE' | 'REVIEW', partial: Partial<ActionQueueItem> = {}): ActionQueueItem => ({
  subjectKey: `https://github.com/org/repo/pull/${chip === 'MERGE' ? 1 : 2}`, chip,
  prUrl: `https://github.com/org/repo/pull/${chip === 'MERGE' ? 1 : 2}`, prNumber: chip === 'MERGE' ? 1 : 2,
  taskId: 'task-1', taskTitle: 'A change', workspaceId: 'ws-1', workspaceName: 'acme', ...partial,
});

function buttons(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('button')];
}
function byText(label: string): HTMLElement {
  const b = buttons().find(el => el.textContent?.trim() === label);
  if (!b) throw new Error(`no button "${label}" in: ${buttons().map(el => el.textContent?.trim()).join(' | ')}`);
  return b;
}
function expectTouchTargets() {
  const all = buttons();
  expect(all.length).toBeGreaterThan(0);
  for (const b of all) {
    const cls = b.getAttribute('class') ?? '';
    // 44px below md; the desktop height may differ (the Details toggle is md:min-h-9).
    expect({ label: b.textContent?.trim(), touch: cls.split(/\s+/).includes('min-h-11') && /(^|\s)md:min-h-\d/.test(cls) })
      .toEqual({ label: b.textContent?.trim(), touch: true });
  }
}

describe('merge card on touch', () => {
  it('Merge, then Cancel and Confirm Merge, are 44px targets and the confirm row wraps', () => {
    act(() => root.render(<WaitingOnYouMergeCard item={base('MERGE')} />));
    expectTouchTargets();
    act(() => byText('Merge').click());
    expect(container.textContent).toContain('Cancel');
    expectTouchTargets();
    const strip = byText('Cancel').parentElement!.parentElement!;
    expect(strip.getAttribute('class')).toContain('flex-wrap');
  });
});

describe('review card on touch', () => {
  it('Merge and Re-review are 44px targets, and so is the merge confirm', () => {
    act(() => root.render(<WaitingOnYouReviewCard item={base('REVIEW', { escalationReason: 'Reviewer task failed — needs human review' })} />));
    expect(container.textContent).toContain('Re-review');
    expectTouchTargets();
    act(() => byText('Merge').click());
    expectTouchTargets();
    const strip = byText('Cancel').parentElement!.parentElement!;
    expect(strip.getAttribute('class')).toContain('flex-wrap');
  });

  it('Apply, Apply with corrections and Merge anyway are 44px targets', () => {
    act(() => root.render(<WaitingOnYouReviewCard item={base('REVIEW', { escalationReason: 'Touches schema.ts', recommendation: 'Guard the null-overwrite.' })} />));
    expect(container.textContent).toContain('Apply with corrections');
    expectTouchTargets();
  });
});
