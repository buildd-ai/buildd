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

describe('History and What ran on a phone', () => {
  const events = [
    { id: 'e1', kind: 'suggestion', at: '2026-10-09T09:00:00Z', actor: 'system:succession', after: { model: 'claude-sonnet-6' }, reason: 'successor available' },
    { id: 'e2', kind: 'allocation', at: '2026-10-09T08:00:00Z', actor: 'system', after: { a: 0.9 }, reason: null },
    { id: 'e3', kind: 'allocation', at: '2026-10-09T07:00:00Z', actor: 'system', after: { a: 0.8 }, reason: null },
    { id: 'e4', kind: 'mode', at: '2026-10-08T07:00:00Z', actor: 'admin', after: { mode: 'pinned' }, reason: null },
  ];
  const mountWith = async () => {
    globalThis.fetch = mock(async (url: string) => {
      const u = String(url);
      if (u.startsWith('/api/model-tiers/cells')) return new Response(JSON.stringify(CELLS_BODY), { status: 200 });
      if (u.startsWith('/api/model-tiers/pools/')) return new Response(JSON.stringify({ changes: u.includes('pool-std') ? events : [] }), { status: 200 });
      if (u.startsWith('/api/model-tiers/pools')) return new Response(JSON.stringify(POOLS_BODY), { status: 200 });
      if (u.startsWith('/api/models')) return new Response(JSON.stringify({ models: MODELS, catalogComplete: true }), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root.render(<ModelTiersClient teamId="team-demo" teamName="Demo" isAdmin />); });
    await flush(); await flush();
  };

  it('groups History by day in plain words, folds low-level events, keeps raw detail', async () => {
    await mountWith();
    await act(async () => { (document.querySelector('[data-testid="tiers-history"]') as HTMLElement).click(); });
    await flush(); await flush();
    const days = document.querySelectorAll('[data-testid="history-day"]');
    expect(days.length).toBe(2);
    const text = document.querySelector('[data-testid="history-changes"]')!.textContent!;
    expect(text).toContain('Model recommendation updated');
    expect(text).toContain('suggestion only, traffic unchanged');
    expect(text).toContain('Returned to the selected model');
    expect(text).toContain('Traffic split adjusted automatically (2 updates)');
    // raw actor and reason stay in the disclosure
    const detail = document.querySelector('[data-testid="history-detail"]')!;
    expect(detail.textContent).toContain('system:succession');
    expect(detail.textContent).toContain('successor available');
    expect(document.querySelectorAll('[data-testid="history-detail-item"]').length).toBe(4);
  });

  it('What ran names the denominator and shows task titles, not model ids as links', async () => {
    await mountWith();
    await act(async () => { (document.querySelector('[data-testid="tier-name-standard"]') as HTMLElement).click(); });
    await flush();
    const sheet = document.querySelector('[data-testid="what-ran-sheet"]')!;
    expect(sheet.textContent).toContain('Share of 50 runs in the last 30 days');
    expect(sheet.querySelector('[data-testid="what-ran-recent"] a')!.textContent).toBe('Fix flaky date test');
  });
});

describe('tier maximum on the tier cards', () => {
  async function mountWith(max: { agent: string | null; chat: string | null } | 'fail') {
    const base = globalThis.fetch;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/model-ceilings')) {
        if (max === 'fail') return new Response('{"error":"nope"}', { status: 500 });
        return Response.json({ effective: { agent: { max: max.agent }, chat: { max: max.chat } } });
      }
      return base(url, init);
    }) as unknown as typeof fetch;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root.render(<ModelTiersClient teamId="team-demo" teamName="Demo" isAdmin />); });
    await flush(); await flush();
  }
  const note = (tier: string) => document.querySelector(`[data-testid="tier-blocked-${tier}"]`);

  it('marks premium-plus as set-but-not-served under a Premium maximum; the card stays visible', async () => {
    await mountWith({ agent: 'premium', chat: 'premium' });
    expect(note('premium-plus')!.textContent).toContain('Can be set, not served');
    expect(document.querySelector('[data-testid="tier-card-premium-plus"]')).not.toBeNull();
    expect(note('premium')).toBeNull();
    expect(note('standard')).toBeNull();
  });

  it('names the surface when only one is limited', async () => {
    await mountWith({ agent: 'standard', chat: null });
    expect(note('premium')!.textContent).toContain('for Coding');
  });

  it('shows no marks when there is no limit or the read model fails', async () => {
    await mountWith({ agent: null, chat: null });
    expect(document.querySelector('[data-testid^="tier-blocked-"]')).toBeNull();
    act(() => root.unmount()); host.remove();
    await mountWith('fail');
    expect(document.querySelector('[data-testid^="tier-blocked-"]')).toBeNull();
  });
});
