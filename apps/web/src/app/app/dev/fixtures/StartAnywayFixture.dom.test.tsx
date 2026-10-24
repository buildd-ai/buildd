/**
 * The Start anyway fixture shows each state the surface audit could not reach:
 * the offer, its confirmation, requested, assessing, and parked on the named
 * prerequisite.
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
const { default: StartAnywayFixture } = await import('./StartAnywayFixture');

describe('StartAnywayFixture', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  afterAll(() => act(() => root.unmount()));

  it('renders the offer, the confirmation and the three observed phases', async () => {
    await act(async () => { root.render(<StartAnywayFixture />); await new Promise(r => setTimeout(r, 20)); });
    const panel = (label: string) =>
      [...container.querySelectorAll('[data-testid="start-anyway-fixture"]')].find(p => p.getAttribute('data-state-label')?.startsWith(label))!;
    expect(panel('Blocked, pending').querySelector('[data-action="force_start_offer"]')?.textContent).toBe('Start anyway…');
    expect(panel('Start anyway confirmation').textContent).toContain('Start “Add the API” anyway?');
    expect(panel('Start requested').querySelector('[data-phase="requested"]')).not.toBeNull();
    expect(panel('Assessing').querySelector('[data-phase="assessing"]')).not.toBeNull();
    const parked = panel('Parked').querySelector('[data-phase="blocked"]');
    expect(parked?.textContent).toContain('Build the schema');
  });
});
