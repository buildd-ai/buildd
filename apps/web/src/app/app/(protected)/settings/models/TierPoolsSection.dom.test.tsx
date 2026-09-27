/**
 * The tier pools tables, mounted in happy-dom with a stubbed fetch. Fixtures
 * are illustrative.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 1280, height: 800 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TierPoolsSection } = await import('./TierPoolsSection');
const { summarizeArm } = await import('@buildd/core/tier-pool');

const stats = summarizeArm([
  ...Array.from({ length: 40 }, () => ({ severity: 'none' as const, costUsd: 0.018, latencyMs: 900 })),
  ...Array.from({ length: 10 }, () => ({ severity: 'minor' as const, costUsd: 0.018, latencyMs: 900 })),
]);
const rows = [
  { tier: 'standard', surface: 'chat', poolId: 'pool-1', mode: 'split', locked: false, allocationVersion: 4, incumbentFloor: 0.6, explorationCap: 0.3, minGraded: 50, lastChange: null,
    arms: [
      { id: 'inc', route: 'anthropic', model: 'claude-sonnet-5', role: 'incumbent', status: 'active', share: 0.8, stats },
      { id: 'ch', route: 'openrouter', model: 'qwen/qwen3-coder', role: 'challenger', status: 'active', share: 0.2, stats: null },
    ] },
  { tier: 'premium-plus', surface: 'agent', poolId: null, mode: 'pinned', locked: true, allocationVersion: null, incumbentFloor: 0.6, explorationCap: 0.3, minGraded: 30, lastChange: null,
    arms: [{ id: null, route: 'runner:claude', model: 'claude-fable-5-1', role: 'incumbent', status: 'active', share: 1, stats: null }] },
  { tier: 'budget', surface: 'agent', poolId: null, mode: 'pinned', locked: false, allocationVersion: null, incumbentFloor: 0.6, explorationCap: 0.3, minGraded: 30, lastChange: null,
    arms: [{ id: null, route: 'runner:claude', model: 'claude-haiku-4-5', role: 'incumbent', status: 'active', share: 1, stats: null }] },
];

const requests: Array<{ url: string; method: string; body: any }> = [];
beforeEach(() => {
  requests.length = 0;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method !== 'GET') return new Response('{"ok":true}', { status: 200 });
    if (String(url).startsWith('/api/model-tiers/pools/')) return new Response(JSON.stringify({ changes: [] }), { status: 200 });
    return new Response(JSON.stringify({ rows, isAdmin: true }), { status: 200 });
  }) as unknown as typeof fetch;
});

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(isAdmin = true) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const models = [
    { id: 'claude-opus-5', displayName: 'Opus', provider: 'anthropic', inputPrice: 5, outputPrice: 25 },
    { id: 'claude-haiku-4-5', displayName: 'Haiku', provider: 'anthropic', inputPrice: 1, outputPrice: 5 },
  ];
  await act(async () => { root.render(<TierPoolsSection teamId="team-demo" isAdmin={isAdmin} models={models} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

describe('TierPoolsSection', () => {
  it('shows each arm with its route, traffic, win rate and cost, base first', async () => {
    await mount();
    const row = host.querySelector('[data-testid="pool-row-chat-standard"]')!;
    const arms = [...row.querySelectorAll('[data-testid="pool-arm"]')];
    expect(arms.map(a => a.getAttribute('data-role'))).toEqual(['incumbent', 'challenger']);
    expect(arms[0].textContent).toContain('claude-sonnet-5');
    expect(arms[0].textContent).toContain('base');
    expect(arms[0].querySelector('[data-testid="pool-share"]')!.textContent).toBe('80%');
    expect(arms[0].querySelector('[data-testid="pool-win"]')!.textContent).toBe('80%');
    expect(arms[0].querySelector('[data-testid="pool-cost"]')!.textContent).toBe('$18');
    expect(arms[1].querySelector('[data-testid="pool-win"]')!.textContent).toBe('–');
    expect(row.querySelector('[data-testid="pool-mode"]')!.textContent).toBe('split');
  });

  it('premium-plus is pinned with no way to add a model', async () => {
    await mount();
    const row = host.querySelector('[data-testid="pool-row-agent-premium-plus"]')!;
    expect(row.textContent).toContain('no explore');
    expect(row.querySelector('[data-testid="pool-add-toggle"]')).toBeNull();
  });

  it('runner arms label their cost as virtual', async () => {
    const withCost = { ...rows[2], arms: [{ ...rows[2].arms[0], stats }] };
    const saved = rows[2];
    rows[2] = withCost as never;
    await mount();
    expect(host.querySelector('[data-testid="pool-row-agent-budget"] [data-testid="pool-cost"]')!.textContent).toContain('virtual');
    rows[2] = saved;
  });

  it('adds a model from the picker on the agent route', async () => {
    await mount();
    await click(host.querySelector('[data-testid="pool-row-agent-budget"] [data-testid="pool-add-toggle"]'));
    // The base model is already in the tier, so it is not offered.
    expect(host.querySelector('[data-testid="pool-add"]')!.textContent).not.toContain('claude-haiku-4-5');
    const add = [...host.querySelectorAll('[data-testid="pool-add"] button')].find(b => b.textContent === 'Add');
    await click(add);
    const post = requests.find(r => r.method === 'POST')!;
    expect(post.body).toEqual({ teamId: 'team-demo', tier: 'budget', surface: 'agent', route: 'runner:claude', model: 'claude-opus-5' });
  });

  it('applies typed shares as a split with the version it loaded', async () => {
    await mount();
    await click(host.querySelector('[data-testid="pool-row-chat-standard"] [data-testid="pool-details-toggle"]'));
    const inputs = [...host.querySelectorAll('[data-testid="pool-share-input"]')] as HTMLInputElement[];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(inputs[0], '70'); inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(inputs[1], '30'); inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(host.querySelector('[data-testid="pool-apply"]'));
    const patch = requests.find(r => r.method === 'PATCH')!;
    expect(patch.url).toBe('/api/model-tiers/pools/pool-1');
    expect(patch.body).toEqual({ teamId: 'team-demo', expectedVersion: 4, mode: 'split', allocation: { inc: 0.7, ch: 0.3 } });
  });

  it('pins to the base', async () => {
    await mount();
    await click(host.querySelector('[data-testid="pool-row-chat-standard"] [data-testid="pool-details-toggle"]'));
    await click(host.querySelector('[data-testid="pool-pin"]'));
    expect(requests.find(r => r.method === 'PATCH')!.body).toEqual({ teamId: 'team-demo', expectedVersion: 4, mode: 'pinned' });
  });

  it('members see the numbers without controls', async () => {
    await mount(false);
    expect(host.querySelector('[data-testid="pool-add-toggle"]')).toBeNull();
    await click(host.querySelector('[data-testid="pool-details-toggle"]'));
    expect(host.querySelector('[data-testid="pool-pin"]')).toBeNull();
    expect((host.querySelector('[data-testid="pool-share-input"]') as HTMLInputElement).disabled).toBe(true);
  });
});
