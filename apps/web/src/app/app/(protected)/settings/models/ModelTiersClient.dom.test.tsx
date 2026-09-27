/**
 * Model tiers, mounted in happy-dom with a stubbed fetch. Fixtures are illustrative.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  usePathname: () => '/app/settings/models',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ModelTiersClient } = await import('./ModelTiersClient');

const TIERS = {
  'premium-plus': { provider: 'anthropic', model: 'claude-opus-5', source: 'catalog' },
  premium: { provider: 'anthropic', model: 'claude-opus-5', source: 'catalog' },
  standard: { provider: 'anthropic', model: 'claude-sonnet-4-6', source: 'team' },
  budget: { provider: 'openai-codex', model: 'gpt-mini', source: 'team' },
};

const posts: unknown[] = [];
beforeEach(() => {
  posts.length = 0;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    }
    if (String(url).startsWith('/api/model-tiers')) return new Response(JSON.stringify(TIERS), { status: 200 });
    if (String(url).startsWith('/api/models')) {
      return new Response(JSON.stringify({
        models: [], catalogComplete: true,
        tierAudit: { checked: true, unknown: [], superseded: [{ tier: 'standard', model: 'claude-sonnet-4-6', newer: 'claude-sonnet-5' }] },
      }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(isAdmin = true) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<ModelTiersClient teamId="team-demo" teamName="Example" isAdmin={isAdmin} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('ModelTiersClient', () => {
  it('drops the explanatory paragraphs and the unbuilt suggestions block', async () => {
    await mount();
    const text = host.textContent ?? '';
    expect(text).not.toContain('Pinned tiers stay where you put them');
    expect(text).not.toContain('A suggestion never changes');
    expect(text).not.toContain('Evidence-based suggestions');
    expect(text).not.toContain('read-only');
  });

  it('says on each row which surfaces can use it', async () => {
    await mount();
    const usedBy = (tier: string) => host.querySelector(`[data-testid="tier-row-${tier}"] [data-testid="tier-used-by"]`)?.textContent;
    expect(usedBy('standard')).toBe('agent runs, chat');
    expect(usedBy('budget')).toBe('agent runs only');
  });

  it('puts a newer catalog release on its row as a Switch action', async () => {
    await mount();
    const row = host.querySelector('[data-testid="tier-row-standard"]')!;
    expect(row.querySelector('[data-testid="tier-suggestion"]')?.textContent).toContain('claude-sonnet-5 is newer');
    const sw = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Switch')!;
    await act(async () => { sw.click(); });
    expect(posts).toEqual([{ tier: 'standard', provider: 'anthropic', model: 'claude-sonnet-5', teamId: 'team-demo' }]);
  });

  it('shows Apply only after a change', async () => {
    await mount();
    const row = host.querySelector('[data-testid="tier-row-premium"]')!;
    expect(Array.from(row.querySelectorAll('button')).some((b) => b.textContent === 'Apply')).toBe(false);
  });

  it('gives members the table without controls', async () => {
    await mount(false);
    const row = host.querySelector('[data-testid="tier-row-standard"]')!;
    expect((row.querySelector('[role="combobox"][aria-label="Provider for standard"]') as HTMLButtonElement).disabled).toBe(true);
    expect((row.querySelector('input[role="combobox"]') as HTMLInputElement).disabled).toBe(true);
    expect(Array.from(row.querySelectorAll('button')).some((b) => b.textContent === 'Switch')).toBe(false);
  });
});
