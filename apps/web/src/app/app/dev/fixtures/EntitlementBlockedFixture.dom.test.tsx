/**
 * The entitlement fixture's integrated task panels: a queued task with a block
 * shows the notice in place of Run now; the same task without one (the
 * self-hosted shape) shows Run now and no notice or upsell.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/dev/fixtures' });

import { afterAll, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: EntitlementBlockedFixture } = await import('./EntitlementBlockedFixture');

describe('EntitlementBlockedFixture task panels', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  afterAll(() => act(() => root.unmount()));

  it('shows the notice only on the blocked task, and no upsell on the unblocked one', async () => {
    await act(async () => { root.render(<EntitlementBlockedFixture />); });
    const panel = (label: string) =>
      [...container.querySelectorAll('[data-testid="entitlement-fixture"]')].find(p => p.getAttribute('data-state-label')?.startsWith(label))!;
    const blocked = panel('Task sheet/page, queued on a plan limit');
    const free = panel('Task sheet/page, queued, no block');
    expect(blocked.querySelector('[data-testid="entitlement-blocked"]')).not.toBeNull();
    expect(free.querySelector('[data-testid="entitlement-blocked"]')).toBeNull();
    expect(free.querySelector('[data-testid="entitlement-upgrade"]')).toBeNull();
    expect(free.querySelector('[data-actions~="run_now"]')).not.toBeNull();
  });
});
