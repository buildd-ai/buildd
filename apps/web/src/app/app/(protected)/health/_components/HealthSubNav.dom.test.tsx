import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/health/insights' });
import { expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  usePathname: () => '/app/health/insights',
  useSearchParams: () => new URLSearchParams(),
}));

it('scrolls the active mobile tab into view, centred horizontally', async () => {
  const { default: HealthSubNav } = await import('./HealthSubNav');
  const calls: Array<{ text: string | null; opts: unknown }> = [];
  Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) {
    calls.push({ text: this.textContent, opts });
  } as typeof Element.prototype.scrollIntoView;
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  try {
    act(() => root.render(<HealthSubNav viewer={{ operator: true, teamAdmin: true }} />));
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe('Insights');
    expect(calls[0].opts).toEqual({ inline: 'center', block: 'nearest' });
  } finally {
    act(() => root.unmount());
  }
});

it('R-1: Queue carries the waiting count its read published, beside the label', async () => {
  const { default: HealthSubNav } = await import('./HealthSubNav');
  const { publishQueueWaitingCount, resetQueueWaitingCount } = await import('@/lib/health-queue-count');
  Element.prototype.scrollIntoView = (() => {}) as typeof Element.prototype.scrollIntoView;
  publishQueueWaitingCount(9, null);
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  try {
    act(() => root.render(<HealthSubNav viewer={{ operator: false, teamAdmin: false }} />));
    const counts = [...el.querySelectorAll('[data-testid="health-queue-count"]')].map(n => n.textContent);
    // Desktop list and phone strip both show it.
    expect(counts).toEqual(['9', '9']);
    expect(el.querySelector('[data-testid="health-queue-count"]')!.parentElement!.textContent).toBe('Queue 9');
  } finally {
    act(() => root.unmount());
    resetQueueWaitingCount();
  }
});

it('Queue shows no count when nothing waits, and the phone tab separates label from count', async () => {
  const { default: HealthSubNav } = await import('./HealthSubNav');
  const { publishQueueWaitingCount, resetQueueWaitingCount } = await import('@/lib/health-queue-count');
  Element.prototype.scrollIntoView = (() => {}) as typeof Element.prototype.scrollIntoView;
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  try {
    publishQueueWaitingCount(0, null);
    act(() => root.render(<HealthSubNav viewer={{ operator: false, teamAdmin: false }} />));
    expect(el.querySelectorAll('[data-testid="health-queue-count"]')).toHaveLength(0);
    act(() => publishQueueWaitingCount(3, null));
    const tab = el.querySelector('[data-testid="health-subnav-mobile"] [data-testid="health-queue-count"]')!.parentElement!;
    // Flex drops the literal space, so the gap must come from the class.
    expect(tab.className).toContain('gap-1.5');
  } finally {
    act(() => root.unmount());
    resetQueueWaitingCount();
  }
});
