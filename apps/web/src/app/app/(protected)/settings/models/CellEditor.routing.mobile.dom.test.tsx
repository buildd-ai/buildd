/**
 * The cell editor's routing section on a phone (390px): hidden with no
 * alternatives, a truthful status line otherwise, the 1-5 dial behind an
 * opt-in Advanced disclosure. Fixtures are illustrative.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/settings/models', width: 390, height: 844 });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ModelPolicyCell } from '@buildd/shared';
import { DIAL_SETTINGS } from '@buildd/core/tier-dial';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: CellEditor } = await import('./CellEditor');
const { DIAL_DETAIL } = await import('@/lib/model-policy-cells-view');
const { CELLS, MODELS } = await import('./model-tiers-fixtures');

const writes: { url: string; method: string }[] = [];
beforeEach(() => {
  writes.length = 0;
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') writes.push({ url: String(url), method: init.method });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
});

let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ''; });
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

async function open(cell: ModelPolicyCell) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const anchor = { current: host };
  await act(async () => {
    root.render(createElement(CellEditor, {
      cell, teamId: 'team-demo', models: MODELS as never, keys: null, catalogLoading: false, suggestion: null,
      anchorRef: anchor, sheet: true, onClose: () => {}, onSaved: async () => {},
    }));
  });
  await flush();
}
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); }); };
const find = (tier: string, surface: string) => CELLS.find((c) => c.tier === tier && c.surface === surface)!;
const status = () => q('[data-testid="cell-routing-status"]')!.textContent;

describe('CellEditor routing, phone', () => {
  it('no alternatives: no dial, no routing section, plain explanation', async () => {
    await open({ ...find('standard', 'agent'), alternates: [], state: 'always', whatRan: [] });
    expect(q('[data-testid="cell-routing"]')).toBeNull();
    expect(q('[data-testid="cell-advanced-toggle"]')).toBeNull();
    expect(q('[data-testid="cell-dial-3"]')).toBeNull();
    expect(q('[data-testid="cell-learning"]')!.textContent).toBe('Every run uses the primary.');
    expect(q('[data-testid="cell-editor"]')!.textContent).not.toContain('Quality');
  });

  it('one alternate, learning: shadow status, dial hidden until Advanced opens and closes', async () => {
    await open(find('premium', 'agent'));
    expect(status()).toBe('Evaluating alternatives: the primary still handles all work.');
    expect(q('[data-testid="cell-dial-3"]')).toBeNull();
    const toggle = q('[data-testid="cell-advanced-toggle"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(q('[data-testid="cell-advanced"]')!.textContent).toContain('shadow');
    expect(q('[data-testid="cell-advanced"]')!.textContent).toContain('live');
    await click(toggle);
    expect(q('[data-testid="cell-advanced"]')).toBeNull();
  });

  it('chat without quality feedback never claims quality routing', async () => {
    await open(find('premium', 'chat'));
    expect(status()).toBe('Quality feedback unavailable: automatic switching paused.');
    await click(q('[data-testid="cell-advanced-toggle"]'));
    expect(q('[data-testid="cell-advanced"]')!.textContent).toContain('nothing switches on quality');
  });

  it('shifted and reverted say what is actually happening', async () => {
    await open(find('standard', 'agent'));
    expect(status()).toBe('Using deepseek/deepseek-v4-pro on 50% of eligible work.');
    act(() => root.unmount()); document.body.innerHTML = '';
    await open(find('budget', 'agent'));
    expect(status()).toBe('Back on the primary: qwen/qwen3-coder slipped.');
  });

  it('shows the saved dial in Advanced and saving it changes nothing else', async () => {
    await open({ ...find('premium', 'agent'), dial: 4 });
    await click(q('[data-testid="cell-advanced-toggle"]'));
    expect(q('[data-testid="cell-dial-4"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-testid="cell-dial-detail"]')!.textContent).toBe(DIAL_DETAIL[4]);
    expect((q('[data-testid="cell-save"]') as HTMLButtonElement).disabled).toBe(true);
    await click(q('[data-testid="cell-dial-2"]'));
    expect(q('[data-testid="cell-dial-detail"]')!.textContent).toContain('Not saved yet.');
    expect(writes).toEqual([]);
  });

  it('dial wording matches the policy table', () => {
    for (const d of [2, 3, 4, 5] as const) {
      expect(DIAL_DETAIL[d]).toContain(`${Math.round(DIAL_SETTINGS[d].margin * 100)} points`);
      if (DIAL_SETTINGS[d].maxShare < 1) expect(DIAL_DETAIL[d]).toContain(`${DIAL_SETTINGS[d].maxShare * 100}%`);
    }
  });
});
