import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/runners', width: 1280, height: 800 });

import { afterEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
mock.module('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));

const mockFetch = mock(async () => ({
  ok: true,
  json: async () => ({ maxConcurrentWorkers: 5 }),
}));
globalThis.fetch = mockFetch as any;

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

  it('shows maxConcurrentWorkers in the detail', async () => {
    await mount({ maxConcurrentWorkers: 7 });
    await expandToken();
    expect(host.textContent).toContain('Workers: 7');
  });

  it('shows maxConcurrentWorkers as editable when canManageHostRunner is true', async () => {
    await mount({ maxConcurrentWorkers: 3, canManageHostRunner: true });
    await expandToken();

    expect(host.textContent).toContain('Workers: 3');

    // Verify the Workers display is clickable (cursor-pointer class applied)
    const workersSpan = [...host.querySelectorAll('span')].find((s) => s.textContent?.includes('Workers: 3'));
    expect(workersSpan).toBeTruthy();
    expect((workersSpan as HTMLElement).className).toContain('cursor-pointer');

    // Click on the Workers display to enter edit mode
    await act(async () => {
      workersSpan?.click();
    });

    // Verify the input field is now present
    const input = host.querySelector<HTMLInputElement>('input[type="number"]');
    expect(input).toBeTruthy();
    expect(input?.value).toBe('3');
    expect(input?.min).toBe('1');
    expect(input?.max).toBe('50');
  });

  it('does not allow editing maxConcurrentWorkers when canManageHostRunner is false', async () => {
    await mount({ maxConcurrentWorkers: 3, canManageHostRunner: false });
    await expandToken();

    const workersSpan = [...host.querySelectorAll('span')].find((s) => s.textContent?.startsWith('Workers: 3'));
    expect(workersSpan).toBeTruthy();

    await act(async () => {
      workersSpan?.click();
    });

    // Verify the input field is NOT present
    const input = host.querySelector<HTMLInputElement>('input[type="number"]');
    expect(input).toBeFalsy();
  });
});
