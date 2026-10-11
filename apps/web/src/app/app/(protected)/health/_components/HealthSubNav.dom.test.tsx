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
