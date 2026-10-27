import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/health/queue' });
import { expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  usePathname: () => '/app/health/overview',
  useSearchParams: () => new URLSearchParams('workspace=ws 1'),
}));

it('shows the waiting count beside Queue on phone and desktop, scoped by workspace', async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (u: string) => {
    urls.push(u);
    return { ok: true, json: async () => ({ tiles: { waiting: 7 } }) };
  }) as unknown as typeof fetch;
  Element.prototype.scrollIntoView = (() => {}) as typeof Element.prototype.scrollIntoView;
  const { default: HealthSubNav } = await import('./HealthSubNav');
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  try {
    await act(async () => { root.render(<HealthSubNav viewer={{ operator: false, teamAdmin: false }} />); });
    expect(urls).toEqual(['/api/health/queue?workspace=ws%201']);
    const counts = [...el.querySelectorAll('[data-testid="queue-tab-count"]')];
    expect(counts.map(c => c.textContent)).toEqual(['7', '7']);
    expect(el.querySelector('[data-testid="health-subnav"]')!.textContent).toContain('Queue7');
    expect(el.querySelector('[data-testid="health-subnav-mobile"]')!.textContent).toContain('Queue7');
  } finally {
    act(() => root.unmount());
  }
});
