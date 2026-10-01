import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/runners', width: 1280, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
mock.module('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: RunnerTokensSection } = await import('./RunnerTokensSection');

const account = {
  id: 'fixture-token', name: 'Analytics client', type: 'service', authType: 'api',
  apiKeyPrefix: 'bld_fixture', maxConcurrentWorkers: 1, totalTasks: 0, totalCost: '0',
  activeSessions: null, maxConcurrentSessions: null, budgetExhaustedAt: null,
  budgetResetsAt: null, team: null,
};

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(overrides: Record<string, unknown>) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<RunnerTokensSection accounts={[{ ...account, ...overrides }]} />); });
  await act(async () => { host.querySelector<HTMLElement>('[data-testid="token-group"] button')!.click(); });
}

async function expandToken() {
  const row = [...host.querySelectorAll<HTMLElement>('[data-testid="token-group"] button')].find((b) => b.textContent?.includes('Analytics client'))!;
  await act(async () => { row.click(); });
}

describe('RunnerTokensSection token details', () => {
  it('flags an expired token in the compact row and an unused one in the detail', async () => {
    await mount({ expiresAt: '2000-01-01T00:00:00Z' });
    expect(host.textContent).toContain('Expired');
    await expandToken();
    expect(host.textContent).toContain('Never used');
  });

  it('shows last-used time in the detail', async () => {
    const usedAt = new Date('2026-01-15T12:00:00Z');
    await mount({ lastUsedAt: usedAt });
    await expandToken();
    expect(host.textContent).toContain(`Last used: ${usedAt.toLocaleString()}`);
  });

  it('keeps capability detail out of the compact token row', async () => {
    await mount({ scopes: ['analytics:read'] });
    expect(host.textContent).toContain('Analytics client');
    expect(host.textContent).not.toContain('Capabilities');
    await expandToken();
    expect(host.textContent).toContain('Capabilities');
  });
});
