/**
 * Model tiers on a phone (390px): a stacked card per tier, one line per
 * surface, and the cell editor as a bottom sheet. Fixtures are illustrative.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 390, height: 844 });

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
const { CELLS_BODY, MODELS, POOLS_BODY } = await import('./model-tiers-fixtures');

beforeEach(() => {
  globalThis.fetch = mock(async (url: string) => {
    const u = String(url);
    if (u.startsWith('/api/model-tiers/cells')) return new Response(JSON.stringify(CELLS_BODY), { status: 200 });
    if (u.startsWith('/api/model-tiers/pools')) return new Response(JSON.stringify(POOLS_BODY), { status: 200 });
    if (u.startsWith('/api/models')) return new Response(JSON.stringify({ models: MODELS, catalogComplete: true }), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; });

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe('ModelTiersClient on a phone', () => {
  it('stacks a card per tier with Coding and Chat lines, alternates before the state', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root.render(<ModelTiersClient teamId="team-demo" teamName="Demo" isAdmin />); });
    await flush();
    await flush();

    expect(document.querySelector('[data-testid="tier-table"]')).toBeNull();
    const card = document.querySelector('[data-testid="tier-card-standard"]')!;
    expect(card.textContent).toContain('standard');
    const coding = card.querySelector('[data-testid="cell-agent-standard"]')!;
    expect(coding.textContent).toContain('Coding');
    expect(coding.querySelector('[data-testid="cell-state"]')!.textContent).toBe('deepseek/deepseek-v4-pro matches · 50% there');
    expect(document.querySelector('[data-testid="cell-agent-premium"] [data-testid="cell-state"]')!.textContent).toBe('+ claude-sonnet-5 · learning 12 of 40');
    expect(card.querySelector('[data-testid="cell-chat-standard"]')!.textContent).toContain('Chat');

    await act(async () => { (coding as HTMLElement).click(); });
    await flush();
    const sheet = document.querySelector('[data-testid="cell-editor-sheet"]')!;
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.getAttribute('aria-label')).toBe('standard · Coding');
    expect(document.querySelector('[data-testid="cell-editor-panel"]')).toBeNull();
  });
});
