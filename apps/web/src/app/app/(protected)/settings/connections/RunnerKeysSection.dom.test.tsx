/**
 * Settings → Connected apps → Runners, mounted (happy-dom): Disconnect on a
 * runner and Remove on another team's runner ask first, with the same inline
 * confirm the app rows use. One tap sends nothing; Keep it backs out; the
 * confirm sends the DELETE and drops the row.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/connections' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: RunnerKeysSection } = await import('./RunnerKeysSection');
type Key = import('@/lib/runner-picks').RunnerKeySummary;
type Foreign = import('@/lib/runner-picks').ForeignRunner;

const key: Key = {
  id: 'acct-1', name: 'Laptop runner', apiKeyPrefix: 'bld_abcd', level: 'worker', homeTeamName: 'Team One',
  createdAt: null, lastUsedAt: null, picks: null,
};
const foreign: Foreign = {
  accountId: 'acct-9', accountName: 'Build box', ownerName: 'A. Person', homeTeamName: 'Team Two',
  workspaceId: 'ws-1', workspaceName: 'web', teamName: 'Team One',
};

let calls: Array<{ url: string; method?: string }> = [];
const realFetch = globalThis.fetch;
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

async function mount() {
  await act(async () => { root.render(createElement(RunnerKeysSection, { keys: [key], foreign: [foreign] })); });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const all = (id: string) => [...container.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
const click = async (el: Element | null) => {
  if (!el) throw new Error('missing element');
  await act(async () => { (el as HTMLElement).click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const button = (text: string, scope: ParentNode = container) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) ?? null;

describe('RunnerKeysSection: Disconnect', () => {
  it('one tap asks first and sends nothing', async () => {
    await mount();
    await click(q('runner-key-disconnect'));
    expect(calls).toEqual([]);
    const confirm = q('runner-key-disconnect-confirm');
    expect(confirm).not.toBeNull();
    expect(confirm!.textContent).toContain('Disconnect Laptop runner?');
    expect(confirm!.textContent).toContain('buildd login');
    expect(button('Keep it', confirm!)).not.toBeNull();
  });

  it('Keep it backs out without a request', async () => {
    await mount();
    await click(q('runner-key-disconnect'));
    await click(button('Keep it', q('runner-key-disconnect-confirm')!));
    expect(calls).toEqual([]);
    expect(q('runner-key-disconnect-confirm')).toBeNull();
    expect(all('runner-key-row').length).toBe(1);
  });

  it('the confirm sends the DELETE and drops the row', async () => {
    await mount();
    await click(q('runner-key-disconnect'));
    await click(q('runner-key-disconnect-yes'));
    expect(calls).toEqual([{ url: '/api/accounts/acct-1', method: 'DELETE' }]);
    expect(all('runner-key-row').length).toBe(0);
  });
});

describe('RunnerKeysSection: Remove a runner from another team', () => {
  it('one tap asks first and sends nothing', async () => {
    await mount();
    await click(q('foreign-runner-remove'));
    expect(calls).toEqual([]);
    const confirm = q('foreign-runner-remove-confirm');
    expect(confirm).not.toBeNull();
    expect(confirm!.textContent).toContain('Remove Build box from web?');
    expect(button('Keep it', confirm!)).not.toBeNull();
  });

  it('the confirm sends the DELETE and drops the row', async () => {
    await mount();
    await click(q('foreign-runner-remove'));
    await click(q('foreign-runner-remove-yes'));
    expect(calls).toEqual([{ url: '/api/workspaces/ws-1/accounts?accountId=acct-9', method: 'DELETE' }]);
    expect(all('foreign-runner-row').length).toBe(0);
  });
});
